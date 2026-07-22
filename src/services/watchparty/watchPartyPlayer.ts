import { Channel, invoke } from "@tauri-apps/api/core";

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

export type PlayerMode = "native" | "html" | "none";
export type StageRect = { x: number; y: number; w: number; h: number; dpr: number };
export type AudioTrackId = number | "no" | "auto";
export type SubTrackId = number | "no";

type Listener = (e: WpEvent) => void;

let mode: PlayerMode = "none";
const listeners = new Set<Listener>();
let nativeChannel: Channel<WpEvent> | null = null;
let htmlVideo: HTMLVideoElement | null = null;
let htmlDetach: (() => void) | null = null;
let availableCache: boolean | null = null;

function emit(e: WpEvent) {
  for (const l of listeners) l(e);
}

export function onPlayerEvent(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function playerMode(): PlayerMode {
  return mode;
}

export async function probeNativeAvailable(): Promise<boolean> {
  if (availableCache !== null) return availableCache;
  try {
    availableCache = await invoke<boolean>("wp_player_available");
  } catch {
    availableCache = false;
  }
  return availableCache;
}

let op: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = op.then(fn, fn);
  op = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function initNative(): Promise<boolean> {
  return serialize(async () => {
    const ch = new Channel<WpEvent>();
    ch.onmessage = (e) => emit(e);
    try {
      await invoke("wp_player_init", { channel: ch });
      nativeChannel = ch;
      mode = "native";
      return true;
    } catch (err) {
      console.warn("[watchParty] native player init failed:", err);
      nativeChannel = null;
      mode = "none";
      return false;
    }
  });
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
  const onWaiting = () =>
    emit({ kind: "buffering", pausedForCache: true, cachedSec: 0, ready: false });
  const onPlaying = () =>
    emit({ kind: "buffering", pausedForCache: false, cachedSec: 0, ready: true });
  const onEnded = () => emit({ kind: "eof" });
  const onError = () => emit({ kind: "error", message: v.error?.message ?? "playback error" });
  v.addEventListener("timeupdate", onTime);
  v.addEventListener("durationchange", onDur);
  v.addEventListener("play", onPlay);
  v.addEventListener("pause", onPause);
  v.addEventListener("waiting", onWaiting);
  v.addEventListener("playing", onPlaying);
  v.addEventListener("ended", onEnded);
  v.addEventListener("error", onError);
  htmlDetach = () => {
    v.removeEventListener("timeupdate", onTime);
    v.removeEventListener("durationchange", onDur);
    v.removeEventListener("play", onPlay);
    v.removeEventListener("pause", onPause);
    v.removeEventListener("waiting", onWaiting);
    v.removeEventListener("playing", onPlaying);
    v.removeEventListener("ended", onEnded);
    v.removeEventListener("error", onError);
  };
}

function detachHtml() {
  htmlDetach?.();
  htmlDetach = null;
  htmlVideo = null;
}

export function load(url: string): Promise<void> {
  return serialize(async () => {
    if (mode === "native") {
      await invoke("wp_player_load", { url });
    } else if (mode === "html" && htmlVideo) {
      htmlVideo.src = url;
      htmlVideo.load();
    }
  });
}

export async function setPause(paused: boolean): Promise<void> {
  if (mode === "native") {
    await invoke("wp_player_set_pause", { paused });
  } else if (mode === "html" && htmlVideo) {
    if (paused) htmlVideo.pause();
    else await htmlVideo.play().catch(() => {});
  }
}

export async function seek(sec: number): Promise<void> {
  if (mode === "native") await invoke("wp_player_seek", { secs: sec });
  else if (mode === "html" && htmlVideo) htmlVideo.currentTime = Math.max(0, sec);
}

export async function setSpeed(rate: number): Promise<void> {
  if (mode === "native") await invoke("wp_player_set_speed", { x: rate });
  else if (mode === "html" && htmlVideo) htmlVideo.playbackRate = rate;
}

export async function setAudioTrack(id: AudioTrackId): Promise<void> {
  if (mode === "native") await invoke("wp_player_set_audio_track", { id });
}

export async function setSubTrack(id: SubTrackId): Promise<void> {
  if (mode === "native") await invoke("wp_player_set_sub_track", { id });
}

export async function setSubDelay(sec: number): Promise<void> {
  if (mode === "native") await invoke("wp_player_set_sub_delay", { secs: sec });
}

export async function addSubtitle(name: string, bytes: Uint8Array): Promise<void> {
  if (mode === "native") await invoke("wp_player_add_subtitle", { name, bytes: Array.from(bytes) });
}

export async function getTracks(): Promise<TrackInfo[]> {
  if (mode === "native") return (await invoke<TrackInfo[]>("wp_player_get_tracks")) ?? [];
  return [];
}

export async function now(): Promise<{ pos: number; tsMs: number }> {
  if (mode === "native") {
    return await invoke<{ pos: number; tsMs: number }>("wp_player_now");
  }
  if (mode === "html" && htmlVideo) return { pos: htmlVideo.currentTime, tsMs: performance.now() };
  return { pos: 0, tsMs: performance.now() };
}

export function setStageRect(rect: StageRect): void {
  if (mode === "native") void invoke("wp_player_set_rect", { rect }).catch(() => {});
}

export function teardown(): Promise<void> {
  return serialize(async () => {
    if (mode === "native") {
      if (nativeChannel) nativeChannel.onmessage = () => {};
      nativeChannel = null;
      try {
        await invoke("wp_player_teardown");
      } catch {
        // best effort
      }
    } else if (mode === "html" && htmlVideo) {
      htmlVideo.pause();
      htmlVideo.removeAttribute("src");
      htmlVideo.load();
    }
    detachHtml();
    mode = "none";
  });
}
