import { useSettingsStore } from "../../stores/useSettingsStore";

/**
 * Shared microphone acquisition/processing config for the 1:1 and room call
 * services, driven by the user's voice settings:
 *   - noiseSuppression: the platform's standard noise reduction (default on).
 *     Strong ML suppression is layered on top by the RNNoise processor (see
 *     noiseSuppressor.ts) and gated by this same setting; the built-in
 *     constraint stays as a baseline and as the fallback when RNNoise can't
 *     load.
 * Echo cancellation and auto gain stay unconditionally on: turning either off
 * audibly breaks calls, so they're not user-facing knobs.
 */

export function buildMicConstraints(): MediaTrackConstraints {
  const { noiseSuppression } = useSettingsStore.getState();
  return {
    echoCancellation: true,
    autoGainControl: true,
    noiseSuppression,
  };
}

/** Marks a stream's audio tracks as speech so the Opus encoder optimizes for
 * voice rather than general audio. */
export function markVoiceTracks(stream: MediaStream): void {
  for (const track of stream.getAudioTracks()) {
    try {
      track.contentHint = "speech";
    } catch {
      // contentHint is advisory
    }
  }
}

/** Re-applies the current voice settings to a live mic stream, so toggling
 * noise suppression / voice isolation mid-call takes effect immediately.
 * Best-effort: platforms that can't reconfigure a live track keep the settings
 * the track was captured with (they still apply on the next call). */
export async function applyMicProcessing(stream: MediaStream | null | undefined): Promise<void> {
  if (!stream) return;
  const constraints = buildMicConstraints();
  for (const track of stream.getAudioTracks()) {
    try {
      await track.applyConstraints(constraints);
    } catch {
      // applyConstraints on a live mic can be rejected (e.g. WKWebView)
    }
  }
}
