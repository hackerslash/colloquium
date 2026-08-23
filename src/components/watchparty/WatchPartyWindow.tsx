import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AudioLines,
  Crown,
  Disc3,
  Film,
  LogOut,
  Maximize,
  Maximize2,
  Mic,
  MicOff,
  Minimize,
  Minimize2,
  Minus,
  Move,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Subtitles,
  Users,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useWatchPartyStore, selfIsController } from "../../stores/useWatchPartyStore";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { useRosterStore } from "../../stores/useRosterStore";
import { useRoomCallStore } from "../../stores/useRoomCallStore";
import * as player from "../../services/watchparty/watchPartyPlayer";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Tooltip } from "../ui/Tooltip";
import {
  ChromeButton,
  ChromeChip,
  ChromeTextButton,
  PlayerMenu,
  type MenuItem,
} from "./PlayerChrome";
import { PresenceRail } from "./PresenceRail";
import { Scrubber } from "./Scrubber";
import { VideoTile } from "../call/VideoTile";
import { tileColumn, tileGrid, tileTracks } from "../call/tileGrid";
import { hasLiveVideo } from "../../lib/mediaTracks";
import { enterFullscreen, exitFullscreen } from "../../lib/fullscreen";
import { formatClock } from "../../lib/time";
import { cx } from "../../lib/cx";
import { useDraggable } from "../../hooks/useDraggable";
import { youtubeId } from "../../services/watchparty/youtube";

/** How long the pointer must rest before the chrome gets out of the way. */
const IDLE_MS = 2_600;
/** Long enough to tell a click from the first half of a double click. Short
 * enough that click-to-pause doesn't feel laggy. */
const DOUBLE_CLICK_MS = 220;
const SKIP_SEC = 10;
const ARROW_SEC = 5;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** Who the gated start is still waiting on, and each peer's lead — otherwise it
 * is indistinguishable from the app having ignored the play button. */
function PrimingOverlay() {
  const waitingFor = useWatchPartyStore((s) => s.waitingFor);
  const members = useWatchPartyStore((s) => s.members);
  const startAnyway = useWatchPartyStore((s) => s.startAnyway);
  const self = useIdentityStore((s) => s.self);
  const contactsById = useRosterStore((s) => s.contactsById);

  const slowest = members
    .filter((m) => waitingFor.includes(m.id))
    .sort((a, b) => a.bufferedSec - b.bufferedSec);

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/45 px-10 text-center">
      <span
        className="h-9 w-9 animate-spin rounded-full border-2 border-white/25 border-t-accent motion-reduce:animate-none"
        aria-hidden="true"
      />
      <p className="text-sm font-medium text-white">Getting everyone a head start on the film</p>
      <ul className="flex flex-col gap-1 text-xs text-white/55">
        {slowest.map((m) => (
          <li key={m.id}>
            {m.id === self?.identityId ? "You" : (contactsById[m.id]?.displayName ?? "Guest")} —{" "}
            {Math.round(m.bufferedSec)}s of {Math.round(m.needSec)}s ready
          </li>
        ))}
      </ul>
      {selfIsController() && (
        <ChromeTextButton onClick={startAnyway}>Start anyway</ChromeTextButton>
      )}
    </div>
  );
}

/** How far the player is grown, and cropped back, top and bottom. `controls=0`
 * takes YouTube's transport away but not the row it keeps beside it — "More
 * videos", the speed, the logo, fullscreen — nor the title bar at the top. Both
 * are pinned to the player's own edges, so a taller player with its edges
 * outside the box takes them out of sight. What is cropped is the letterbox the
 * extra height creates, not the picture: the video is sized to the width of a
 * 16:9 box, and stays that size however tall the player around it is.
 *
 * ponytail: true for 16:9 sources, which is nearly all of YouTube. A portrait
 * video is sized by height instead and does lose its top and bottom to this —
 * crop only the bottom, and wear the title bar, if that ever matters. */
const PLAYER_CROP_PX = 96;

/** YouTube's iframe player: the picture on the stage, and in audio mode the
 * sound behind the record. Hidden by opacity rather than by unmounting or by
 * display:none — an iframe reloads when it moves, and a zero-size or undisplayed
 * player is one browsers are entitled to stop. */
function YouTubePlayer({
  visible,
  onStageClick,
}: {
  visible: boolean;
  onStageClick: (e: React.MouseEvent) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    player.attachYouTube(hostRef.current);
    return () => player.attachYouTube(null);
  }, []);
  return (
    <div
      aria-hidden={!visible}
      className={cx(
        "pointer-events-none absolute inset-0 flex items-center justify-center",
        !visible && "opacity-0",
      )}
    >
      <div className="relative aspect-video max-h-full w-full max-w-full overflow-hidden">
        <div
          ref={hostRef}
          className="absolute inset-x-0 [&>iframe]:h-full [&>iframe]:w-full"
          style={{ top: -PLAYER_CROP_PX, bottom: -PLAYER_CROP_PX }}
        />
        {/* The player must never see a pointer: hovering it is what summons the
            chrome, and `pointer-events: none` on the iframe did not hold. This
            takes the clicks instead and gives them to the stage, which is where
            play, pause and fullscreen already live. */}
        {visible && <div className="pointer-events-auto absolute inset-0" onClick={onStageClick} />}
      </div>
    </div>
  );
}

/**
 * The film. Everything drawn here sits on black in both themes, so its text is
 * light-on-dark rather than token-themed — `text-text-primary` would be near
 * black in Day theme and vanish. Panels (inputs, menus) keep their theme
 * surfaces, because they are surfaces.
 */
function Stage({
  videoRef,
  audioMode,
  onStageClick,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  audioMode: boolean;
  onStageClick: (e: React.MouseEvent) => void;
}) {
  const streamUrl = useWatchPartyStore((s) => s.streamUrl);
  const buffering = useWatchPartyStore((s) => s.buffering);
  const error = useWatchPartyStore((s) => s.error);
  const controllerId = useWatchPartyStore((s) => s.controllerId);
  const setStreamUrl = useWatchPartyStore((s) => s.setStreamUrl);
  const gated = useWatchPartyStore((s) => s.waitingFor.length > 0);
  const self = useIdentityStore((s) => s.self);
  const contactsById = useRosterStore((s) => s.contactsById);
  const controller = selfIsController();
  const ytId = streamUrl ? youtubeId(streamUrl) : null;
  const urlRef = useRef<HTMLInputElement>(null);
  // How the source is being played ("Remuxing", "Transcoding"…), which is what
  // explains a slow start.
  const [pipeline, setPipeline] = useState<string | null>(null);

  // Attach once, before the load effect below runs.
  useEffect(() => {
    if (!videoRef.current) return;
    player.attachHtml(videoRef.current);
    return () => {
      void player.teardown();
    };
  }, [videoRef]);

  // The single load path. Both the controller (setStreamUrl) and followers
  // (handleStart) get here by writing streamUrl into the store, so the service
  // never has to know whether a <video> element exists yet.
  useEffect(() => {
    if (!streamUrl) return;
    useWatchPartyStore.getState()._setError(null);
    setPipeline(null);
    void player.load(streamUrl);
  }, [streamUrl]);

  // Read on every buffering transition, not once load() resolves: load() only
  // returns after the first segment exists, which is exactly when the wait it
  // was meant to explain is over.
  useEffect(() => {
    setPipeline(player.pipelineLabel());
  }, [streamUrl, buffering]);

  const blocked = error === "autoplay-blocked";
  const controllerName =
    controllerId === self?.identityId
      ? "you"
      : (contactsById[controllerId ?? ""]?.displayName ?? "the host");

  const submitUrl = () => {
    const v = urlRef.current?.value.trim();
    if (v) void setStreamUrl(v);
  };

  return (
    <>
      <video
        ref={videoRef}
        onClick={onStageClick}
        className="h-full w-full object-contain"
        playsInline
      />

      {ytId && <YouTubePlayer visible={!audioMode} onStageClick={onStageClick} />}

      {gated && !error && <PrimingOverlay />}

      {/* Not for a YouTube source: its player spins its own, in the same
          place, and the label under ours would read "YouTube…" — a pipeline
          note for a pipeline that isn't running. */}
      {buffering && !ytId && !gated && !blocked && !error && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3">
          <span
            className="h-9 w-9 animate-spin rounded-full border-2 border-white/25 border-t-accent motion-reduce:animate-none"
            aria-hidden="true"
          />
          {pipeline && pipeline !== "Direct play" && (
            <span className="text-xs tracking-wide text-white/60">{pipeline}…</span>
          )}
        </div>
      )}

      {blocked && (
        <div className="absolute inset-0 flex items-center justify-center">
          <button
            type="button"
            onClick={() => {
              useWatchPartyStore.getState()._setError(null);
              void player.setPause(false);
            }}
            className="flex max-w-sm flex-col items-center gap-3 px-8 py-6 text-center"
          >
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-accent text-accent-ink transition-transform duration-150 hover:scale-105 motion-reduce:transition-none">
              <Play size={26} aria-hidden="true" />
            </span>
            <span className="text-sm font-medium text-white">Click to start watching</span>
            <span className="text-xs leading-relaxed text-white/55">
              This machine won&rsquo;t start video on its own — {controllerName} is already going.
            </span>
          </button>
        </div>
      )}

      {error && !blocked && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-10 text-center">
          <p className="font-display text-xl text-white">This stream wouldn&rsquo;t play</p>
          <p className="max-w-xl text-xs leading-relaxed break-words text-white/55">{error}</p>
          {streamUrl && (
            <ChromeTextButton
              onClick={() => {
                useWatchPartyStore.getState()._setError(null);
                void player.load(streamUrl);
              }}
            >
              Try again
            </ChromeTextButton>
          )}
        </div>
      )}

      {!streamUrl && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 px-10 text-center">
          <p className="font-display text-2xl text-white">Nothing playing yet</p>
          {controller ? (
            <div className="flex w-full max-w-lg items-center gap-2">
              <input
                ref={urlRef}
                type="url"
                placeholder="Paste a link to the video you want to watch"
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitUrl();
                }}
                className="min-w-0 flex-1 rounded-full border border-border bg-bg-secondary px-4 py-2 text-sm text-text-primary transition-colors placeholder:text-text-muted focus-visible:border-accent"
              />
              <Button size="md" onClick={submitUrl}>
                Play it
              </Button>
            </div>
          ) : (
            <p className="text-sm text-white/55">
              Waiting for {controllerName} to pick something.
            </p>
          )}
        </div>
      )}
    </>
  );
}

/** Faces of everyone in the party with each peer's real readiness. The sync
 * layer already collects it, and it is the only signal that says *who* is the
 * reason playback keeps correcting. */
function PartyPresence() {
  const members = useWatchPartyStore((s) => s.members);
  const controllerId = useWatchPartyStore((s) => s.controllerId);
  const roomId = useWatchPartyStore((s) => s.roomId);
  const self = useIdentityStore((s) => s.self);
  const contactsById = useRosterStore((s) => s.contactsById);
  const callRoomId = useRoomCallStore((s) => s.roomId);
  const speakingIds = useRoomCallStore((s) => s.speakingIds);

  const inCall = callRoomId === roomId;
  const shown = members.slice(0, 5);
  const overflow = members.length - shown.length;

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center py-0.5">
        {shown.map((m, i) => {
          const name =
            m.id === self?.identityId
              ? (self?.displayName ?? "You")
              : (contactsById[m.id]?.displayName ?? "Guest");
          const isController = m.id === controllerId;
          const isSpeaking = inCall && speakingIds.has(m.id);
          return (
            <Tooltip
              key={m.id}
              side="bottom"
              label={`${name}${isController ? " · controlling" : ""} · ${
                m.ready ? `${Math.round(m.bufferedSec)}s buffered` : "buffering"
              }`}
            >
              <span
                style={{ zIndex: shown.length - i }}
                className={cx(
                  "-mr-1.5 inline-flex rounded-full p-0.5 ring-2 transition-all last:mr-0 motion-reduce:transition-none",
                  isSpeaking ? "ring-success" : "ring-black/70",
                )}
              >
                <Avatar id={m.id} name={name} size="sm" />
              </span>
            </Tooltip>
          );
        })}
      </div>
      {overflow > 0 && <span className="text-xs text-white/60">+{overflow}</span>}
    </div>
  );
}

/** Decorative spectrogram. `active` gates both "should move" and the film's own
 * play state — when it is false the bars sit low and still. Durations/delays are
 * derived from the index so they stagger without a random source. */
function Equalizer({
  active,
  count,
  className,
  barClassName,
}: {
  active: boolean;
  count: number;
  className?: string;
  barClassName?: string;
}) {
  return (
    <div className={cx("flex items-end justify-center gap-[3px]", className)} aria-hidden="true">
      {Array.from({ length: count }).map((_, i) =>
        active ? (
          <span
            key={i}
            className={cx("eq-bar h-full rounded-full bg-accent", barClassName)}
            style={
              {
                "--eq-dur": `${0.6 + ((i * 37) % 70) / 100}s`,
                "--eq-delay": `${((i * 53) % 60) / 100}s`,
              } as React.CSSProperties
            }
          />
        ) : (
          <span
            key={i}
            className={cx("h-full origin-bottom rounded-full bg-accent/70", barClassName)}
            style={{ transform: "scaleY(0.3)" }}
          />
        ),
      )}
    </div>
  );
}

/** The audio-mode turntable: a spinning record that freezes when the film is
 * paused, standing in for the picture we're no longer showing. The tonearm
 * rides the outer grooves while it plays and swings back to its rest when it
 * stops, so play state reads from across the room. */
function Disc({ spinning }: { spinning: boolean }) {
  return (
    <svg
      viewBox="0 0 140 128"
      className="h-28 w-[7.7rem] shrink-0 drop-shadow-[0_0_45px_rgba(0,0,0,0.5)]"
      role="img"
      aria-label={spinning ? "Record playing" : "Record paused"}
    >
      <g className={cx("gramo-record", !spinning && "[animation-play-state:paused]")}>
        <circle cx="56" cy="64" r="54" fill="#141414" stroke="rgba(255,255,255,0.08)" />
        <circle cx="56" cy="64" r="44" fill="none" stroke="rgba(255,255,255,0.06)" />
        <circle cx="56" cy="64" r="34" fill="none" stroke="rgba(255,255,255,0.06)" />
        <circle cx="56" cy="64" r="24" fill="none" stroke="rgba(255,255,255,0.06)" />
        <line x1="56" y1="64" x2="56" y2="10" stroke="rgba(255,255,255,0.10)" strokeWidth="1.5" />
        <circle cx="56" cy="64" r="15" fill="var(--color-accent)" />
        <circle cx="56" cy="64" r="2.5" fill="#000" />
      </g>

      {/* The rest post the arm parks on. */}
      <rect x="124" y="54" width="8" height="18" rx="4" fill="#1b1b1b" stroke="rgba(255,255,255,0.08)" />

      {/* Drawn in the playing position; parked is the same arm rotated about
          its pivot — see .gramo-tonearm in globals.css. */}
      <g className={cx("gramo-tonearm", !spinning && "gramo-tonearm--parked")}>
        <circle cx="120" cy="26" r="8" fill="#1b1b1b" stroke="rgba(255,255,255,0.12)" />
        <circle cx="128" cy="21" r="4.5" fill="#242424" stroke="rgba(255,255,255,0.10)" />
        <line
          x1="120"
          y1="26"
          x2="90"
          y2="44"
          stroke="rgba(255,255,255,0.55)"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <circle cx="90" cy="44" r="3.2" fill="var(--color-accent)" />
      </g>
    </svg>
  );
}

/** The faces when nobody has joined the call yet: big highlighted avatars, each
 * with its own spectrogram, so the room still reads as a shared listening space
 * before any camera is live. */
function IdleFaces({ paused }: { paused: boolean }) {
  const members = useWatchPartyStore((s) => s.members);
  const controllerId = useWatchPartyStore((s) => s.controllerId);
  const self = useIdentityStore((s) => s.self);
  const contactsById = useRosterStore((s) => s.contactsById);

  return (
    <div className="relative flex max-w-4xl flex-wrap items-start justify-center gap-x-8 gap-y-8">
      {members.map((m) => {
        const name =
          m.id === self?.identityId
            ? (self?.displayName ?? "You")
            : (contactsById[m.id]?.displayName ?? "Guest");
        const isController = m.id === controllerId;
        return (
          <div key={m.id} className="flex w-24 flex-col items-center gap-2.5">
            <div className="relative">
              <span className="relative inline-flex rounded-full p-1 ring-2 ring-white/15">
                <Avatar id={m.id} name={name} size="xl" />
              </span>
              {isController && (
                <span
                  className="absolute -top-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full bg-accent text-accent-ink ring-4 ring-black"
                  aria-label="Controlling playback"
                >
                  <Crown size={13} aria-hidden="true" />
                </span>
              )}
            </div>
            <Equalizer active={!paused} count={5} className="h-4 w-12 opacity-80" barClassName="w-1" />
            <span className="w-full truncate text-sm font-medium text-white">{name}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Audio mode. Covers the picture — the `<video>` keeps playing underneath, so
 * the sound and the sync loop never stop. It's a normal call grid dressed in
 * audio chrome: a spinning record, a spectrogram, and the room's own cameras
 * front and centre. Falls back to highlighted faces before anyone joins. */
function AudioStage({ paused }: { paused: boolean }) {
  const roomId = useWatchPartyStore((s) => s.roomId);
  const streamUrl = useWatchPartyStore((s) => s.streamUrl);
  const videoTitle = useWatchPartyStore((s) => s.videoTitle);
  const self = useIdentityStore((s) => s.self);
  const contactsById = useRosterStore((s) => s.contactsById);

  const callRoomId = useRoomCallStore((s) => s.roomId);
  const participants = useRoomCallStore((s) => s.participants);
  const streams = useRoomCallStore((s) => s.streamsByParticipant);
  const camOnByParticipant = useRoomCallStore((s) => s.camOnByParticipant);
  const qualityByParticipant = useRoomCallStore((s) => s.qualityByParticipant);
  const localStream = useRoomCallStore((s) => s.localStream);
  const micOn = useRoomCallStore((s) => s.micOn);
  const camOn = useRoomCallStore((s) => s.camOn);
  const speakingIds = useRoomCallStore((s) => s.speakingIds);
  useRoomCallStore((s) => s.mediaVersion);

  const inCall = callRoomId === roomId;
  let host = "";
  try {
    host = streamUrl ? new URL(streamUrl).hostname.replace(/^www\./, "") : "";
  } catch {
    host = "";
  }

  const nameOf = (id: string) =>
    id === self?.identityId ? (self?.displayName ?? "You") : (contactsById[id]?.displayName ?? "Guest");
  const { cols, rows } = tileGrid(participants.length);

  return (
    <div
      className="absolute inset-0 flex flex-col items-center gap-6 overflow-y-auto px-4 pt-20 pb-32"
      style={{ background: "radial-gradient(120% 90% at 50% 25%, #17070d 0%, #000 62%, #08040c 100%)" }}
    >
      <span
        className="pointer-events-none absolute top-1/4 left-1/2 h-[40rem] w-[40rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/20 blur-[120px]"
        aria-hidden="true"
      />

      {/* Audio chrome: the record and the caption. */}
      <div className="relative flex shrink-0 flex-col items-center gap-3">
        <Disc spinning={!paused} />
        <div className="flex max-w-lg flex-col items-center gap-0.5">
          <p className="font-display text-xl leading-none text-white">Listening together</p>
          {(videoTitle ?? host) && (
            <p className="text-center text-[11px] tracking-wide text-balance text-white/45">
              {videoTitle ?? host}
            </p>
          )}
        </div>
      </div>

      {/* Mic / camera / leave — the rail is hidden in audio mode, so its
          controls move here. */}
      <div className="relative shrink-0">
        {inCall ? (
          <div className="flex items-center gap-1 rounded-full bg-black/55 p-1 ring-1 ring-white/10 backdrop-blur-md">
            <ChromeButton
              icon={micOn ? Mic : MicOff}
              label={micOn ? "Mute" : "Unmute"}
              onClick={() => useRoomCallStore.getState().toggleMic()}
              className={cx(!micOn && "text-danger hover:text-danger")}
            />
            <ChromeButton
              icon={camOn ? Video : VideoOff}
              label={camOn ? "Turn camera off" : "Turn camera on"}
              onClick={() => void useRoomCallStore.getState().toggleCam()}
            />
            <ChromeButton
              icon={LogOut}
              label="Leave call"
              onClick={() => useRoomCallStore.getState().leave()}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => roomId && void useRoomCallStore.getState().join(roomId)}
            className="flex items-center gap-2 rounded-full bg-black/55 px-4 py-2.5 text-sm font-medium text-white/90 ring-1 ring-white/10 backdrop-blur-md transition-colors hover:bg-black/70 hover:text-white"
          >
            <Video size={15} aria-hidden="true" className="shrink-0 text-accent" />
            Join with camera &amp; mic
          </button>
        )}
      </div>

      {/* The room's cameras, large — a normal call grid. Rows divide the
          available height so the grid never spills past the transport bar. */}
      {inCall && participants.length > 0 ? (
        <div
          className="relative grid min-h-0 w-full max-w-6xl flex-1 gap-3"
          style={tileTracks(cols, rows)}
        >
          {participants.map((id, i) => {
            const stream = id === self?.identityId ? localStream : (streams[id] ?? null);
            const hasVideo =
              id === self?.identityId
                ? camOn
                : hasLiveVideo(stream) && camOnByParticipant[id] !== false;
            return (
              <div
                key={id}
                className="min-h-0 min-w-0"
                style={{ gridColumn: tileColumn(i, participants.length, cols) }}
              >
                <VideoTile
                  stream={stream}
                  // The presence rail is playing these same streams underneath.
                  muted
                  mirror={id === self?.identityId}
                  label={nameOf(id)}
                  participantId={id}
                  quality={id === self?.identityId ? undefined : qualityByParticipant[id]}
                  hasVideo={hasVideo}
                  speaking={speakingIds.has(id)}
                  fit="fill"
                />
              </div>
            );
          })}
        </div>
      ) : (
        <div className="relative flex flex-1 items-center">
          <IdleFaces paused={paused} />
        </div>
      )}
    </div>
  );
}

export function WatchPartyWindow() {
  const active = useWatchPartyStore((s) => s.active);
  const streamUrl = useWatchPartyStore((s) => s.streamUrl);
  const videoTitle = useWatchPartyStore((s) => s.videoTitle);
  const paused = useWatchPartyStore((s) => s.paused);
  const positionSec = useWatchPartyStore((s) => s.positionSec);
  const durationSec = useWatchPartyStore((s) => s.durationSec);
  const bufferedSec = useWatchPartyStore((s) => s.bufferedSec);
  const playbackRate = useWatchPartyStore((s) => s.playbackRate);
  const roomId = useWatchPartyStore((s) => s.roomId);
  const ownerId = useWatchPartyStore((s) => s.ownerId);
  const controllerId = useWatchPartyStore((s) => s.controllerId);
  const members = useWatchPartyStore((s) => s.members);
  const tracks = useWatchPartyStore((s) => s.tracks);
  const audioTrackId = useWatchPartyStore((s) => s.audioTrackId);
  const subTrackId = useWatchPartyStore((s) => s.subTrackId);
  const subDelaySec = useWatchPartyStore((s) => s.subDelaySec);
  const subLoading = useWatchPartyStore((s) => s.subLoading);
  const subProgress = useWatchPartyStore((s) => s.subProgress);
  const togglePlay = useWatchPartyStore((s) => s.togglePlay);
  const seek = useWatchPartyStore((s) => s.seek);
  const setRate = useWatchPartyStore((s) => s.setRate);
  const setAudioTrack = useWatchPartyStore((s) => s.setAudioTrack);
  const setSubTrack = useWatchPartyStore((s) => s.setSubTrack);
  const setSubDelay = useWatchPartyStore((s) => s.setSubDelay);
  const addSubtitle = useWatchPartyStore((s) => s.addSubtitle);
  const setStreamUrl = useWatchPartyStore((s) => s.setStreamUrl);
  const handControlTo = useWatchPartyStore((s) => s.handControlTo);
  const leave = useWatchPartyStore((s) => s.leave);
  const end = useWatchPartyStore((s) => s.end);
  const self = useIdentityStore((s) => s.self);
  const contactsById = useRosterStore((s) => s.contactsById);

  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sourceRef = useRef<HTMLInputElement>(null);
  const idleRef = useRef<number | null>(null);
  const clickRef = useRef<number | null>(null);
  const fullscreenRef = useRef(false);
  // Read by the key handler, so shortcuts don't re-bind on every timeupdate.
  const posRef = useRef(positionSec);
  posRef.current = positionSec;

  const [idle, setIdle] = useState(false);
  const [holdChrome, setHoldChrome] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [railShown, setRailShown] = useState(true);
  const [audioMode, setAudioMode] = useState(false);

  // Window chrome — floating keeps chat accessible, minimized keeps a PIP
  type WindowState = "floating" | "minimized" | "maximized";
  const [windowState, setWindowState] = useState<WindowState>("floating");
  const { pos, dragRef, headerProps } = useDraggable();
  const [size, setSize] = useState<{ w: number; h: number }>({
    w: Math.min(960, Math.max(480, typeof window !== "undefined" ? Math.floor(window.innerWidth * 0.62) : 960)),
    h: Math.min(640, Math.max(360, typeof window !== "undefined" ? Math.floor(window.innerHeight * 0.62) : 600)),
  });
  const resizingRef = useRef<null | { dir: "e" | "s" | "se"; startX: number; startY: number; startW: number; startH: number }>(null);

  function toggleMaximize() {
    setWindowState((s) => (s === "maximized" ? "floating" : "maximized"));
  }
  function toggleMinimize() {
    setWindowState((s) => (s === "minimized" ? "floating" : "minimized"));
  }
  function onResizeStart(dir: "e" | "s" | "se") {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      resizingRef.current = { dir, startX: e.clientX, startY: e.clientY, startW: size.w, startH: size.h };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    };
  }
  useEffect(() => {
    function onMove(e: PointerEvent) {
      const r = resizingRef.current;
      if (!r) return;
      const dx = e.clientX - r.startX;
      const dy = e.clientY - r.startY;
      let nw = r.startW;
      let nh = r.startH;
      if (r.dir === "e" || r.dir === "se") nw = r.startW + dx;
      if (r.dir === "s" || r.dir === "se") nh = r.startH + dy;
      const minW = 360;
      const minH = 260;
      const maxW = window.innerWidth - 24;
      const maxH = window.innerHeight - 24;
      nw = Math.max(minW, Math.min(nw, maxW));
      nh = Math.max(minH, Math.min(nh, maxH));
      setSize({ w: nw, h: nh });
    }
    function onUp() {
      resizingRef.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [size.w, size.h]);

  const controller = selfIsController();

  const wake = useCallback(() => {
    setIdle(false);
    if (idleRef.current) window.clearTimeout(idleRef.current);
    idleRef.current = window.setTimeout(() => setIdle(true), IDLE_MS);
  }, []);

  useEffect(() => {
    if (!active) return;
    wake();
    return () => {
      if (idleRef.current) window.clearTimeout(idleRef.current);
      if (clickRef.current) window.clearTimeout(clickRef.current);
    };
  }, [active, wake]);

  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const next = !fullscreenRef.current;
    fullscreenRef.current = next;
    setFullscreen(next);
    void (next ? enterFullscreen(el) : exitFullscreen()).catch(() => {
      fullscreenRef.current = !next;
      setFullscreen(!next);
    });
  }, []);

  // Catches the exits we didn't ask for — Escape, the green button, the OS.
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenEnabled) return;
      const on = document.fullscreenElement === rootRef.current;
      fullscreenRef.current = on;
      setFullscreen(on);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Leaving the party while fullscreen would strand the whole app there.
  useEffect(() => {
    if (active || !fullscreenRef.current) return;
    fullscreenRef.current = false;
    setFullscreen(false);
    void exitFullscreen().catch(() => undefined);
  }, [active]);

  // Volume is deliberately local: it is about this room, not about the party.
  useEffect(() => {
    player.setVolume(volume, muted);
  }, [muted, volume]);

  // Player shortcuts. Transport keys are controller-only — a follower pressing
  // space would fight its own sync loop a half-second later.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const transport = (fn: () => void) => {
        if (!controller || !streamUrl) return;
        e.preventDefault();
        fn();
        wake();
      };
      switch (e.key) {
        case " ":
        case "k":
          transport(togglePlay);
          break;
        case "ArrowLeft":
          transport(() => seek(Math.max(0, posRef.current - ARROW_SEC)));
          break;
        case "ArrowRight":
          transport(() => seek(posRef.current + ARROW_SEC));
          break;
        case "j":
          transport(() => seek(Math.max(0, posRef.current - SKIP_SEC)));
          break;
        case "l":
          transport(() => seek(posRef.current + SKIP_SEC));
          break;
        case "f":
          toggleFullscreen();
          wake();
          break;
        case "m":
          setMuted((m) => !m);
          wake();
          break;
        // Only reachable on the window-API fullscreen path; the DOM API exits on
        // Escape by itself, and an open menu swallows the key before this.
        case "Escape":
          if (fullscreenRef.current) toggleFullscreen();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, controller, streamUrl, seek, togglePlay, toggleFullscreen, wake]);

  useEffect(() => {
    if (sourceOpen) sourceRef.current?.focus();
  }, [sourceOpen]);

  // Keep the fullscreen DOM target stable — the container itself is fullscreened.
  // Must be before any early return (Rules of Hooks).
  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      (rootRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
      (dragRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    },
    [dragRef],
  );

  const isMinimized = windowState === "minimized";
  const isMaximized = windowState === "maximized";
  const isFloating = windowState === "floating";

  let containerStyle: React.CSSProperties = {};
  if (isMaximized) {
    containerStyle = { position: "fixed", inset: "12px", zIndex: 40 };
  } else if (isMinimized) {
    containerStyle = {
      position: "fixed",
      bottom: "24px",
      right: "24px",
      width: "360px",
      height: "220px",
      zIndex: 40,
    };
  } else if (pos) {
    containerStyle = {
      position: "fixed",
      left: `${pos.x}px`,
      top: `${pos.y}px`,
      width: `${size.w}px`,
      height: `${size.h}px`,
      zIndex: 40,
    };
  } else {
    containerStyle = {
      position: "fixed",
      bottom: "24px",
      right: "24px",
      width: `${size.w}px`,
      height: `${size.h}px`,
      zIndex: 40,
    };
  }

  if (!active) return null;

  const isOwner = !!self && ownerId === self.identityId;
  const controllerName =
    controllerId === self?.identityId
      ? "You"
      : (contactsById[controllerId ?? ""]?.displayName ?? "Someone");

  // Chrome stays up while paused, while there is nothing to watch, and while the
  // pointer or focus is inside it — hiding a menu mid-interaction is hostile.
  // Audio mode has no picture to get out of the way of, so the controls stay.
  const chromeShown = !idle || paused || !streamUrl || holdChrome || sourceOpen || audioMode;
  const transportOff = !controller || !streamUrl;

  const audio = tracks.filter((t) => t.type === "audio");
  const subs = tracks.filter((t) => t.type === "sub");

  const audioItems: MenuItem[] = [
    { value: "auto", label: "Automatic", hint: "the source's default track" },
    ...audio.map((t) => ({
      value: String(t.id),
      label: t.title ?? t.lang ?? `Track ${t.id + 1}`,
      hint: [t.lang, t.codec].filter(Boolean).join(" · ") || undefined,
    })),
  ];
  const subItems: MenuItem[] = [
    { value: "no", label: "Off" },
    ...subs.map((t) => ({
      value: String(t.id),
      label: t.title ?? t.lang ?? `Subtitle ${t.id + 1}`,
      hint: t.supported
        ? [t.lang, t.codec].filter(Boolean).join(" · ") || undefined
        : `${t.codec ?? "This format"} is image-based and can't be shown`,
      disabled: !t.supported,
    })),
  ];

  const volumePct = Math.round((muted ? 0 : volume) * 100);

  // Single click toggles play, double click goes fullscreen. The play toggle is
  // held for one click interval, so a double click doesn't pause and resume the
  // whole party on its way to fullscreen.
  const onStageClick = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (clickRef.current) {
      window.clearTimeout(clickRef.current);
      clickRef.current = null;
      toggleFullscreen();
      return;
    }
    clickRef.current = window.setTimeout(() => {
      clickRef.current = null;
      if (!transportOff) togglePlay();
    }, DOUBLE_CLICK_MS);
  };

  const submitSource = () => {
    const v = sourceRef.current?.value.trim();
    if (v && v !== streamUrl) void setStreamUrl(v);
    setSourceOpen(false);
  };

  // Unified portal — single <video> stays mounted so minimize never tears down playback.
  // audio keeps playing because Stage is never unmounted.
  return createPortal(
    <div
      ref={setRefs}
      style={containerStyle}
      className={cx(
        "flex flex-col overflow-hidden bg-black shadow-2xl",
        isMinimized && "rounded-2xl border border-white/10",
        isFloating && "rounded-2xl border border-white/10",
        isMaximized && "rounded-2xl border border-white/10",
        !isMinimized && !chromeShown && "cursor-none",
      )}
      onPointerMove={!isMinimized ? wake : undefined}
      onPointerDown={!isMinimized ? wake : undefined}
    >
      {/* Header — compact when minimized, draggable when floating/maximized */}
      {isMinimized ? (
        <header
          {...headerProps}
          onDoubleClick={toggleMaximize}
          className="flex h-8 shrink-0 items-center justify-between bg-black px-2 select-none cursor-grab active:cursor-grabbing"
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <Move size={12} className="shrink-0 text-white/40" aria-hidden="true" />
            <span className="truncate text-xs font-semibold text-white">
              {audioMode ? "Listen party" : "Watch party"} · {members.length} watching
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0" data-nodrag>
            <button
              onClick={toggleMinimize}
              aria-label="Expand party"
              title="Expand"
              className="flex h-6 w-6 items-center justify-center rounded-md text-white/60 hover:bg-white/10 hover:text-white transition-colors"
            >
              <Maximize2 size={12} />
            </button>
            <button
              onClick={isOwner ? end : leave}
              aria-label={isOwner ? "End party" : "Leave party"}
              title={isOwner ? "End party" : "Leave"}
              className="flex h-6 w-6 items-center justify-center rounded-md bg-white/10 text-white/70 hover:bg-danger hover:text-white transition-colors"
            >
              <X size={12} />
            </button>
          </div>
        </header>
      ) : (
        <div
          {...(isMaximized ? {} : headerProps)}
          onDoubleClick={toggleMaximize}
          className={cx(
            "flex shrink-0 flex-col gap-2 bg-black px-3 py-2 border-b border-white/10 select-none z-30",
            !isMaximized && "cursor-grab active:cursor-grabbing",
          )}
        >
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 items-center gap-2.5 overflow-hidden">
              {!isMaximized && <Move size={12} className="shrink-0 text-white/30" aria-hidden="true" />}
              <span className="flex shrink-0 items-center gap-2 text-sm font-semibold text-white">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
                {audioMode ? "Listen party" : "Watch party"}
              </span>
              <ChromeChip>{members.length === 1 ? "Just you" : `${members.length} watching`}</ChromeChip>
              <PartyPresence />
              <ChromeChip tone={controller ? "accent" : "neutral"}>
                {controller ? "You control playback" : `${controllerName} is controlling`}
              </ChromeChip>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1.5" data-nodrag>
              {controller && members.length > 1 && (
                <PlayerMenu
                  icon={Crown}
                  label="Give control to"
                  heading="Give control to"
                  side="bottom"
                  items={members
                    .filter((m) => m.id !== self?.identityId)
                    .map((m) => ({
                      value: m.id,
                      label: contactsById[m.id]?.displayName ?? "Guest",
                      hint: m.ready ? undefined : "still buffering",
                    }))}
                  onSelect={handControlTo}
                />
              )}
              {controller && streamUrl && (
                <ChromeButton
                  icon={Film}
                  label="Play something else"
                  onClick={() => setSourceOpen((o) => !o)}
                  className={cx(sourceOpen && "bg-white/20 text-white")}
                />
              )}
              {isOwner ? (
                <ChromeTextButton icon={X} tone="danger" onClick={end}>
                  End party
                </ChromeTextButton>
              ) : (
                <ChromeTextButton icon={LogOut} onClick={leave}>
                  Leave
                </ChromeTextButton>
              )}
              <button
                onClick={toggleMinimize}
                aria-label="Minimize party"
                title="Minimize to picture-in-picture"
                className="flex h-6 w-6 items-center justify-center rounded-md text-white/60 hover:bg-white/10 hover:text-white transition-colors"
              >
                <Minus size={14} />
              </button>
              <button
                onClick={toggleMaximize}
                aria-label={isMaximized ? "Restore" : "Maximize"}
                title={isMaximized ? "Restore" : "Maximize"}
                className="flex h-6 w-6 items-center justify-center rounded-md text-white/60 hover:bg-white/10 hover:text-white transition-colors"
              >
                {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            </div>
          </div>
          {sourceOpen && (
            <div className="flex max-w-2xl items-center gap-2" data-nodrag>
              <input
                ref={sourceRef}
                type="url"
                defaultValue={streamUrl ?? ""}
                placeholder="Paste a link to the video you want to watch"
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitSource();
                  if (e.key === "Escape") setSourceOpen(false);
                }}
                className="min-w-0 flex-1 rounded-full border border-border bg-bg-secondary px-4 py-2 text-sm text-text-primary transition-colors placeholder:text-text-muted focus-visible:border-accent"
              />
              <Button size="sm" onClick={submitSource}>
                Play it
              </Button>
              <ChromeTextButton onClick={() => setSourceOpen(false)}>Cancel</ChromeTextButton>
            </div>
          )}
        </div>
      )}

      <div className="relative flex-1 min-h-0 overflow-hidden bg-black">
        {/* Single persistent video — never unmounted, so minimize doesn't teardown player */}
        <Stage
          videoRef={videoRef}
          audioMode={audioMode}
          onStageClick={isMinimized ? () => setWindowState("floating") : onStageClick}
        />

        {!isMinimized && audioMode && streamUrl && <AudioStage paused={paused} />}

        {/* Never unmounted: these tiles are what plays the room's voices, and
            a hidden tile still plays. Mounting them only when they are on
            screen cut the call every time the party was minimized. */}
        <PresenceRail roomId={roomId} visible={railShown && !audioMode && !isMinimized} />

        {/* Minimized PIP overlay — compact, keeps audio playing */}
        {isMinimized && (
          <>
            {audioMode && streamUrl ? (
              <div
                className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 cursor-pointer"
                style={{ background: "radial-gradient(120% 90% at 50% 25%, #17070d 0%, #000 62%, #08040c 100%)" }}
                onClick={() => setWindowState("floating")}
              >
                <span className="pointer-events-none absolute top-1/4 left-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/15 blur-[40px]" aria-hidden="true" />
                <div className="relative scale-[0.62] origin-center pointer-events-none -my-2">
                  <Disc spinning={!paused} />
                </div>
                <p className="relative text-xs font-medium text-white">Listening together</p>
                {(() => {
                  let host = "";
                  try {
                    host = streamUrl ? new URL(streamUrl).hostname.replace(/^www\./, "") : "";
                  } catch {
                    host = "";
                  }
                  const label = videoTitle ?? host;
                  return label ? <p className="relative text-[10px] tracking-wide text-white/40 -mt-1 truncate max-w-full">{label}</p> : null;
                })()}
                <div className="relative mt-1 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!transportOff) togglePlay();
                    }}
                    disabled={transportOff}
                    className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-black hover:bg-white/90 disabled:opacity-40 transition-colors"
                    aria-label={paused ? "Play" : "Pause"}
                  >
                    {paused ? <Play size={12} className="ml-0.5" /> : <Pause size={12} />}
                  </button>
                  <span className="text-[11px] tabular-nums text-white/70">
                    {formatClock(positionSec)} <span className="text-white/30">/ {formatClock(durationSec)}</span>
                  </span>
                </div>
              </div>
            ) : (
              <div
                className="absolute inset-0 cursor-pointer"
                onClick={() => setWindowState("floating")}
              >
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent pointer-events-none" />
                <div className="absolute bottom-0 left-0 right-0 flex items-center gap-1.5 px-2 py-1.5">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!transportOff) togglePlay();
                    }}
                    disabled={transportOff}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white text-black hover:bg-white/90 disabled:opacity-40 transition-colors"
                    aria-label={paused ? "Play" : "Pause"}
                  >
                    {paused ? <Play size={10} className="ml-0.5" /> : <Pause size={10} />}
                  </button>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-white/90">
                    {videoTitle ?? (streamUrl ? (() => { try { return new URL(streamUrl).hostname.replace(/^www\./, ""); } catch { return "Video"; } })() : "Nothing playing")}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-white/60">{formatClock(positionSec)}</span>
                </div>
              </div>
            )}
          </>
        )}

        {!isMinimized && (
          <div
            onPointerEnter={() => setHoldChrome(true)}
            onPointerLeave={() => setHoldChrome(false)}
            onFocus={() => setHoldChrome(true)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setHoldChrome(false);
            }}
            className={cx(
              "pointer-events-none absolute inset-0 z-20 flex flex-col justify-end transition-opacity duration-200 motion-reduce:transition-none",
              chromeShown ? "opacity-100" : "opacity-0",
            )}
          >
        {/* Transport — the film's own controls. */}
        <div className="pointer-events-auto bg-gradient-to-t from-black/85 via-black/55 to-transparent px-4 pt-10 pb-3">
          <Scrubber
            positionSec={positionSec}
            durationSec={durationSec}
            bufferedSec={bufferedSec}
            disabled={transportOff}
            onSeek={seek}
          />

          <div className="mt-2 flex items-center gap-1.5">
            <ChromeButton
              icon={paused ? Play : Pause}
              label={paused ? "Play" : "Pause"}
              size="lg"
              primary
              disabled={transportOff}
              onClick={togglePlay}
            />
            <ChromeButton
              icon={RotateCcw}
              label={`Back ${SKIP_SEC} seconds`}
              disabled={transportOff}
              onClick={() => seek(Math.max(0, positionSec - SKIP_SEC))}
            />
            <ChromeButton
              icon={RotateCw}
              label={`Forward ${SKIP_SEC} seconds`}
              disabled={transportOff}
              onClick={() => seek(positionSec + SKIP_SEC)}
            />

            <span className="ml-1 text-xs tabular-nums text-white/75">
              {formatClock(positionSec)}
              <span className="text-white/40"> / {formatClock(durationSec)}</span>
            </span>

            <div className="mx-2 flex items-center gap-1.5">
              <ChromeButton
                icon={muted || volume === 0 ? VolumeX : Volume2}
                label={muted ? "Unmute" : "Mute"}
                onClick={() => setMuted((m) => !m)}
              />
              <input
                type="range"
                aria-label="Volume"
                min={0}
                max={1}
                step={0.02}
                value={muted ? 0 : volume}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setVolume(v);
                  setMuted(v === 0);
                }}
                className="range-slim w-20"
                style={{ "--fill": `${volumePct}%` } as React.CSSProperties}
              />
            </div>

            <div className="ml-auto flex items-center gap-1">
              {audio.length > 1 && (
                <PlayerMenu
                  icon={AudioLines}
                  label="Audio track"
                  heading="Audio"
                  items={audioItems}
                  value={String(audioTrackId)}
                  disabled={!controller}
                  onSelect={(v) => setAudioTrack(v === "auto" ? "auto" : Number(v))}
                />
              )}

              <PlayerMenu
                icon={Subtitles}
                label="Subtitles"
                heading="Subtitles"
                items={subItems}
                value={String(subTrackId)}
                disabled={!controller}
                busy={subLoading}
                onSelect={(v) => setSubTrack(v === "no" ? "no" : Number(v))}
                footer={
                  <div className="flex flex-col gap-2">
                    {subLoading && (
                      <div className="flex flex-col gap-1.5">
                        <p className="text-xs leading-relaxed text-text-muted">
                          Reading subtitles out of the source — the first time a track is
                          picked this takes a pass over the whole file.
                          {subProgress !== null && ` ${Math.round(subProgress * 100)}%`}
                        </p>
                        <span className="h-0.5 overflow-hidden rounded-full bg-border">
                          <span
                            className="block h-full bg-accent transition-[width] duration-500"
                            style={{ width: `${(subProgress ?? 0) * 100}%` }}
                          />
                        </span>
                      </div>
                    )}
                    {subTrackId !== "no" && !subLoading && (
                      <label className="flex items-center justify-between gap-2 text-xs text-text-secondary">
                        Delay
                        <span className="flex items-center gap-1">
                          <input
                            type="number"
                            step={0.25}
                            value={subDelaySec}
                            onChange={(e) => setSubDelay(Number(e.target.value))}
                            className="w-16 rounded-md border border-border bg-bg-secondary px-1.5 py-1 text-right text-xs text-text-primary"
                          />
                          s
                        </span>
                      </label>
                    )}
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      className="text-left text-xs font-medium text-accent transition-opacity hover:opacity-75"
                    >
                      Add a subtitle file…
                    </button>
                  </div>
                }
              />

              <PlayerMenu
                text={`${playbackRate}×`}
                label="Playback speed"
                heading="Speed"
                items={SPEEDS.map((r) => ({ value: String(r), label: `${r}×` }))}
                value={String(playbackRate)}
                disabled={!controller}
                onSelect={(v) => setRate(Number(v))}
              />

              {streamUrl && (
                <ChromeButton
                  icon={Disc3}
                  label={audioMode ? "Back to video" : "Audio mode"}
                  onClick={() => setAudioMode((a) => !a)}
                  className={cx(audioMode && "bg-white/15 text-white")}
                />
              )}
              {!audioMode && (
                <ChromeButton
                  icon={Users}
                  label={railShown ? "Hide cameras" : "Show cameras"}
                  onClick={() => setRailShown((p) => !p)}
                  className={cx(railShown && "bg-white/15 text-white")}
                />
              )}
              <ChromeButton
                icon={fullscreen ? Minimize : Maximize}
                label={fullscreen ? "Exit full screen" : "Full screen"}
                onClick={toggleFullscreen}
              />
            </div>
          </div>
        </div>
      </div>
        )}
      </div>

      {/* Resize handles — floating only; maximized/fullscreen use inset sizing */}
      {isFloating && !fullscreen && (
        <>
          <div
            onPointerDown={onResizeStart("s")}
            className="absolute bottom-0 left-3 right-3 h-2 cursor-ns-resize touch-none"
            aria-hidden="true"
          />
          <div
            onPointerDown={onResizeStart("e")}
            className="absolute right-0 top-3 bottom-3 w-2 cursor-ew-resize touch-none"
            aria-hidden="true"
          />
          <div
            onPointerDown={onResizeStart("se")}
            className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize touch-none"
            aria-hidden="true"
          >
            <span className="absolute bottom-1 right-1 h-2 w-2 rounded-sm border-r-2 border-b-2 border-white/20" />
          </div>
        </>
      )}

      <input
        ref={fileRef}
        type="file"
        accept=".srt,.ass,.ssa,.vtt,.sub"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void addSubtitle(f);
          e.target.value = "";
        }}
      />
    </div>,
    document.body,
  );
}
