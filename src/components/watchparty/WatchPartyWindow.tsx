import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AudioLines,
  Crown,
  Film,
  LogOut,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Subtitles,
  Users,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useWatchPartyStore, selfIsController } from "../../stores/useWatchPartyStore";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { useRosterStore } from "../../stores/useRosterStore";
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
import { enterFullscreen, exitFullscreen } from "../../lib/fullscreen";
import { formatClock } from "../../lib/time";
import { cx } from "../../lib/cx";

/** How long the pointer must rest before the chrome gets out of the way. */
const IDLE_MS = 2_600;
/** Long enough to tell a click from the first half of a double click. Short
 * enough that click-to-pause doesn't feel laggy. */
const DOUBLE_CLICK_MS = 220;
const SKIP_SEC = 10;
const ARROW_SEC = 5;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/**
 * The film. Everything drawn here sits on black in both themes, so its text is
 * light-on-dark rather than token-themed — `text-text-primary` would be near
 * black in Day theme and vanish. Panels (inputs, menus) keep their theme
 * surfaces, because they are surfaces.
 */
function Stage({
  videoRef,
  onStageClick,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onStageClick: (e: React.MouseEvent) => void;
}) {
  const streamUrl = useWatchPartyStore((s) => s.streamUrl);
  const buffering = useWatchPartyStore((s) => s.buffering);
  const error = useWatchPartyStore((s) => s.error);
  const controllerId = useWatchPartyStore((s) => s.controllerId);
  const setStreamUrl = useWatchPartyStore((s) => s.setStreamUrl);
  const self = useIdentityStore((s) => s.self);
  const contactsById = useRosterStore((s) => s.contactsById);
  const controller = selfIsController();
  const urlRef = useRef<HTMLInputElement>(null);
  // How the source is being played ("Remuxing", "Transcoding"…), which is what
  // explains a slow start.
  const [pipeline, setPipeline] = useState<string | null>(null);

  // Attach once, before the load effect below runs.
  useEffect(() => {
    if (!videoRef.current) return;
    player.attachHtml(videoRef.current);
    useWatchPartyStore.getState()._setMode("html");
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

      {buffering && !blocked && !error && (
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
          {/* The one enrichment design.md allows on an empty state. */}
          <div
            aria-hidden="true"
            className="absolute h-64 w-64 rounded-full opacity-40 blur-3xl"
            style={{
              background: "radial-gradient(circle, var(--color-accent) 0%, transparent 70%)",
            }}
          />
          <p className="font-display relative text-2xl text-white">Nothing playing yet</p>
          {controller ? (
            <div className="relative flex w-full max-w-lg items-center gap-2">
              <input
                ref={urlRef}
                type="url"
                placeholder="https://…/movie.mkv"
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
            <p className="relative text-sm text-white/55">
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
  const self = useIdentityStore((s) => s.self);
  const contactsById = useRosterStore((s) => s.contactsById);

  const shown = members.slice(0, 5);
  const overflow = members.length - shown.length;

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center">
        {shown.map((m) => {
          const name =
            m.id === self?.identityId
              ? (self?.displayName ?? "You")
              : (contactsById[m.id]?.displayName ?? "Guest");
          const isController = m.id === controllerId;
          return (
            <Tooltip
              key={m.id}
              side="bottom"
              label={`${name}${isController ? " · controlling" : ""} · ${
                m.ready ? `${Math.round(m.bufferedSec)}s buffered` : "buffering"
              }`}
            >
              <span
                className={cx(
                  "-mr-1.5 inline-flex rounded-full p-0.5 ring-2 last:mr-0",
                  m.ready ? "ring-accent/70" : "ring-white/25",
                  isController && "z-10",
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

export function WatchPartyWindow() {
  const active = useWatchPartyStore((s) => s.active);
  const streamUrl = useWatchPartyStore((s) => s.streamUrl);
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
  const [railPinned, setRailPinned] = useState(true);

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
    const v = videoRef.current;
    if (!v) return;
    v.muted = muted;
    v.volume = volume;
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

  if (!active) return null;

  const isOwner = !!self && ownerId === self.identityId;
  const controllerName =
    controllerId === self?.identityId
      ? "You"
      : (contactsById[controllerId ?? ""]?.displayName ?? "Someone");

  // Chrome stays up while paused, while there is nothing to watch, and while the
  // pointer or focus is inside it — hiding a menu mid-interaction is hostile.
  const chromeShown = !idle || paused || !streamUrl || holdChrome || sourceOpen;
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

  return createPortal(
    <div
      ref={rootRef}
      className={cx("fixed inset-0 z-40 bg-black", !chromeShown && "cursor-none")}
      onPointerMove={wake}
      onPointerDown={wake}
    >
      <Stage videoRef={videoRef} onStageClick={onStageClick} />

      <PresenceRail roomId={roomId} visible={railPinned || chromeShown} />

      <div
        onPointerEnter={() => setHoldChrome(true)}
        onPointerLeave={() => setHoldChrome(false)}
        onFocus={() => setHoldChrome(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setHoldChrome(false);
        }}
        className={cx(
          "pointer-events-none absolute inset-0 z-20 flex flex-col justify-between transition-opacity duration-200 motion-reduce:transition-none",
          chromeShown ? "opacity-100" : "opacity-0",
        )}
      >
        {/* Session — who is here, who is driving, how to get out. */}
        <header className="pointer-events-auto flex flex-col gap-2 bg-gradient-to-b from-black/75 to-transparent px-4 pt-3 pb-10">
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 items-center gap-3 overflow-hidden">
              <span className="flex shrink-0 items-center gap-2 text-sm font-semibold text-white">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
                Watch party
              </span>
              <ChromeChip>
                {members.length === 1 ? "Just you" : `${members.length} watching`}
              </ChromeChip>
              <PartyPresence />
              <ChromeChip tone={controller ? "accent" : "neutral"}>
                {controller ? "You control playback" : `${controllerName} is controlling`}
              </ChromeChip>
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-1.5">
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
            </div>
          </div>

          {sourceOpen && (
            <div className="flex max-w-2xl items-center gap-2">
              <input
                ref={sourceRef}
                type="url"
                defaultValue={streamUrl ?? ""}
                placeholder="https://…/movie.mkv"
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
        </header>

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
                      <p className="text-xs leading-relaxed text-text-muted">
                        Reading subtitles out of the source — the first time a track is picked
                        this takes a pass over the whole file.
                      </p>
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

              <ChromeButton
                icon={Users}
                label={railPinned ? "Hide cameras" : "Keep cameras visible"}
                onClick={() => setRailPinned((p) => !p)}
                className={cx(railPinned && "bg-white/15 text-white")}
              />
              <ChromeButton
                icon={fullscreen ? Minimize : Maximize}
                label={fullscreen ? "Exit full screen" : "Full screen"}
                onClick={toggleFullscreen}
              />
            </div>
          </div>
        </div>
      </div>

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
