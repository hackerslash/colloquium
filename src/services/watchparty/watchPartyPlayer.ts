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
import {
  loadIframeApi,
  youtubeId,
  ytErrorText,
  YT_BUFFERING,
  YT_ENDED,
  YT_PAUSED,
  YT_PLAYING,
  type YtPlayer,
} from "./youtube";
import { READY_LEAD_SEC } from "./watchPartySync";
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
  | { kind: "buffering"; pausedForCache: boolean; ready: boolean }
  | { kind: "tracks"; tracks: TrackInfo[] }
  /** The source's own name, once the backend knows it. Null until then. */
  | { kind: "title"; title: string | null }
  /** `progress` is 0..1 through the source, or null when it isn't known yet. */
  | { kind: "subtitles"; loading: boolean; failed: boolean; progress: number | null }
  | { kind: "eof" }
  | { kind: "error"; message: string };

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
/** Lead required of a direct-play source before it counts as primed. The webview
 * buffers a plain <video> to its own internal limit, which is far below
 * READY_LEAD_SEC and cannot be raised from script, so requiring the full lead
 * there would block playback for good. */
const DIRECT_PRIME_SEC = 10;
/** How often to ask the sidecar how far a subtitle extraction has got. */
const EXTRACT_POLL_MS = 1_000;

const listeners = new Set<Listener>();
let htmlVideo: HTMLVideoElement | null = null;
let htmlDetach: (() => void) | null = null;

// True between a `waiting` and the next `playing`/`canplay` — i.e. the element
// has run dry. Tracked so the `progress` handler can report buffer growth
// without also claiming we're ready to play.
let stalled = false;

// ---- ffmpeg pipeline state ------------------------------------------------

type OpenResult = { sessionId: string };
type WindowResult = { playlistUrl: string; offsetSec: number };

let sessionId: string | null = null;
let probe: Probe | null = null;
let plan: Plan | null = null;
let hls: HlsType | null = null;
let sourceDurationSec = 0;
let audioOrdinal = 0;
let rate = 1;
let volume = 1;
let muted = false;

/** Source-time of media-time 0 for the current window. Zero for direct play and
 * for a window starting at the beginning; otherwise the *probed* keyframe the
 * remux actually began on, which can be several seconds before what was asked
 * for. */
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
/** True from a seek *we* asked for until it lands. hls.js also seeks on its own
 * to jump buffer gaps, and during one of those the element's clock is still the
 * truth — so `v.seeking` alone can't decide whether to trust it. */
let seekPending = false;
let loadCount = 0;

type SubEntry = { label: string; lang: string | null; vtt: string };
/** Extracted/uploaded WebVTT by subtitle id. Ids below the embedded subtitle
 * count are stream ordinals; ids at or above it are user uploads. */
const subs = new Map<number, SubEntry>();
let currentSubId: SubTrackId = "no";
let subDelaySec = 0;
let subObjectUrl: string | null = null;
/** Guards the progress poll: an `invoke` already in flight when the extraction
 * finishes would otherwise re-emit `loading` after the final event. */
let extracting = false;

function emit(e: WpEvent) {
  for (const l of listeners) l(e);
}

function aheadIn(ranges: TimeRanges, at: number): number {
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= at && at <= ranges.end(i)) {
      return Math.max(0, ranges.end(i) - at);
    }
  }
  return 0;
}

/**
 * How much footage is ready ahead of the playhead. For a remux this is what
 * ffmpeg has *written*, read from hls.js's playlist view: hls.js caps the
 * SourceBuffer far below it and MSE defines `seekable` in terms of that cap, so
 * `buffered`/`seekable` would peg the answer near the cap however far ahead the
 * window had really run. Direct play has no playlist, and nothing on local disk.
 */
function loadedAhead(v: HTMLVideoElement): number {
  if (plan && plan.container !== "direct") {
    const produced = hls?.levels?.[0]?.details?.fragmentEnd;
    if (typeof produced === "number" && produced > 0) {
      return Math.max(0, produced - v.currentTime);
    }
  }
  return aheadIn(v.buffered, v.currentTime);
}

export function busy(): boolean {
  // Between hosts there is no clock to report, and the controller must not
  // advertise the position it is frozen at as one that is still advancing.
  if (ytId) return loadCount > 0 || !yt;
  return loadCount > 0 || openCount > 0 || reopenTimer !== null;
}

/**
 * This peer's position on the *source* timeline. Between windows, and during a
 * seek we issued, the element's clock belongs to no position in particular, so
 * the position being moved to is reported instead.
 */
export function positionSec(): number {
  if (ytId) return yt ? yt.getCurrentTime() : ytPos;
  const v = htmlVideo;
  if (!v) return pendingTarget;
  if (busy() || (seekPending && v.seeking)) return pendingTarget;
  return v.currentTime + offsetSec;
}

/**
 * This peer's lead, and whether it is enough for the party to start. Polled, not
 * pushed: once the SourceBuffer is full hls.js stops fetching, so the element
 * goes quiet while the window carries on running ahead of it.
 *
 * `primed` is clamped against what is left of the source, so the final minute —
 * where the lead can never reach the target — does not block playback.
 */
export function readiness(): { leadSec: number; primed: boolean; needSec: number } {
  if (ytId) {
    // YouTube buffers to its own rules and reports one number for it. Treat a
    // ready player as primed: there is no knob to make it fetch further ahead,
    // so holding the party back on this lead would hold it back for good.
    const loaded = yt ? yt.getVideoLoadedFraction() * ytDuration : 0;
    const leadSec = Math.max(0, loaded - positionSec());
    return { leadSec, primed: !!yt, needSec: 0 };
  }
  const v = htmlVideo;
  if (!v) return { leadSec: 0, primed: false, needSec: READY_LEAD_SEC };
  const leadSec = loadedAhead(v);
  const direct = !plan || plan.container === "direct";
  const remaining =
    sourceDurationSec > 0 ? Math.max(0, sourceDurationSec - positionSec()) : Infinity;
  const needSec = Math.min(direct ? DIRECT_PRIME_SEC : READY_LEAD_SEC, remaining);
  if (busy() || (direct && stalled)) return { leadSec, primed: false, needSec };
  return { leadSec, primed: leadSec >= needSec, needSec };
}

export function onPlayerEvent(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** How this source is being played, for a UI badge. Null before a plan exists. */
export function pipelineLabel(): string | null {
  if (ytId) return "YouTube";
  return plan ? planLabel(plan) : null;
}

export function attachHtml(video: HTMLVideoElement): void {
  detachHtml();
  htmlVideo = video;
  const v = video;

  const onTime = () => {
    // Mid-reopen the element's clock belongs to no window in particular;
    // reporting it would write a bogus position into the session.
    if (busy()) return;
    emit({ kind: "time", pos: positionSec(), tsMs: performance.now() });
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
    emit({ kind: "buffering", pausedForCache: true, ready: false });
  };
  const onReady = () => {
    stalled = false;
    emit({ kind: "buffering", pausedForCache: false, ready: true });
  };
  const onSeeked = () => {
    seekPending = false;
  };
  const onEnded = () => emit({ kind: "eof" });
  const onError = () => emit({ kind: "error", message: v.error?.message ?? "playback error" });

  v.addEventListener("timeupdate", onTime);
  v.addEventListener("durationchange", onDur);
  v.addEventListener("play", onPlay);
  v.addEventListener("pause", onPause);
  v.addEventListener("waiting", onWaiting);
  v.addEventListener("playing", onReady);
  v.addEventListener("canplay", onReady);
  v.addEventListener("seeked", onSeeked);
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
    v.removeEventListener("seeked", onSeeked);
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

/** Leaves the <video> holding nothing: a source that has moved to the iframe
 * player, or a party that has ended, must not go on playing underneath. */
function stopHtml() {
  const v = htmlVideo;
  if (!v) return;
  v.pause();
  for (const el of Array.from(v.querySelectorAll("track"))) el.remove();
  v.removeAttribute("src");
  v.load();
}

function playDirect(url: string) {
  const v = htmlVideo;
  if (!v) return;
  destroyHls();
  offsetSec = 0;
  v.src = url;
  v.load();
  v.playbackRate = rate;
  v.volume = volume;
  v.muted = muted;
}

// ---- YouTube backend ------------------------------------------------------

/** The iframe player is its own decoder, buffer and clock: none of the ffmpeg
 * state above applies to it, so every entry point below branches on `ytId`
 * rather than trying to make one set of variables mean both. */
let ytId: string | null = null;
let yt: YtPlayer | null = null;
/** The element the UI has given us to draw in. An iframe reloads when it is
 * moved in the DOM, so audio mode hands over a different host and the player is
 * rebuilt in it at the position we already had. */
let ytHost: HTMLElement | null = null;
let ytPos = 0;
let ytPaused = true;
let ytDuration = 0;
let ytTimer: number | null = null;
/** Identifies the newest build request, so a host swapped mid-load discards the
 * player it was waiting on. */
let ytSeq = 0;

/** How often the position is read. The API has no timeupdate event, and the sync
 * loop corrects against this number twice a second. */
const YT_POLL_MS = 250;

/** Where the iframe player draws, or null when the UI has taken it away. Safe to
 * call before a YouTube source is loaded — the player is built when both a host
 * and a video id exist. */
export function attachYouTube(host: HTMLElement | null): void {
  if (host === ytHost) return;
  ytHost = host;
  if (!ytId) return;
  destroyYt();
  if (host) void buildYt(host, ytId, ytPos, !ytPaused);
}

function destroyYt(): void {
  ytSeq += 1;
  stopYtPoll();
  const p = yt;
  yt = null;
  if (!p) return;
  // A player that never finished loading carries none of the API yet, so both
  // calls throw on one — separately, because the iframe must still go.
  try {
    // Where the party is, for the player that takes this one's place.
    ytPos = p.getCurrentTime();
  } catch {
    // Nothing was played, so the position we already have stands.
  }
  try {
    p.destroy();
  } catch {
    // The iframe is going away with its host regardless.
  }
}

function stopYtPoll(): void {
  if (ytTimer === null) return;
  window.clearInterval(ytTimer);
  ytTimer = null;
}

function emitYtTitle(): void {
  const title = yt?.getVideoData()?.title?.trim();
  if (title) emit({ kind: "title", title });
}

async function buildYt(
  host: HTMLElement,
  videoId: string,
  startSec: number,
  autoplay: boolean,
): Promise<void> {
  const seq = ++ytSeq;
  let api;
  try {
    api = await loadIframeApi();
  } catch (err) {
    emit({ kind: "error", message: String((err as Error)?.message ?? err) });
    return;
  }
  if (seq !== ytSeq || ytHost !== host) return;
  emit({ kind: "buffering", pausedForCache: true, ready: false });
  // The API replaces the element it is given with the iframe, so it gets a child
  // of our own making — replacing the host itself would tear a node out from
  // under React.
  const mount = document.createElement("div");
  host.replaceChildren(mount);
  yt = new api.Player(mount, {
    videoId,
    width: "100%",
    height: "100%",
    playerVars: {
      autoplay: autoplay ? 1 : 0,
      // The party's own transport is the only control: YouTube's would move one
      // peer's playhead without telling the others.
      controls: 0,
      disablekb: 1,
      modestbranding: 1,
      rel: 0,
      playsinline: 1,
      iv_load_policy: 3,
      start: Math.floor(startSec),
    },
    events: {
      onReady: () => {
        if (seq !== ytSeq) return;
        applyYtVolume();
        yt?.setPlaybackRate(rate);
        // playerVars.start only takes whole seconds; the party's position is not
        // whole seconds.
        if (startSec > 0) yt?.seekTo(startSec, true);
        if (autoplay) yt?.playVideo();
        ytDuration = yt?.getDuration() ?? 0;
        if (ytDuration > 0) {
          sourceDurationSec = ytDuration;
          emit({ kind: "duration", duration: ytDuration });
        }
        emitYtTitle();
        // A cued player never reports PLAYING until someone plays it, and the
        // stage would spin over a picture that is simply waiting.
        emit({ kind: "buffering", pausedForCache: false, ready: true });
        stopYtPoll();
        ytTimer = window.setInterval(pollYt, YT_POLL_MS);
      },
      onStateChange: (e) => {
        if (seq !== ytSeq) return;
        switch (e.data) {
          case YT_PLAYING:
            ytPaused = false;
            emit({ kind: "pause", paused: false });
            emit({ kind: "buffering", pausedForCache: false, ready: true });
            emitYtTitle();
            break;
          case YT_PAUSED:
            ytPaused = true;
            emit({ kind: "pause", paused: true });
            break;
          case YT_BUFFERING:
            emit({ kind: "buffering", pausedForCache: true, ready: false });
            break;
          case YT_ENDED:
            emit({ kind: "eof" });
            break;
        }
      },
      onError: (e) => {
        if (seq !== ytSeq) return;
        emit({ kind: "error", message: ytErrorText(e.data) });
      },
    },
  });
}

function pollYt(): void {
  if (!yt) return;
  ytPos = yt.getCurrentTime();
  emit({ kind: "time", pos: ytPos, tsMs: performance.now() });
  const d = yt.getDuration();
  if (d > 0 && d !== ytDuration) {
    ytDuration = d;
    sourceDurationSec = d;
    emit({ kind: "duration", duration: d });
  }
}

function applyYtVolume(): void {
  if (!yt) return;
  yt.setVolume(Math.round(volume * 100));
  if (muted) yt.mute();
  else yt.unMute();
}

/** Plays a YouTube link through YouTube's own player. Nothing is probed,
 * remuxed or downloaded: the party is synchronised against the iframe's clock
 * exactly as it is against a <video>'s. */
function loadYouTube(videoId: string): void {
  ytId = videoId;
  ytPos = 0;
  ytPaused = true;
  ytDuration = 0;
  emit({ kind: "tracks", tracks: [] });
  if (ytHost) void buildYt(ytHost, videoId, 0, false);
}

export async function load(url: string): Promise<void> {
  loadCount += 1;
  try {
    await loadInner(url);
  } finally {
    loadCount -= 1;
  }
}

async function loadInner(url: string): Promise<void> {
  await closeSession();
  destroyYt();
  ytId = null;
  emit({ kind: "title", title: null });
  stalled = false;
  seekPending = false;
  offsetSec = 0;
  pendingTarget = 0;
  sourceDurationSec = 0;
  probe = null;
  plan = null;
  audioOrdinal = 0;
  rate = 1;
  subs.clear();
  currentSubId = "no";
  subDelaySec = 0;

  const videoId = youtubeId(url);
  if (videoId) {
    // The <video> keeps whatever it last played otherwise, and would go on
    // playing it underneath the iframe.
    stopHtml();
    loadYouTube(videoId);
    return;
  }
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
  emit({ kind: "buffering", pausedForCache: true, ready: false });
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
  if (ytId) {
    ytPaused = paused;
    if (paused) yt?.pauseVideo();
    else yt?.playVideo();
    return;
  }
  if (!htmlVideo) return;
  if (paused) {
    htmlVideo.pause();
    return;
  }
  try {
    await htmlVideo.play();
  } catch (err) {
    // Only a refusal means the user has to click. `play()` also rejects with
    // AbortError when a pause or load interrupts it, which happens routinely on
    // a reopen — reporting that would paint "click to start" over a stream that
    // is about to play by itself.
    if ((err as DOMException)?.name !== "NotAllowedError") return;
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
  seekPending = false;
  // Reported immediately, so the follower tick's `ready` gate holds off
  // corrections for the whole reopen.
  emit({ kind: "buffering", pausedForCache: true, ready: false });
  if (reopenTimer !== null) window.clearTimeout(reopenTimer);
  reopenTimer = window.setTimeout(() => {
    reopenTimer = null;
    void openWindow(pendingTarget);
  }, REOPEN_DEBOUNCE_MS);
}

export async function seek(sec: number): Promise<void> {
  if (ytId) {
    ytPos = Math.max(0, sec);
    yt?.seekTo(ytPos, true);
    return;
  }
  const v = htmlVideo;
  if (!v) return;
  // Clamped to the source: near the end, a follower's projected target can
  // overshoot the real duration, and reopening a window past EOF produces no
  // output at all — an error where there is nothing actually wrong.
  const target =
    sourceDurationSec > 0
      ? Math.min(Math.max(0, sec), Math.max(0, sourceDurationSec - 0.5))
      : Math.max(0, sec);
  // `pendingTarget` is set only on the paths that move the element, and only
  // after the coalesce check below — which compares against the reopen already
  // under way and would otherwise be comparing the target with itself.
  if (!plan || plan.container === "direct") {
    pendingTarget = target;
    seekPending = true;
    v.currentTime = target;
    return;
  }
  // The common case by far: drift corrections fire twice a second and always
  // target a position a second or two away, which HLS has already segmented.
  // No ffmpeg is involved.
  if (withinWindow(target)) {
    pendingTarget = target;
    seekPending = true;
    v.currentTime = target - offsetSec;
    return;
  }
  if (busy() && Math.abs(target - pendingTarget) <= REOPEN_COALESCE_SEC) return;
  scheduleReopen(target);
}

export async function setSpeed(newRate: number): Promise<void> {
  rate = newRate;
  if (ytId) {
    yt?.setPlaybackRate(newRate);
    return;
  }
  if (htmlVideo) htmlVideo.playbackRate = newRate;
}

/** Local, not party state: it is about this room, not about the film. Lives here
 * because which player is making the sound is this module's business. */
export function setVolume(nextVolume: number, nextMuted: boolean): void {
  volume = nextVolume;
  muted = nextMuted;
  if (ytId) {
    applyYtVolume();
    return;
  }
  if (htmlVideo) {
    htmlVideo.volume = nextVolume;
    htmlVideo.muted = nextMuted;
  }
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

/**
 * Switching audio means a new generation: the mux carries exactly one audio
 * stream, so an ffmpeg restart is unavoidable. It is the same path as a far seek
 * — debounced, gated by `busy()` — so nothing new is needed to make it safe.
 */
export async function setAudioTrack(id: AudioTrackId): Promise<void> {
  if (ytId) return;
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
  // Cues are interleaved through the container, so this reads the entire source:
  // ~90 s for a 1.6 GB film, minutes for a 4K one. Hence the progress reporting,
  // and hence doing it on first selection rather than at load — extracting every
  // track eagerly would download the source several times before playback.
  emit({ kind: "subtitles", loading: true, failed: false, progress: null });
  extracting = true;
  const poll = window.setInterval(() => {
    void pollExtractProgress();
  }, EXTRACT_POLL_MS);
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
    emit({ kind: "subtitles", loading: false, failed: false, progress: null });
    return true;
  } catch (err) {
    // Deliberately not an `error` event: that paints the "couldn't be played"
    // overlay across a video that is playing perfectly well. The selection just
    // doesn't take, and the menu reverts to what is actually showing.
    console.warn("watch party: subtitle extraction failed", err);
    emit({ kind: "subtitles", loading: false, failed: true, progress: null });
    return false;
  } finally {
    extracting = false;
    window.clearInterval(poll);
  }
}

async function pollExtractProgress(): Promise<void> {
  if (!sessionId || sourceDurationSec <= 0) return;
  try {
    const sec = await invoke<number>("media_extract_progress", { sessionId });
    if (!extracting) return;
    emit({
      kind: "subtitles",
      loading: true,
      failed: false,
      progress: Math.min(1, Math.max(0, sec / sourceDurationSec)),
    });
  } catch {
    // Progress is decoration; the extraction reports its own outcome.
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

/**
 * Selects a subtitle track, reporting whether it took. `extract` is false on a
 * follower: the controller extracts once and shares the cues, so a follower
 * without them waits rather than reading the whole source itself — that would be
 * N copies of a multi-gigabyte download over the links carrying the video.
 */
export async function setSubTrack(id: SubTrackId, extract = true): Promise<boolean> {
  if (id === "no") {
    currentSubId = "no";
    applySubtitle();
    return true;
  }
  if (!subs.has(id)) {
    if (!extract) return false;
    if (!(await ensureSubtitle(id))) return false;
  }
  currentSubId = id;
  applySubtitle();
  emit({ kind: "tracks", tracks: buildTracks() });
  return true;
}

/** Files cues extracted by another peer under the id they belong to, rather than
 * appending them as a fresh upload the way `addSubtitle` does. */
export function installSubtitle(
  id: number,
  label: string,
  lang: string | null,
  vtt: string,
): void {
  subs.set(id, { label, lang, vtt });
  if (currentSubId === id) applySubtitle();
  emit({ kind: "tracks", tracks: buildTracks() });
}

/** Cues for an extracted track, for the controller to share. */
export function subtitleVtt(id: SubTrackId): { label: string; lang: string | null; vtt: string } | null {
  if (id === "no") return null;
  return subs.get(id) ?? null;
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
  destroyYt();
  ytId = null;
  ytHost = null;
  stopHtml();
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
  pendingTarget = 0;
  seekPending = false;
  rate = 1;
  const closing = closeSession();
  detachHtml();
  stalled = false;
  return closing;
}
