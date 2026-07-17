import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";

/**
 * ML noise suppression (RNNoise) for the outgoing microphone.
 *
 * The platform's built-in `noiseSuppression` constraint is mild — it leaves
 * steady background noise (a fan, an AC) audible — and the stronger
 * `voiceIsolation` constraint only exists on WKWebView/Safari, so on Windows
 * WebView2 nothing removes it. RNNoise runs in an AudioWorklet and works
 * identically on every platform.
 *
 * Graph: MediaStreamSource(raw mic) → RnnoiseWorkletNode → MediaStreamDestination.
 * The destination's track is what we transmit; the raw mic track stays the
 * capture source (and the thing mute toggles, which silences the input).
 *
 * Everything is best-effort: if the wasm/worklet can't load, the caller falls
 * back to the raw mic track, so a call never breaks just because RNNoise is
 * unavailable — it just isn't noise-suppressed.
 */

export type MicProcessor = {
  /** The processed audio track to transmit in place of the raw mic track. */
  track: MediaStreamTrack;
  /** Enable/disable RNNoise live WITHOUT changing the output track identity, so
   * toggling the setting mid-call needs no renegotiation. */
  setEnabled(on: boolean): void;
  /** Tear down the graph and close the AudioContext. Does NOT stop the raw
   * source track — the caller owns that. */
  dispose(): Promise<void>;
};

// The wasm binary is fetched once and reused across calls.
let wasmBinaryPromise: Promise<ArrayBuffer> | null = null;
function getWasmBinary(): Promise<ArrayBuffer> {
  if (!wasmBinaryPromise) {
    wasmBinaryPromise = loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
  }
  return wasmBinaryPromise;
}

export async function createMicProcessor(
  rawTrack: MediaStreamTrack,
  enabled: boolean,
): Promise<MicProcessor | null> {
  let ctx: AudioContext | null = null;
  try {
    const wasmBinary = await getWasmBinary();
    // RNNoise assumes 48 kHz — pin the context so the worklet gets it directly.
    ctx = new AudioContext({ sampleRate: 48_000 });
    if (ctx.state !== "running") await ctx.resume().catch(() => {});
    await ctx.audioWorklet.addModule(rnnoiseWorkletUrl);

    const source = ctx.createMediaStreamSource(new MediaStream([rawTrack]));
    const node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
    const dest = ctx.createMediaStreamDestination();

    let currentlyEnabled = false;
    const routeThroughRnnoise = () => {
      source.disconnect();
      node.disconnect();
      source.connect(node);
      node.connect(dest);
      currentlyEnabled = true;
    };
    const routeBypass = () => {
      source.disconnect();
      node.disconnect();
      source.connect(dest);
      currentlyEnabled = false;
    };
    if (enabled) routeThroughRnnoise();
    else routeBypass();

    const track = dest.stream.getAudioTracks()[0];
    if (!track) {
      await ctx.close().catch(() => {});
      return null;
    }
    // Opus optimizes for voice when the track is hinted as speech.
    try {
      track.contentHint = "speech";
    } catch {
      // contentHint is advisory
    }

    const activeCtx = ctx;
    return {
      track,
      setEnabled(on: boolean) {
        if (on === currentlyEnabled) return;
        if (on) routeThroughRnnoise();
        else routeBypass();
      },
      async dispose() {
        try {
          node.destroy();
        } catch {
          // best effort
        }
        try {
          source.disconnect();
          node.disconnect();
          dest.disconnect();
        } catch {
          // best effort
        }
        await activeCtx.close().catch(() => {});
      },
    };
  } catch (err) {
    console.warn("[noiseSuppressor] RNNoise unavailable, using raw mic:", err);
    if (ctx) await ctx.close().catch(() => {});
    return null;
  }
}
