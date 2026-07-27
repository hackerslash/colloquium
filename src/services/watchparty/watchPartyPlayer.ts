// watchPartyPlayer.ts
// The playback abstraction for watch party. Video always renders into a plain
// HTML <video> element, so there is one UI and one code path on every platform:
// no native view embedding, no window compositing, no per-OS presentation code.
//
// Sources the webview can already decode are played directly. Anything else is
// handed to a bundled ffmpeg sidecar and served back as HLS (see media.rs); that
// path is added in a later phase. Either way, every position this module reports
// is on the *source* timeline, which is what keeps watchPartySync.ts — and its
// tests — completely unaware of how the bytes are actually being produced.

export type TrackInfo = {
  id: number;
  type: "video" | "audio" | "sub";
  title: string | null;
  lang: string | null;
  codec: string | null;
  selected: boolean;
  isDefault: boolean;
};

export type WpEvent =
  | { kind: "time"; pos: number; tsMs: number }
  | { kind: "duration"; duration: number }
  | { kind: "pause"; paused: boolean }
  | { kind: "buffering"; pausedForCache: boolean; cachedSec: number; ready: boolean }
  | { kind: "tracks"; tracks: TrackInfo[] }
  | { kind: "eof" }
  | { kind: "error"; message: string };

// "html" once a <video> element is attached, "none" before that.
export type PlayerMode = "html" | "none";
export type AudioTrackId = number | "no" | "auto";
export type SubTrackId = number | "no";

type Listener = (e: WpEvent) => void;

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

function emit(e: WpEvent) {
  for (const l of listeners) l(e);
}

/** Seconds of contiguous buffered media ahead of the playhead. */
function bufferedAhead(v: HTMLVideoElement): number {
  const b = v.buffered;
  for (let i = 0; i < b.length; i++) {
    if (b.start(i) <= v.currentTime && v.currentTime <= b.end(i)) {
      return Math.max(0, b.end(i) - v.currentTime);
    }
  }
  return 0;
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

export function attachHtml(video: HTMLVideoElement): void {
  detachHtml();
  htmlVideo = video;
  mode = "html";
  const v = video;

  const onTime = () => emit({ kind: "time", pos: v.currentTime, tsMs: performance.now() });
  const onDur = () =>
    emit({ kind: "duration", duration: Number.isFinite(v.duration) ? v.duration : 0 });
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

export async function load(url: string): Promise<void> {
  needsGesture = false;
  stalled = false;
  if (htmlVideo) {
    htmlVideo.src = url;
    htmlVideo.load();
  }
}

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

export async function seek(sec: number): Promise<void> {
  if (htmlVideo) htmlVideo.currentTime = Math.max(0, sec);
}

export async function setSpeed(rate: number): Promise<void> {
  if (htmlVideo) htmlVideo.playbackRate = rate;
}

// Audio/subtitle track switching needs the ffmpeg path to be meaningful (the
// webview exposes no audio-track API in Chromium). No-ops until then.
export async function setAudioTrack(_id: AudioTrackId): Promise<void> {}
export async function setSubTrack(_id: SubTrackId): Promise<void> {}
export async function setSubDelay(_sec: number): Promise<void> {}

// Subtitle file upload: inject as a <track> element with a blob URL.
export async function addSubtitle(name: string, bytes: Uint8Array): Promise<void> {
  if (!htmlVideo) return;
  const blob = new Blob([bytes], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const track = document.createElement("track");
  track.kind = "subtitles";
  track.label = name;
  track.src = url;
  track.default = true;
  htmlVideo.appendChild(track);
  // Show the newly added track.
  if (htmlVideo.textTracks.length > 0) {
    htmlVideo.textTracks[htmlVideo.textTracks.length - 1].mode = "showing";
  }
}

// A bare <video> exposes no structured track metadata. Returns an empty list for
// now; it becomes real once ffprobe supplies the stream list. The TrackMenus
// component hides itself while this is empty.
export async function getTracks(): Promise<TrackInfo[]> {
  return [];
}

export async function now(): Promise<{ pos: number; tsMs: number }> {
  return {
    pos: htmlVideo?.currentTime ?? 0,
    tsMs: performance.now(),
  };
}

export function teardown(): Promise<void> {
  if (htmlVideo) {
    htmlVideo.pause();
    htmlVideo.removeAttribute("src");
    htmlVideo.load();
  }
  detachHtml();
  mode = "none";
  needsGesture = false;
  stalled = false;
  return Promise.resolve();
}
