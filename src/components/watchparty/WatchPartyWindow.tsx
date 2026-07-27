import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  LogOut,
  Mic,
  MicOff,
  Pause,
  Play,
  Subtitles,
  X,
  Video,
  VideoOff,
} from "lucide-react";
import { useWatchPartyStore, selfIsController } from "../../stores/useWatchPartyStore";
import { useRoomCallStore } from "../../stores/useRoomCallStore";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { useRosterStore } from "../../stores/useRosterStore";
import * as player from "../../services/watchparty/watchPartyPlayer";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { VideoTile } from "../call/VideoTile";
import { cx } from "../../lib/cx";

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Single video stage — pure HTML <video>, same on all platforms.
function Stage() {
  const streamUrl = useWatchPartyStore((s) => s.streamUrl);
  const buffering = useWatchPartyStore((s) => s.buffering);
  const error = useWatchPartyStore((s) => s.error);
  const videoRef = useRef<HTMLVideoElement>(null);
  // How the source is being played ("Remuxing", "Transcoding"…). Shown only
  // while buffering, which is when a slow start needs explaining.
  const [pipeline, setPipeline] = useState<string | null>(null);

  // Attach once, before the load effect below runs.
  useEffect(() => {
    if (!videoRef.current) return;
    player.attachHtml(videoRef.current);
    useWatchPartyStore.getState()._setMode("html");
    return () => {
      void player.teardown();
    };
  }, []);

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

  return (
    <div className="relative flex-1 min-h-0 bg-black">
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full object-contain"
        playsInline
      />
      {buffering && !blocked && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/40 pointer-events-none">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          {pipeline && pipeline !== "Direct play" && (
            <span className="text-xs text-white/70">{pipeline}…</span>
          )}
        </div>
      )}
      {blocked && (
        <button
          type="button"
          onClick={() => {
            useWatchPartyStore.getState()._setError(null);
            void player.setPause(false);
          }}
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 text-white"
        >
          <Play className="h-10 w-10" />
          <span className="text-sm">Tap to start watching</span>
        </button>
      )}
      {error && !blocked && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center">
          <span className="text-sm text-danger">This stream couldn't be played</span>
          <span className="text-xs text-text-muted">{error}</span>
        </div>
      )}
      {!streamUrl && !error && (
        <div className="absolute inset-0 flex items-center justify-center text-text-muted">
          No stream set
        </div>
      )}
    </div>
  );
}

function TrackMenus() {
  const controller = selfIsController();
  const tracks = useWatchPartyStore((s) => s.tracks);
  const audioTrackId = useWatchPartyStore((s) => s.audioTrackId);
  const subTrackId = useWatchPartyStore((s) => s.subTrackId);
  const subDelaySec = useWatchPartyStore((s) => s.subDelaySec);
  const subLoading = useWatchPartyStore((s) => s.subLoading);
  const setAudioTrack = useWatchPartyStore((s) => s.setAudioTrack);
  const setSubTrack = useWatchPartyStore((s) => s.setSubTrack);
  const setSubDelay = useWatchPartyStore((s) => s.setSubDelay);
  const addSubtitle = useWatchPartyStore((s) => s.addSubtitle);
  const fileRef = useRef<HTMLInputElement>(null);

  const audio = tracks.filter((t) => t.type === "audio");
  const subs = tracks.filter((t) => t.type === "sub");

  if (audio.length === 0 && subs.length === 0 && !controller) return null;

  return (
    <div className="flex items-center gap-2">
      {audio.length > 1 && (
        <select
          aria-label="Audio track"
          disabled={!controller}
          value={String(audioTrackId)}
          onChange={(e) => {
            const v = e.target.value;
            setAudioTrack(v === "auto" || v === "no" ? v : Number(v));
          }}
          className="rounded-md bg-bg-tertiary px-2 py-1 text-xs text-text-secondary disabled:opacity-50"
        >
          <option value="auto">Audio: auto</option>
          {audio.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title ?? t.lang ?? `Track ${t.id + 1}`}
            </option>
          ))}
        </select>
      )}

      <select
        aria-label="Subtitle track"
        disabled={!controller || subLoading}
        value={String(subTrackId)}
        onChange={(e) => {
          const v = e.target.value;
          setSubTrack(v === "no" ? "no" : Number(v));
        }}
        className="rounded-md bg-bg-tertiary px-2 py-1 text-xs text-text-secondary disabled:opacity-50"
      >
        <option value="no">Subtitles: off</option>
        {subs.map((t) => (
          <option
            key={t.id}
            value={t.id}
            // Bitmap subtitles (PGS, VOBSUB) cannot be converted to WebVTT at
            // all, so they are shown and disabled rather than silently missing.
            disabled={!t.supported}
            title={t.supported ? undefined : `${t.codec ?? "This format"} can't be displayed`}
          >
            {t.title ?? t.lang ?? `Sub ${t.id + 1}`}
            {t.supported ? "" : " (image-based)"}
          </option>
        ))}
      </select>

      {/* An embedded track is only read out of the source on first selection,
          which means a full pass over the file — long enough that silence reads
          as "subtitles are broken". */}
      {subLoading && (
        <span
          className="text-xs text-text-muted"
          title="Reading the subtitles out of the source file — this takes a while the first time a track is chosen."
        >
          Extracting…
        </span>
      )}

      {controller && subTrackId !== "no" && !subLoading && (
        <label className="flex items-center gap-1 text-xs text-text-muted">
          Delay
          <input
            type="number"
            step={0.25}
            value={subDelaySec}
            onChange={(e) => setSubDelay(Number(e.target.value))}
            className="w-16 rounded-md bg-bg-tertiary px-1.5 py-1 text-xs text-text-secondary"
          />
          s
        </label>
      )}

      {controller && (
        <>
          <IconButton
            icon={Subtitles}
            label="Add subtitle file"
            onClick={() => fileRef.current?.click()}
          />
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
        </>
      )}
    </div>
  );
}

function CameraStrip() {
  const roomId = useWatchPartyStore((s) => s.roomId);
  const self = useIdentityStore((s) => s.self);
  const contactsById = useRosterStore((s) => s.contactsById);

  const callRoomId = useRoomCallStore((s) => s.roomId);
  const participants = useRoomCallStore((s) => s.participants);
  const streams = useRoomCallStore((s) => s.streamsByParticipant);
  const camOnByParticipant = useRoomCallStore((s) => s.camOnByParticipant);
  const localStream = useRoomCallStore((s) => s.localStream);
  const micOn = useRoomCallStore((s) => s.micOn);
  const camOn = useRoomCallStore((s) => s.camOn);
  useRoomCallStore((s) => s.mediaVersion);

  const inCall = callRoomId === roomId;

  if (!inCall) {
    return (
      <div className="flex h-24 shrink-0 items-center justify-center border-t border-border/40 bg-bg-base">
        <Button
          size="sm"
          variant="secondary"
          icon={Video}
          onClick={() => roomId && void useRoomCallStore.getState().join(roomId)}
        >
          Join with camera &amp; mic
        </Button>
      </div>
    );
  }

  const remotes = participants.filter((id) => id !== self?.identityId);

  return (
    <div className="flex h-28 shrink-0 items-center gap-2 overflow-x-auto border-t border-border/40 bg-bg-base px-3">
      <div className="relative h-full w-40 shrink-0 overflow-hidden rounded-lg">
        <VideoTile
          stream={localStream}
          muted
          mirror
          label={self?.displayName ? `${self.displayName} (You)` : "You"}
          hasVideo={camOn}
          fit="grid"
          participantId={self?.identityId}
          avatarSize="md"
        />
      </div>
      {remotes.map((id) => (
        <div key={id} className="relative h-full w-40 shrink-0 overflow-hidden rounded-lg">
          <VideoTile
            stream={streams[id] ?? null}
            label={contactsById[id]?.displayName ?? "Guest"}
            hasVideo={camOnByParticipant[id] === true}
            fit="grid"
            participantId={id}
            avatarSize="md"
          />
        </div>
      ))}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <IconButton
          icon={micOn ? Mic : MicOff}
          label={micOn ? "Mute" : "Unmute"}
          active={!micOn}
          onClick={() => useRoomCallStore.getState().toggleMic()}
        />
        <IconButton
          icon={camOn ? Video : VideoOff}
          label={camOn ? "Turn camera off" : "Turn camera on"}
          active={camOn}
          onClick={() => void useRoomCallStore.getState().toggleCam()}
        />
        <IconButton
          icon={LogOut}
          label="Leave call"
          onClick={() => useRoomCallStore.getState().leave()}
        />
      </div>
    </div>
  );
}

export function WatchPartyWindow() {
  const active = useWatchPartyStore((s) => s.active);
  const streamUrl = useWatchPartyStore((s) => s.streamUrl);
  const paused = useWatchPartyStore((s) => s.paused);
  const positionSec = useWatchPartyStore((s) => s.positionSec);
  const durationSec = useWatchPartyStore((s) => s.durationSec);
  const playbackRate = useWatchPartyStore((s) => s.playbackRate);
  const ownerId = useWatchPartyStore((s) => s.ownerId);
  const controllerId = useWatchPartyStore((s) => s.controllerId);
  const members = useWatchPartyStore((s) => s.members);
  const togglePlay = useWatchPartyStore((s) => s.togglePlay);
  const seek = useWatchPartyStore((s) => s.seek);
  const setRate = useWatchPartyStore((s) => s.setRate);
  const setStreamUrl = useWatchPartyStore((s) => s.setStreamUrl);
  const handControlTo = useWatchPartyStore((s) => s.handControlTo);
  const leave = useWatchPartyStore((s) => s.leave);
  const end = useWatchPartyStore((s) => s.end);
  const self = useIdentityStore((s) => s.self);
  const contactsById = useRosterStore((s) => s.contactsById);
  const urlRef = useRef<HTMLInputElement>(null);

  if (!active) return null;

  const isOwner = !!self && ownerId === self.identityId;
  const controller = selfIsController();
  const controllerName =
    controllerId === self?.identityId
      ? "You"
      : (contactsById[controllerId ?? ""]?.displayName ?? "Someone");

  return createPortal(
    <div className="fixed inset-0 z-40 flex flex-col bg-bg-base">
      {/* Header */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border/40 px-4">
        <span className="text-sm font-semibold">Watch party</span>
        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-muted">
          {members.length} watching
        </span>
        <span className="text-xs text-text-muted">
          {controller ? "You control playback" : `${controllerName} is controlling`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {isOwner ? (
            <Button size="sm" variant="danger" icon={X} onClick={end}>
              End party
            </Button>
          ) : (
            <Button size="sm" variant="secondary" icon={LogOut} onClick={leave}>
              Leave
            </Button>
          )}
        </div>
      </header>

      {/* Video stage */}
      <Stage />

      {/* Controls */}
      <div className="flex shrink-0 flex-col gap-2 border-t border-border/40 bg-bg-primary px-4 py-3">
        {controller && (
          <div className="flex items-center gap-2">
            <input
              ref={urlRef}
              type="url"
              defaultValue={streamUrl ?? ""}
              placeholder="https://…/movie.mp4"
              className="min-w-0 flex-1 rounded-md bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const v = urlRef.current?.value.trim();
                if (v) void setStreamUrl(v);
              }}
            >
              Load
            </Button>
          </div>
        )}

        <div className="flex items-center gap-3">
          <IconButton
            icon={paused ? Play : Pause}
            label={paused ? "Play" : "Pause"}
            disabled={!controller}
            onClick={togglePlay}
          />
          <span className="w-16 text-right font-mono text-xs text-text-muted">
            {fmt(positionSec)}
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(1, durationSec)}
            step={0.1}
            value={Math.min(positionSec, durationSec || positionSec)}
            disabled={!controller}
            onChange={(e) => seek(Number(e.target.value))}
            className={cx("flex-1 accent-accent", !controller && "opacity-50")}
          />
          <span className="w-16 font-mono text-xs text-text-muted">{fmt(durationSec)}</span>

          <select
            aria-label="Playback speed"
            disabled={!controller}
            value={String(playbackRate)}
            onChange={(e) => setRate(Number(e.target.value))}
            className="rounded-md bg-bg-tertiary px-2 py-1 text-xs text-text-secondary disabled:opacity-50"
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </select>

          <TrackMenus />

          {controller && members.length > 1 && (
            <select
              aria-label="Give control to"
              value=""
              onChange={(e) => {
                if (e.target.value) handControlTo(e.target.value);
              }}
              className="rounded-md bg-bg-tertiary px-2 py-1 text-xs text-text-secondary"
            >
              <option value="">Give control…</option>
              {members
                .filter((m) => m.id !== self?.identityId)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {contactsById[m.id]?.displayName ?? "Guest"}
                  </option>
                ))}
            </select>
          )}
        </div>
      </div>

      <CameraStrip />
    </div>,
    document.body,
  );
}
