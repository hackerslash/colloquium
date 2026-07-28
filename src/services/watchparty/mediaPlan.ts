/**
 * Decides how a source becomes pixels: play it as-is, remux it, or re-encode it.
 * Pure — probe in, plan out — so every combination is unit-testable, in the same
 * spirit as watchPartySync.ts.
 */

import {
  audioCodecString,
  defaultAudioOrdinal,
  directMime,
  primaryVideo,
  streamsOf,
  videoCodecString,
  type Capabilities,
  type Probe,
} from "./codecSupport";

export type StreamMode = "copy" | "encode";

export type Plan = {
  video: StreamMode;
  audio: StreamMode;
  container: "direct" | "hls";
};

/**
 * Video and audio are decided independently, because the most common real case
 * is one needing work and the other not. HEVC video with DTS audio is
 * `copy`/`encode` on a Mac and `encode`/`encode` on a Windows box without the
 * HEVC extension; H.264 with AC3 in an MKV — the next most common — needs no
 * video encoding on either.
 *
 * `audioOrdinal` is the audio stream that will actually be played, since the
 * decision depends on that track's codec: switching from an AAC track to a DTS
 * one on the same file changes the plan.
 *
 * `allowDirect` is cleared when the direct path cannot serve the request even
 * though the engine could play the file — switching audio track is the only such
 * case, since no webview exposes an audio-track API.
 */
export function decidePlan(
  probe: Probe,
  caps: Capabilities,
  audioOrdinal = defaultAudioOrdinal(probe),
  allowDirect = true,
): Plan {
  const video = primaryVideo(probe);
  const audio = streamsOf(probe, "audio")[audioOrdinal];

  const videoCodec = videoCodecString(video);
  const audioCodec = audioCodecString(audio);

  // Direct play: hand the untouched URL to <video> and spawn no ffmpeg at all.
  // Requires the container itself to be playable, so it is asked as one question
  // — an engine can support H.264 and AAC and still not open the container
  // they arrived in.
  const mime = allowDirect ? directMime(probe) : null;
  if (mime) {
    const codecs = [videoCodec, audioCodec].filter(Boolean).join(", ");
    const query = codecs ? `${mime}; codecs="${codecs}"` : mime;
    // A stream we cannot even name is not directly playable; `codecs` would
    // silently omit it and the engine would answer about the wrong file.
    const named = (!video || videoCodec) && (!audio || audioCodec);
    if (named && caps.direct(query)) {
      return { video: "copy", audio: "copy", container: "direct" };
    }
  }

  return {
    // A stream with no expressible codec string cannot be probed for support,
    // so it is re-encoded. Streams that are absent are nominally "copy": there
    // is nothing to encode.
    video: video ? (videoCodec && caps.mp4Video(videoCodec) ? "copy" : "encode") : "copy",
    audio: audio ? (audioCodec && caps.mp4Audio(audioCodec) ? "copy" : "encode") : "copy",
    container: "hls",
  };
}

/** Short human label for the pipeline, for a UI badge. */
export function planLabel(plan: Plan): string {
  if (plan.container === "direct") return "Direct play";
  if (plan.video === "encode") return "Transcoding";
  if (plan.audio === "encode") return "Remuxing (audio re-encoded)";
  return "Remuxing";
}
