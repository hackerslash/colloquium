import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * macOS-only bridge for native system-audio capture. WKWebView can't provide
 * display audio through getDisplayMedia, so the Rust side taps it with
 * ScreenCaptureKit (excluding Haven's own output, so the call doesn't echo)
 * and streams PCM here; we replay it into a MediaStream track that gets added
 * to the screen share. Everything degrades to null on failure — screen share
 * then just proceeds video-only.
 */

let audioCtx: AudioContext | null = null;
let workletNode: AudioWorkletNode | null = null;
let destination: MediaStreamAudioDestinationNode | null = null;
let channel: Channel<string> | null = null;

export function isMacOS(): boolean {
  const ua = navigator.userAgent;
  return ua.includes("Macintosh") || ua.includes("Mac OS");
}

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
export async function startSystemAudioTrack(): Promise<MediaStreamTrack | null> {
  if (!isMacOS()) return null;
  try {
    const ctx = new AudioContext({ sampleRate: 48_000 });
    await ctx.audioWorklet.addModule("/sysaudio-worklet.js");
    const node = new AudioWorkletNode(ctx, "haven-sysaudio", { outputChannelCount: [2] });
    const dest = ctx.createMediaStreamDestination();
    node.connect(dest);

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
    await stopSystemAudioTrack();
    return null;
  }
}

export async function stopSystemAudioTrack(): Promise<void> {
  try {
    await invoke("sysaudio_stop");
  } catch {
    // ignore — best effort
  }
  if (channel) channel.onmessage = () => {};
  workletNode?.port.postMessage("flush");
  workletNode?.disconnect();
  destination?.disconnect();
  if (audioCtx) await audioCtx.close().catch(() => {});
  audioCtx = null;
  workletNode = null;
  destination = null;
  channel = null;
}
