import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * Bridge for native system-audio capture on macOS and Windows.
 *
 * getDisplayMedia's own audio path is unusable for a call: on macOS WKWebView
 * returns no audio at all, and on Windows it taps a whole-system loopback that
 * recaptures Haven's own playback of the other participants — sending their
 * voices back to them (echo). So the Rust side taps system audio natively,
 * EXCLUDING Haven's own audio (ScreenCaptureKit app-level filter exclusion on
 * macOS — the webview helper processes render the call audio, so excluding
 * just the current process isn't enough — WASAPI process-loopback exclude on
 * Windows), and streams PCM here;
 * we replay it into a MediaStream track that gets added to the screen share.
 * Everything degrades to null on failure — screen share then proceeds
 * video-only.
 */

let audioCtx: AudioContext | null = null;
let workletNode: AudioWorkletNode | null = null;
let destination: MediaStreamAudioDestinationNode | null = null;
let channel: Channel<string> | null = null;

// Serializes start/stop so a stop that races a subsequent start can neither
// tear down the new capture's audio graph nor let its native `sysaudio_stop`
// land after the new `sysaudio_start` and kill it.
let sysaudioOp: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = sysaudioOp.then(fn, fn);
  sysaudioOp = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function isMacOS(): boolean {
  const ua = navigator.userAgent;
  return ua.includes("Macintosh") || ua.includes("Mac OS");
}

function isWindows(): boolean {
  return navigator.userAgent.includes("Windows");
}

/** Platforms where display audio is captured natively (Rust `sysaudio_*`)
 * instead of via getDisplayMedia, so the app's own output is excluded and a
 * call doesn't echo its own participants back. */
export function usesNativeSystemAudio(): boolean {
  return isMacOS() || isWindows();
}

/** macOS re-prompts for Accessibility/Screen Recording on every launch when the
 * .app is still quarantined (App Translocation runs it from a random path each
 * time, so a TCC grant never matches). The one-time fix is to un-quarantine it.
 * Appended wherever a macOS permission wall is hit so users aren't stuck
 * re-granting. */
export const MACOS_QUARANTINE_HINT =
  " If macOS keeps re-asking after you grant it, the app is quarantined: move Haven to /Applications and run `xattr -cr /Applications/Haven.app` once.";

function base64ToFloat32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // Interleaved stereo i16 LE (desktop platforms are little-endian).
  const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  return f32;
}

/** Starts native capture and returns a live system-audio track, or null if
 * unsupported / unavailable. */
export function startSystemAudioTrack(): Promise<MediaStreamTrack | null> {
  if (!usesNativeSystemAudio()) return Promise.resolve(null);
  return serialize(startSystemAudioTrackInner);
}

async function startSystemAudioTrackInner(): Promise<MediaStreamTrack | null> {
  try {
    const ctx = new AudioContext({ sampleRate: 48_000 });
    await ctx.audioWorklet.addModule("/sysaudio-worklet.js");
    const node = new AudioWorkletNode(ctx, "haven-sysaudio", { outputChannelCount: [2] });
    const dest = ctx.createMediaStreamDestination();
    node.connect(dest);

    // The context must be pulling audio BEFORE native capture starts posting
    // chunks — anything buffered while it's suspended becomes standing
    // latency behind the shared video (the worklet's governor would cut it,
    // but better to never build it).
    if (ctx.state !== "running") await ctx.resume().catch(() => {});

    const ch = new Channel<string>();
    ch.onmessage = (b64) => {
      const f32 = base64ToFloat32(b64);
      node.port.postMessage(f32, [f32.buffer]);
    };

    await invoke("sysaudio_start", { channel: ch });

    audioCtx = ctx;
    workletNode = node;
    destination = dest;
    channel = ch;
    return dest.stream.getAudioTracks()[0] ?? null;
  } catch (err) {
    console.warn("[systemAudio] native capture unavailable:", err);
    await stopSystemAudioTrackInner();
    return null;
  }
}

export function stopSystemAudioTrack(): Promise<void> {
  return serialize(stopSystemAudioTrackInner);
}

async function stopSystemAudioTrackInner(): Promise<void> {
  // Detach the module singletons up front so a start racing this stop installs
  // fresh state that we won't then tear down out from under it.
  const ctx = audioCtx;
  const node = workletNode;
  const dest = destination;
  const ch = channel;
  audioCtx = null;
  workletNode = null;
  destination = null;
  channel = null;

  if (ch) ch.onmessage = () => {};
  try {
    await invoke("sysaudio_stop");
  } catch {
    // ignore — best effort
  }
  node?.port.postMessage("flush");
  node?.disconnect();
  dest?.disconnect();
  if (ctx) await ctx.close().catch(() => {});
}
