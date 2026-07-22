import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  LogOut,
  Mic,
  MicOff,
  Pause,
  Play,
  Subtitles,
  Video,
  VideoOff,
  X,
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

function Stage() {
  const mode = useWatchPartyStore((s) => s.mode);
  const streamUrl = useWatchPartyStore((s) => s.streamUrl);
  const buffering = useWatchPartyStore((s) => s.buffering);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (mode !== "native" || !stageRef.current) return;
    const el = stageRef.current;
    const push = () => {
      const r = el.getBoundingClientRect();
      player.setStageRect({
        x: r.left,
        y: r.top,
        w: r.width,
        h: r.height,
        dpr: window.devicePixelRatio,
      });
    };
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(push);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [mode]);

  useEffect(() => {
    if (mode === "native" || !videoRef.current) return;
    player.attachHtml(videoRef.current);
    useWatchPartyStore.getState()._setMode("html");
    if (streamUrl) void player.load(streamUrl);
  }, [mode, streamUrl]);

  return (
    <div className={cx("relative flex-1 min-h-0", mode !== "native" && "bg-black")}>
      {mode === "native" ? (
        <div ref={stageRef} className="absolute inset-0" />
      ) : (
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full bg-black"
          playsInline
        />
      )}
      {buffering && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/30 border-t-white" />
        </div>
      )}
      {!streamUrl && (
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
  const setAudioTrack = useWatchPartyStore((s) => s.setAudioTrack);
  const setSubTrack = useWatchPartyStore((s) => s.setSubTrack);
  const addSubtitle = useWatchPartyStore((s) => s.addSubtitle);
  const fileRef = useRef<HTMLInputElement>(null);

  const audio = tracks.filter((t) => t.type === "audio");
  const subs = tracks.filter((t) => t.type === "sub");

  return (
    <div className="flex items-center gap-2">
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
            {t.title ?? t.lang ?? `Track ${t.id}`}
          </option>
        ))}
      </select>

      <select
        aria-label="Subtitle track"
        disabled={!controller}
        value={String(subTrackId)}
        onChange={(e) => {
          const v = e.target.value;
          setSubTrack(v === "no" ? "no" : Number(v));
        }}
        className="rounded-md bg-bg-tertiary px-2 py-1 text-xs text-text-secondary disabled:opacity-50"
      >
        <option value="no">Subtitles: off</option>
        {subs.map((t) => (
          <option key={t.id} value={t.id}>
            {t.title ?? t.lang ?? `Sub ${t.id}`}
          </option>
        ))}
      </select>

      {controller && (
        <>
          <IconButton
            icon={Subtitles}
            label="Add subtitle file"
            size="sm"
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
          Join with camera & mic
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
  const mode = useWatchPartyStore((s) => s.mode);
  const urlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const on = active && mode === "native";
    document.documentElement.classList.toggle("wp-native", on);
    return () => document.documentElement.classList.remove("wp-native");
  }, [active, mode]);

  if (!active) return null;

  const isOwner = !!self && ownerId === self.identityId;
  const controller = selfIsController();
  const controllerName =
    controllerId === self?.identityId
      ? "You"
      : (contactsById[controllerId ?? ""]?.displayName ?? "Someone");

  return createPortal(
    <div className="fixed inset-0 z-40 flex flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border/40 bg-bg-base px-4">
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

      <Stage />

      <div className="flex shrink-0 flex-col gap-2 border-t border-border/40 bg-bg-primary px-4 py-3">
        {controller && (
          <div className="flex items-center gap-2">
            <input
              ref={urlRef}
              type="url"
              defaultValue={streamUrl ?? ""}
              placeholder="https://…/movie.mkv"
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
