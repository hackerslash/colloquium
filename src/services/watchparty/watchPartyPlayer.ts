/**
 * The playback abstraction for watch party. Video always renders into a plain
 * HTML <video> element, so there is one UI and one code path on every platform:
 * no native view embedding, no window compositing, no per-OS presentation code.
 *
 * Sources the webview can already decode are played directly. Anything else is
 * handed to a bundled ffmpeg sidecar and served back as HLS (see media.rs).
 * Either way, every position this module reports is on the *source* timeline,
 * which is what keeps watchPartySync.ts — and its tests — completely unaware of
 * how the bytes are actually being produced. A Mac remuxing and a Windows box
 * transcoding the same file stay in sync frame-for-frame because of it.
 */

import { invoke } from "@tauri-apps/api/core";
import type HlsType from "hls.js";
import {
  defaultAudioOrdinal,
  durationSec as probeDurationSec,
  isTextSubtitle,
  streamsOf,
  webviewCapabilities,
  type Probe,
  type ProbeStream,
} from "./codecSupport";
import { decidePlan, planLabel, type Plan } from "./mediaPlan";
import { assToVtt, looksLikeVtt, shiftVtt, srtToVtt } from "./vtt";

export type TrackInfo = {
  /** Ordinal *within its own type*, which is also what ffmpeg's `0:a:N` /
   * `0:s:N` selectors take. Never an absolute ffprobe stream index. */
  id: number;
  type: "video" | "audio" | "sub";
  title: string | null;
  lang: string | null;
  codec: string | null;
  selected: boolean;
  isDefault: boolean;
  /** False for bitmap subtitles (PGS, VOBSUB): they cannot become WebVTT, so
   * the UI greys them out instead of failing on selection. */
  supported: boolean;
};

export type WpEvent =
  | { kind: "time"; pos: number; tsMs: number }
  | { kind: "duration"; duration: number }
  | { kind: "pause"; paused: boolean }
  | { kind: "buffering"; pausedForCache: boolean; cachedSec: number; ready: boolean }
  | { kind: "tracks"; tracks: TrackInfo[] }
  | { kind: "subtitles"; loading: boolean; failed: boolean }
  | { kind: "eof" }
  | { kind: "error"; message: string };

export type PlayerMode = "html" | "none";
export type AudioTrackId = number | "no" | "auto";
export type SubTrackId = number | "no";

type Listener = (e: WpEvent) => void;

/** Dragging the scrubber emits a stream of seeks and each reopen is an ffmpeg
 * restart, so the last one in a burst is the only one that runs. */
const REOPEN_DEBOUNCE_MS = 250;
/** A correction this close to a reopen already under way is already being
 * served by it. */
const REOPEN_COALESCE_SEC = 2;
/** Fatal hls.js errors to attempt recovery from per window before reporting. */
const MAX_HLS_RECOVERIES = 3;

let mode: PlayerMode = "none";
const listeners = new Set<Listener>();
let htmlVideo: HTMLVideoElement | null = null;
let htmlDetach: (() => void) | null = null;

// True between a `waiting` and the next `playing`/`canplay` — i.e. the element
// has run dry. Tracked so the `progress` handler can report buffer growth
// without also claiming we're ready to play.
let stalled = false;

// Set when the engine refuses play() without a user gesture. Without this the
// follower just silently never starts and there is no signal anywhere.
let needsGesture = false;

// ---- ffmpeg pipeline state ------------------------------------------------

type OpenResult = { sessionId: string; token: string; port: number; srcUrl: string };
type WindowResult = { generation: number; playlistUrl: string; offsetSec: number };

let sessionId: string | null = null;
let probe: Probe | null = null;
let plan: Plan | null = null;
let hls: HlsType | null = null;
let sourceDurationSec = 0;
let audioOrdinal = 0;
let rate = 1;

/** Source-time of media-time 0 for the current window. Zero for direct play and
 * for a window starting at the beginning; otherwise the *probed* keyframe the
 * remux actually began on, which can be several seconds before what was asked
 * for. This appears in exactly four places — the `time` event, `now()`, `seek()`
 * and the assignment after a reopen — and nowhere else in the codebase. */
let offsetSec = 0;

/** Counted, not a flag: a second reopen can be scheduled while the first is
 * still awaiting ffmpeg, and a plain boolean would be cleared by whichever
 * finished first. */
let openCount = 0;
/** Identifies the newest window request, so a superseded one discards its
 * result instead of briefly attaching a stale window and offset. */
let openSeq = 0;
let reopenTimer: number | null = null;
let pendingTarget = 0;

type SubEntry = { label: string; lang: string | null; vtt: string };
/** Extracted/uploaded WebVTT by subtitle id. Ids below the embedded subtitle
 * count are stream ordinals; ids at or above it are user uploads. */
const subs = new Map<number, SubEntry>();
let currentSubId: SubTrackId = "no";
let subDelaySec = 0;
let subObjectUrl: string | null = null;

function emit(e: WpEvent) {
  for (const l of listeners) l(e);
}

function bufferedAhead(v: HTMLVideoElement): number {
  const b = v.buffered;
  for (let i = 0; i < b.length; i++) {
    if (b.start(i) <= v.currentTime && v.currentTime <= b.end(i)) {
      return Math.max(0, b.end(i) - v.currentTime);
    }
  }
  return 0;
}

/** True while a window is being (re)opened. `syncTick` skips its correction
 * entirely in this state — the element's `currentTime` means nothing yet, and
 * acting on it would provoke a second correction. */
export function busy(): boolean {
  return openCount > 0 || reopenTimer !== null;
}

/** True when the last play() was rejected for lack of a user gesture. */
export function awaitingGesture(): boolean {
  return needsGesture;
}

export function onPlayerEvent(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function playerMode(): PlayerMode {
  return mode;
}

/** How this source is being played, for a UI badge. Null before a plan exists. */
export function pipelineLabel(): string | null {
  return plan ? planLabel(plan) : null;
}

export function attachHtml(video: HTMLVideoElement): void {
  detachHtml();
  htmlVideo = video;
  mode = "html";
  const v = video;

  const onTime = () => {
    // Mid-reopen the element's clock belongs to no window in particular;
    // reporting it would write a bogus position into the session.
    if (busy()) return;
    emit({ kind: "time", pos: v.currentTime + offsetSec, tsMs: performance.now() });
  };
  const onDur = () => {
    // On a growing HLS playlist `video.duration` means "produced so far", which
    // would collapse the scrubber to the length of the remux. The authoritative
    // duration comes from ffprobe once, in load().
    if (plan && plan.container !== "direct") return;
    emit({ kind: "duration", duration: Number.isFinite(v.duration) ? v.duration : 0 });
  };
  const onPlay = () => emit({ kind: "pause", paused: false });
  const onPause = () => emit({ kind: "pause", paused: true });
  const onWaiting = () => {
    stalled = true;
    emit({ kind: "buffering", pausedForCache: true, cachedSec: bufferedAhead(v), ready: false });
  };
  const onReady = () => {
    stalled = false;
    emit({ kind: "buffering", pausedForCache: false, cachedSec: bufferedAhead(v), ready: true });
  };
  // Buffer growth without a readiness transition — this is what makes the
  // "is everyone ready" member beacon report a real number instead of 0.
  const onProgress = () =>
    emit({ kind: "buffering", pausedForCache: stalled, cachedSec: bufferedAhead(v), ready: !stalled });
  const onEnded = () => emit({ kind: "eof" });
  const onError = () => emit({ kind: "error", message: v.error?.message ?? "playback error" });

  v.addEventListener("timeupdate", onTime);
  v.addEventListener("durationchange", onDur);
  v.addEventListener("play", onPlay);
  v.addEventListener("pause", onPause);
  v.addEventListener("waiting", onWaiting);
  v.addEventListener("playing", onReady);
  v.addEventListener("canplay", onReady);
  v.addEventListener("progress", onProgress);
  v.addEventListener("ended", onEnded);
  v.addEventListener("error", onError);

  htmlDetach = () => {
    v.removeEventListener("timeupdate", onTime);
    v.removeEventListener("durationchange", onDur);
    v.removeEventListener("play", onPlay);
    v.removeEventListener("pause", onPause);
    v.removeEventListener("waiting", onWaiting);
    v.removeEventListener("playing", onReady);
    v.removeEventListener("canplay", onReady);
    v.removeEventListener("progress", onProgress);
    v.removeEventListener("ended", onEnded);
    v.removeEventListener("error", onError);
  };
}

function detachHtml() {
  htmlDetach?.();
  htmlDetach = null;
  htmlVideo = null;
}

// ---- loading -------------------------------------------------------------

function destroyHls() {
  if (!hls) return;
  hls.destroy();
  hls = null;
}

async function closeSession() {
  destroyHls();
  if (reopenTimer !== null) {
    window.clearTimeout(reopenTimer);
    reopenTimer = null;
  }
  const id = sessionId;
  sessionId = null;
  if (!id) return;
  try {
    await invoke("media_close", { sessionId: id });
  } catch {
    // Closing is best-effort: the session is dropped on the Rust side at exit
    // regardless, and failing here must not block a reload.
  }
}

function playDirect(url: string) {
  const v = htmlVideo;
  if (!v) return;
  destroyHls();
  offsetSec = 0;
  v.src = url;
  v.load();
}

export async function load(url: string): Promise<void> {
  await closeSession();
  needsGesture = false;
  stalled = false;
  offsetSec = 0;
  sourceDurationSec = 0;
  probe = null;
  plan = null;
  audioOrdinal = 0;
  rate = 1;
  subs.clear();
  currentSubId = "no";
  subDelaySec = 0;
  if (!htmlVideo) return;

  let opened: OpenResult;
  try {
    opened = await invoke<OpenResult>("media_open", { source: url });
    sessionId = opened.sessionId;
    probe = await invoke<Probe>("media_probe", { sessionId: opened.sessionId });
  } catch (err) {
    // The sidecar could not read the source. The webview may still manage it —
    // an HLS master playlist, or a host needing cookie/redirect handling ffmpeg
    // does not do — so hand it the URL untouched rather than refusing outright.
    console.warn("watch party: probe failed, falling back to direct playback", err);
    plan = { video: "copy", audio: "copy", container: "direct" };
    playDirect(url);
    return;
  }

  sourceDurationSec = probeDurationSec(probe);
  audioOrdinal = defaultAudioOrdinal(probe);
  plan = decidePlan(probe, webviewCapabilities(), audioOrdinal);
  emit({ kind: "duration", duration: sourceDurationSec });
  emit({ kind: "tracks", tracks: buildTracks() });

  if (plan.container === "direct") {
    // The webview fetches the remote URL itself here — its own TLS and HTTP/2
    // are better than proxying, and the session stays open only so embedded
    // subtitles can still be extracted.
    playDirect(url);
    return;
  }
  await openWindow(0);
}

/** Tears down the current ffmpeg and starts a new one at `startSec`. */
async function openWindow(startSec: number): Promise<void> {
  const v = htmlVideo;
  if (!v || !sessionId || !plan) return;
  const seq = ++openSeq;
  openCount += 1;
  pendingTarget = startSec;
  const resumePlaying = !v.paused;
  emit({ kind: "buffering", pausedForCache: true, cachedSec: 0, ready: false });
  // Torn down *before* the invoke, not after: opening a window kills the old
  // ffmpeg and deletes its segment directory, so an hls.js instance still
  // fetching from it would raise a fatal network error mid-reopen.
  destroyHls();
  try {
    const w = await invoke<WindowResult>("media_open_window", {
      sessionId,
      plan,
      startSec,
      audioStream: audioOrdinal,
    });
    if (seq !== openSeq) return;
    offsetSec = w.offsetSec;
    // A copied window begins on the keyframe at or before what we asked for, so
    // play in at the requested source position rather than the window's start.
    await attachHls(w.playlistUrl, Math.max(0, startSec - w.offsetSec), resumePlaying);
  } catch (err) {
    if (seq === openSeq) emit({ kind: "error", message: String(err) });
  } finally {
    openCount -= 1;
  }
}

async function attachHls(
  playlistUrl: string,
  startPosition: number,
  resumePlaying: boolean,
): Promise<void> {
  const v = htmlVideo;
  if (!v) return;
  destroyHls();
  // A direct-play source promoted to the remux path (the audio-track case)
  // still has the remote URL set; hls.js would be attaching over it.
  if (v.getAttribute("src")) {
    v.removeAttribute("src");
    v.load();
  }

  // Dynamically imported so hls.js costs nothing until a party actually needs a
  // remux, and bundled by Vite into our own chunk so `script-src 'self'` covers
  // it with no CSP change.
  const Hls = (await import("hls.js")).default;
  if (Hls.isSupported()) {
    const instance = new Hls({
      // Explicit, because a playlist without #EXT-X-ENDLIST is treated as live
      // and would otherwise start at whatever ffmpeg has reached.
      startPosition,
      enableWorker: true,
      // A multi-hour remux would otherwise accumulate the whole film in the
      // SourceBuffer. Seeking back further than this refetches from our own
      // loopback server, which is local disk.
      backBufferLength: 90,
    });
    // hls.js's documented fatal-error handling. Worth having because segments
    // arrive from a server that is still writing them, so a fatal-but-transient
    // error is a real possibility; giving up on the first one would strand
    // playback for good. Bounded, so a genuinely broken stream still reports.
    let recoveries = 0;
    instance.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      if (recoveries < MAX_HLS_RECOVERIES) {
        recoveries += 1;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          instance.startLoad();
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          instance.recoverMediaError();
          return;
        }
      }
      emit({ kind: "error", message: `${data.type}: ${data.details}` });
    });
    instance.loadSource(playlistUrl);
    instance.attachMedia(v);
    hls = instance;
  } else if (v.canPlayType("application/vnd.apple.mpegurl") !== "") {
    // Unreachable in practice: minimumSystemVersion 13.0 means WKWebView is
    // Safari 16.4+, which has MediaSource. Kept so a webview without MSE
    // degrades instead of showing a black stage.
    v.src = playlistUrl;
    v.load();
    if (startPosition > 0) {
      const seekOnce = () => {
        v.removeEventListener("loadedmetadata", seekOnce);
        v.currentTime = startPosition;
      };
      v.addEventListener("loadedmetadata", seekOnce);
    }
  } else {
    emit({ kind: "error", message: "this webview cannot play HLS" });
    return;
  }

  v.playbackRate = rate;
  applySubtitle();
  if (resumePlaying) void setPause(false);
}

// ---- transport -----------------------------------------------------------

export async function setPause(paused: boolean): Promise<void> {
  if (!htmlVideo) return;
  if (paused) {
    htmlVideo.pause();
    return;
  }
  try {
    await htmlVideo.play();
    needsGesture = false;
  } catch {
    // Autoplay was refused. Surface it so the UI can ask for a click, rather
    // than leaving the follower stuck on a black stage with no explanation.
    needsGesture = true;
    emit({ kind: "error", message: "autoplay-blocked" });
  }
}

/** True when `target` (source time) is inside what the current window has
 * produced, and so reachable by writing `currentTime`. */
function withinWindow(target: number): boolean {
  const v = htmlVideo;
  if (!v) return false;
  const local = target - offsetSec;
  if (local < 0) return false;
  const s = v.seekable;
  for (let i = 0; i < s.length; i++) {
    if (local >= s.start(i) && local <= s.end(i)) return true;
  }
  return false;
}

function scheduleReopen(target: number) {
  pendingTarget = target;
  // Reported immediately, so `session.ready` goes false and syncTick's existing
  // gate holds off corrections for the whole reopen.
  emit({ kind: "buffering", pausedForCache: true, cachedSec: 0, ready: false });
  if (reopenTimer !== null) window.clearTimeout(reopenTimer);
  reopenTimer = window.setTimeout(() => {
    reopenTimer = null;
    void openWindow(pendingTarget);
  }, REOPEN_DEBOUNCE_MS);
}

export async function seek(sec: number): Promise<void> {
  const v = htmlVideo;
  if (!v) return;
  // Clamped to the source: near the end, a follower's projected target can
  // overshoot the real duration, and reopening a window past EOF produces no
  // output at all — an error where there is nothing actually wrong.
  const target =
    sourceDurationSec > 0
      ? Math.min(Math.max(0, sec), Math.max(0, sourceDurationSec - 0.5))
      : Math.max(0, sec);
  if (!plan || plan.container === "direct") {
    v.currentTime = target;
    return;
  }
  // The common case by far: drift corrections fire twice a second and always
  // target a position a second or two away, which HLS has already segmented.
  // No ffmpeg is involved.
  if (withinWindow(target)) {
    v.currentTime = target - offsetSec;
    return;
  }
  if (busy() && Math.abs(target - pendingTarget) <= REOPEN_COALESCE_SEC) return;
  scheduleReopen(target);
}

export async function setSpeed(newRate: number): Promise<void> {
  rate = newRate;
  if (htmlVideo) htmlVideo.playbackRate = newRate;
}

export async function now(): Promise<{ pos: number; tsMs: number }> {
  return {
    // Mid-reopen the element's clock is meaningless; the position we are moving
    // to is the honest answer, and stops a stale reading provoking a second
    // correction.
    pos: busy() ? pendingTarget : (htmlVideo?.currentTime ?? 0) + offsetSec,
    tsMs: performance.now(),
  };
}

// ---- tracks --------------------------------------------------------------

function embeddedSubCount(): number {
  return probe ? streamsOf(probe, "subtitle").length : 0;
}

function labelFor(s: ProbeStream, fallback: string): string | null {
  return s.tags?.title ?? s.tags?.language ?? fallback;
}

function buildTracks(): TrackInfo[] {
  const out: TrackInfo[] = [];
  if (probe) {
    streamsOf(probe, "audio").forEach((s, i) => {
      out.push({
        id: i,
        type: "audio",
        title: labelFor(s, `Track ${i + 1}`),
        lang: s.tags?.language ?? null,
        codec: s.codec_name ?? null,
        selected: i === audioOrdinal,
        isDefault: s.disposition?.default === 1,
        supported: true,
      });
    });
    streamsOf(probe, "subtitle").forEach((s, i) => {
      out.push({
        id: i,
        type: "sub",
        title: labelFor(s, `Subtitle ${i + 1}`),
        lang: s.tags?.language ?? null,
        codec: s.codec_name ?? null,
        selected: currentSubId === i,
        isDefault: s.disposition?.default === 1,
        supported: isTextSubtitle(s.codec_name),
      });
    });
  }
  const embedded = embeddedSubCount();
  for (const [id, entry] of subs) {
    if (id < embedded) continue;
    out.push({
      id,
      type: "sub",
      title: entry.label,
      lang: entry.lang,
      codec: "webvtt",
      selected: currentSubId === id,
      isDefault: false,
      supported: true,
    });
  }
  return out;
}

export async function getTracks(): Promise<TrackInfo[]> {
  return buildTracks();
}

/**
 * Switching audio means a new generation: the mux carries exactly one audio
 * stream, so an ffmpeg restart is unavoidable. It is the same path as a far seek
 * — debounced, gated by `busy()` — so nothing new is needed to make it safe.
 */
export async function setAudioTrack(id: AudioTrackId): Promise<void> {
  if (!probe) return;
  const count = streamsOf(probe, "audio").length;
  if (count === 0) return;
  // "no" would mean muxing without audio at all; treated as "auto", since the
  // UI never offers it and a volume control already exists.
  const requested = id === "auto" || id === "no" ? defaultAudioOrdinal(probe) : id;
  const next = Math.min(Math.max(0, requested), count - 1);
  if (next === audioOrdinal) return;

  const resumeAt = busy() ? pendingTarget : (htmlVideo?.currentTime ?? 0) + offsetSec;
  audioOrdinal = next;
  // Direct play is off the table once a track has been chosen — no webview
  // exposes an audio-track API, so the selection can only be honoured by muxing
  // that one stream.
  plan = decidePlan(probe, webviewCapabilities(), audioOrdinal, false);
  emit({ kind: "tracks", tracks: buildTracks() });
  if (!sessionId) return;
  scheduleReopen(resumeAt);
}

/** Loads a subtitle's WebVTT if it isn't cached yet. */
async function ensureSubtitle(id: number): Promise<boolean> {
  if (subs.has(id)) return true;
  if (!sessionId || !probe) return false;
  const stream = streamsOf(probe, "subtitle")[id];
  if (!stream || !isTextSubtitle(stream.codec_name)) return false;
  // Cues are interleaved through the whole container, so collecting them means
  // reading the entire source — a minute and a half for a 1.6 GB film, longer
  // for a remux. Reported, because otherwise selecting a track looks like it did
  // nothing at all. Still done on first selection rather than at load: eagerly
  // extracting every track would download the source several times over before
  // playback started.
  emit({ kind: "subtitles", loading: true, failed: false });
  try {
    const vtt = await invoke<string>("media_extract_subtitle", {
      sessionId,
      streamIndex: id,
    });
    subs.set(id, {
      label: labelFor(stream, `Subtitle ${id + 1}`) ?? `Subtitle ${id + 1}`,
      lang: stream.tags?.language ?? null,
      vtt,
    });
    emit({ kind: "subtitles", loading: false, failed: false });
    return true;
  } catch (err) {
    // Deliberately not an `error` event: that paints the "couldn't be played"
    // overlay across a video that is playing perfectly well. The selection just
    // doesn't take, and the menu reverts to what is actually showing.
    console.warn("watch party: subtitle extraction failed", err);
    emit({ kind: "subtitles", loading: false, failed: true });
    return false;
  }
}

/**
 * Rebuilds the <track> element from the selected subtitle's raw cues. Pure DOM —
 * no ffmpeg, so followers match the controller with no reopen and no buffering
 * blip.
 *
 * Cues come out of the source on the *source* timeline, but a <track> is read
 * against `video.currentTime`, which for a remux window starts at zero however
 * far into the film the window began. So they are rebased by `offsetSec` as well
 * as by the user's delay — without it a window opened 20 minutes in puts every
 * subtitle 20 minutes in the future and none is ever seen. `offsetSec` is not
 * always zero even for a first window: a source whose packets start at 1.0s
 * gives a one-second window offset from the outset.
 */
function applySubtitle() {
  const v = htmlVideo;
  if (!v) return;
  for (const el of Array.from(v.querySelectorAll("track"))) el.remove();
  for (let i = 0; i < v.textTracks.length; i++) v.textTracks[i].mode = "disabled";
  if (subObjectUrl) {
    URL.revokeObjectURL(subObjectUrl);
    subObjectUrl = null;
  }
  if (currentSubId === "no") return;
  const entry = subs.get(currentSubId);
  if (!entry) return;

  const blob = new Blob([shiftVtt(entry.vtt, subDelaySec - offsetSec)], { type: "text/vtt" });
  subObjectUrl = URL.createObjectURL(blob);
  const el = document.createElement("track");
  el.kind = "subtitles";
  el.label = entry.label;
  if (entry.lang) el.srclang = entry.lang;
  el.src = subObjectUrl;
  el.default = true;
  v.appendChild(el);
  const added = v.textTracks[v.textTracks.length - 1];
  if (added) added.mode = "showing";
}

export async function setSubTrack(id: SubTrackId): Promise<void> {
  if (id === "no") {
    currentSubId = "no";
    applySubtitle();
    return;
  }
  if (!(await ensureSubtitle(id))) return;
  currentSubId = id;
  applySubtitle();
  emit({ kind: "tracks", tracks: buildTracks() });
}

export async function setSubDelay(sec: number): Promise<void> {
  if (sec === subDelaySec) return;
  subDelaySec = sec;
  applySubtitle();
}

/** Adds an external subtitle file and selects it, converting it to WebVTT first
 * — a blob of raw SubRip or ASS bytes is not parsed as captions by any engine.
 * Returns the id it was given, which the caller has to record: it is now the
 * showing track, and the wire snapshot must say so. */
export async function addSubtitle(name: string, bytes: Uint8Array): Promise<number | null> {
  if (!htmlVideo) return null;
  const text = new TextDecoder("utf-8").decode(bytes);
  let vtt: string;
  if (looksLikeVtt(text)) vtt = text;
  else if (/^\s*\[Script Info\]/i.test(text) || /\.(ass|ssa)$/i.test(name)) vtt = assToVtt(text);
  else vtt = srtToVtt(text);

  // Uploaded ids continue past the embedded subtitle streams so both kinds
  // share one id space on the wire.
  const id = Math.max(embeddedSubCount() - 1, ...subs.keys(), -1) + 1;
  subs.set(id, { label: name, lang: null, vtt });
  currentSubId = id;
  applySubtitle();
  emit({ kind: "tracks", tracks: buildTracks() });
  return id;
}

export function teardown(): Promise<void> {
  if (htmlVideo) {
    htmlVideo.pause();
    for (const el of Array.from(htmlVideo.querySelectorAll("track"))) el.remove();
    htmlVideo.removeAttribute("src");
    htmlVideo.load();
  }
  if (subObjectUrl) {
    URL.revokeObjectURL(subObjectUrl);
    subObjectUrl = null;
  }
  subs.clear();
  currentSubId = "no";
  subDelaySec = 0;
  probe = null;
  plan = null;
  offsetSec = 0;
  rate = 1;
  const closing = closeSession();
  detachHtml();
  mode = "none";
  needsGesture = false;
  stalled = false;
  return closing;
}
