import { describe, expect, it } from "vitest";
import { decidePlan, planLabel, type Plan } from "./mediaPlan";
import type { Capabilities, Probe, ProbeStream } from "./codecSupport";

function video(overrides: Partial<ProbeStream> = {}): ProbeStream {
  return {
    index: 0,
    codec_type: "video",
    codec_name: "h264",
    profile: "High",
    level: 40,
    width: 1920,
    height: 1080,
    pix_fmt: "yuv420p",
    ...overrides,
  };
}

function audio(overrides: Partial<ProbeStream> = {}): ProbeStream {
  return {
    index: 1,
    codec_type: "audio",
    codec_name: "aac",
    profile: "LC",
    channels: 2,
    ...overrides,
  };
}

function probeOf(formatName: string, streams: ProbeStream[]): Probe {
  return { format: { format_name: formatName, duration: "5400.0" }, streams };
}

/**
 * A stand-in for a webview, described by which codecs it accepts *in which
 * container* — real engines enforce that pairing, and a fake that ignores it
 * would happily claim WebM can carry H.264. `containers` doubles as the
 * direct-play answer; the `video/mp4` entry is also what MSE would accept.
 */
function caps(containers: Record<string, string[]>): Capabilities {
  const inMp4 = (codec: string) =>
    (containers["video/mp4"] ?? []).some((s) => codec.startsWith(s));
  return {
    mp4Video: inMp4,
    mp4Audio: inMp4,
    direct: (mime) => {
      const [container, codecList] = mime.split("; codecs=");
      const allowed = containers[container];
      if (!allowed) return false;
      if (!codecList) return true;
      return codecList
        .replace(/"/g, "")
        .split(",")
        .every((c) => allowed.some((s) => c.trim().startsWith(s)));
    },
  };
}

/** WKWebView: HEVC and H.264 in hardware, AC3/E-AC3 pass-through, no WebM. */
const MAC = caps({
  "video/mp4": ["avc1", "hvc1", "av01", "mp4a", "ac-3", "ec-3", "alac", "flac"],
});

/** WebView2 with no HEVC Video Extension: no HEVC, no AC3 family, but WebM. */
const WINDOWS = caps({
  "video/mp4": ["avc1", "av01", "mp4a", "flac", "opus"],
  "video/webm": ["vp8", "vp09", "av01", "opus", "vorbis"],
});

const MP4 = "mov,mp4,m4a,3gp,3g2,mj2";
const MKV = "matroska,webm";

describe("decidePlan", () => {
  it("plays an H.264/AAC MP4 directly on both platforms", () => {
    const probe = probeOf(MP4, [video(), audio()]);
    const expected: Plan = { video: "copy", audio: "copy", container: "direct" };
    expect(decidePlan(probe, MAC)).toEqual(expected);
    expect(decidePlan(probe, WINDOWS)).toEqual(expected);
  });

  it("remuxes an H.264/AAC MKV without touching either stream", () => {
    // The codecs are fine; only the container is unplayable. This must not cost
    // a single encoded frame.
    const probe = probeOf(MKV, [video(), audio()]);
    const expected: Plan = { video: "copy", audio: "copy", container: "hls" };
    expect(decidePlan(probe, MAC)).toEqual(expected);
    expect(decidePlan(probe, WINDOWS)).toEqual(expected);
  });

  it("copies HEVC video and encodes DTS audio where HEVC is supported", () => {
    // The single most common real movie file, on a Mac: nearly free.
    const probe = probeOf(MKV, [
      video({ codec_name: "hevc", profile: "Main 10", level: 120, pix_fmt: "yuv420p10le" }),
      audio({ codec_name: "dts", profile: "DTS-HD MA", channels: 6 }),
    ]);
    expect(decidePlan(probe, MAC)).toEqual({
      video: "copy",
      audio: "encode",
      container: "hls",
    });
  });

  it("encodes both when HEVC is unsupported", () => {
    // The same file on Windows without the HEVC extension. Sync still holds
    // against the Mac above, because positions are on the source timeline.
    const probe = probeOf(MKV, [
      video({ codec_name: "hevc", profile: "Main 10", level: 120, pix_fmt: "yuv420p10le" }),
      audio({ codec_name: "dts", profile: "DTS-HD MA", channels: 6 }),
    ]);
    expect(decidePlan(probe, WINDOWS)).toEqual({
      video: "encode",
      audio: "encode",
      container: "hls",
    });
  });

  it("plays an AV1/Opus WebM directly where WebM is supported", () => {
    const probe = probeOf(MKV, [
      video({ codec_name: "av1", profile: "Main", level: 5 }),
      audio({ codec_name: "opus", profile: undefined }),
    ]);
    expect(decidePlan(probe, WINDOWS)).toEqual({
      video: "copy",
      audio: "copy",
      container: "direct",
    });
    // WKWebView opens no WebM, and does not take Opus in fMP4 — but it does
    // decode AV1, so only the audio is re-encoded.
    expect(decidePlan(probe, MAC)).toEqual({
      video: "copy",
      audio: "encode",
      container: "hls",
    });
  });

  it("encodes video no engine can decode", () => {
    const probe = probeOf("avi", [
      video({ codec_name: "vc1", profile: "Advanced" }),
      audio({ codec_name: "ac3", channels: 6 }),
    ]);
    expect(decidePlan(probe, MAC)).toEqual({
      video: "encode",
      audio: "copy",
      container: "hls",
    });
    expect(decidePlan(probe, WINDOWS)).toEqual({
      video: "encode",
      audio: "encode",
      container: "hls",
    });
  });

  it("encodes an unrecognised codec rather than guessing", () => {
    const probe = probeOf(MKV, [video({ codec_name: "some_future_codec", profile: undefined })]);
    expect(decidePlan(probe, MAC).video).toBe("encode");
  });

  it("treats 10-bit H.264 as its own profile", () => {
    // Chromium decodes H.264 but not High 10, so a profile-blind mapping would
    // copy this and produce a black picture.
    const probe = probeOf(MKV, [video({ profile: "High 10", pix_fmt: "yuv420p10le" }), audio()]);
    const noHigh10 = caps({ "video/mp4": ["avc1.6400", "avc1.4D40", "mp4a"] });
    expect(decidePlan(probe, noHigh10).video).toBe("encode");
  });

  it("follows the audio track being played, not the first one", () => {
    // Track 0 is AAC, track 1 is TrueHD: the plan differs per selection even
    // though the file has not changed.
    const probe = probeOf(MKV, [
      video(),
      audio({ codec_name: "aac" }),
      audio({ index: 2, codec_name: "truehd", channels: 8 }),
    ]);
    expect(decidePlan(probe, MAC, 0).audio).toBe("copy");
    expect(decidePlan(probe, MAC, 1).audio).toBe("encode");
  });

  it("starts on the default-flagged audio track", () => {
    const probe = probeOf(MKV, [
      video(),
      audio({ codec_name: "truehd", channels: 8 }),
      audio({ index: 2, codec_name: "aac", disposition: { default: 1 } }),
    ]);
    expect(decidePlan(probe, MAC).audio).toBe("copy");
  });

  it("handles a source with no audio at all", () => {
    const probe = probeOf(MKV, [video()]);
    expect(decidePlan(probe, MAC)).toEqual({
      video: "copy",
      audio: "copy",
      container: "hls",
    });
  });

  it("handles an audio-only source", () => {
    const probe = probeOf(MKV, [audio({ index: 0 })]);
    expect(decidePlan(probe, MAC).video).toBe("copy");
  });

  it("ignores cover art when picking the video stream", () => {
    // Embedded artwork is a video stream as far as ffprobe is concerned; taking
    // it as the primary would plan a transcode of a single JPEG.
    const probe = probeOf(MKV, [
      video({ codec_name: "mjpeg", disposition: { attached_pic: 1 } }),
      video({ index: 1 }),
      audio({ index: 2 }),
    ]);
    expect(decidePlan(probe, MAC).video).toBe("copy");
  });

  it("never direct-plays once a specific audio track has been chosen", () => {
    // No webview exposes an audio-track API, so a selection can only be honoured
    // by muxing that one stream — even for a file that would otherwise play
    // untouched.
    const probe = probeOf(MP4, [video(), audio(), audio({ index: 2 })]);
    expect(decidePlan(probe, MAC, 1, false).container).toBe("hls");
    expect(decidePlan(probe, MAC, 1, false)).toEqual({
      video: "copy",
      audio: "copy",
      container: "hls",
    });
  });

  it("does not direct-play a container whose codecs it cannot name", () => {
    // DTS has no codec string, so the engine would be asked only about the video
    // and would answer yes to a file it cannot actually play.
    const probe = probeOf(MP4, [video(), audio({ codec_name: "dts" })]);
    expect(decidePlan(probe, MAC).container).toBe("hls");
  });
});

describe("planLabel", () => {
  it("describes each pipeline", () => {
    expect(planLabel({ video: "copy", audio: "copy", container: "direct" })).toBe("Direct play");
    expect(planLabel({ video: "copy", audio: "copy", container: "hls" })).toBe("Remuxing");
    expect(planLabel({ video: "copy", audio: "encode", container: "hls" })).toBe(
      "Remuxing (audio re-encoded)",
    );
    expect(planLabel({ video: "encode", audio: "encode", container: "hls" })).toBe("Transcoding");
  });
});
