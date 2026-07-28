import { describe, expect, it } from "vitest";
import {
  audioCodecString,
  defaultAudioOrdinal,
  directMime,
  durationSec,
  isTextSubtitle,
  primaryVideo,
  streamsOf,
  videoCodecString,
  type Probe,
} from "./codecSupport";

describe("videoCodecString", () => {
  it("maps H.264 profile and level", () => {
    expect(videoCodecString({ index: 0, codec_name: "h264", profile: "High", level: 40 })).toBe(
      "avc1.640028",
    );
    expect(videoCodecString({ index: 0, codec_name: "h264", profile: "Main", level: 31 })).toBe(
      "avc1.4D401F",
    );
    expect(
      videoCodecString({ index: 0, codec_name: "h264", profile: "Constrained Baseline", level: 30 }),
    ).toBe("avc1.42E01E");
  });

  it("distinguishes 10-bit and 4:4:4 H.264 from ordinary High", () => {
    expect(videoCodecString({ index: 0, codec_name: "h264", profile: "High 10", level: 40 })).toBe(
      "avc1.6E0028",
    );
    expect(
      videoCodecString({
        index: 0,
        codec_name: "h264",
        profile: "High 4:4:4 Predictive",
        level: 40,
      }),
    ).toBe("avc1.F40028");
  });

  it("maps HEVC main and main-10", () => {
    expect(videoCodecString({ index: 0, codec_name: "hevc", profile: "Main", level: 93 })).toBe(
      "hvc1.1.6.L93.B0",
    );
    expect(videoCodecString({ index: 0, codec_name: "hevc", profile: "Main 10", level: 120 })).toBe(
      "hvc1.2.4.L120.B0",
    );
  });

  it("maps AV1 with its bit depth", () => {
    expect(
      videoCodecString({ index: 0, codec_name: "av1", profile: "Main", level: 5, pix_fmt: "yuv420p" }),
    ).toBe("av01.0.05M.08");
    expect(
      videoCodecString({
        index: 0,
        codec_name: "av1",
        profile: "Main",
        level: 13,
        pix_fmt: "yuv420p10le",
      }),
    ).toBe("av01.0.13M.10");
  });

  it("returns null for codecs no webview decodes", () => {
    for (const codec of ["mpeg2video", "mpeg4", "vc1", "wmv3", "theora", "prores", "dvvideo"]) {
      expect(videoCodecString({ index: 0, codec_name: codec })).toBeNull();
    }
  });

  it("returns null rather than guessing at an unknown codec", () => {
    expect(videoCodecString({ index: 0, codec_name: "brand_new_codec" })).toBeNull();
    expect(videoCodecString({ index: 0 })).toBeNull();
    expect(videoCodecString(undefined)).toBeNull();
  });

  it("falls back to Main when ffprobe reports no profile", () => {
    expect(videoCodecString({ index: 0, codec_name: "h264", level: 40 })).toBe("avc1.4D4028");
  });
});

describe("audioCodecString", () => {
  it("maps AAC object types", () => {
    expect(audioCodecString({ index: 0, codec_name: "aac", profile: "LC" })).toBe("mp4a.40.2");
    expect(audioCodecString({ index: 0, codec_name: "aac", profile: "HE-AAC" })).toBe("mp4a.40.5");
    expect(audioCodecString({ index: 0, codec_name: "aac", profile: "HE-AACv2" })).toBe("mp4a.40.29");
  });

  it("maps the surround formats a webview may pass through", () => {
    expect(audioCodecString({ index: 0, codec_name: "ac3" })).toBe("ac-3");
    expect(audioCodecString({ index: 0, codec_name: "eac3" })).toBe("ec-3");
  });

  it("returns null for cinema formats no engine decodes", () => {
    for (const codec of ["dts", "truehd", "pcm_s24le", "mlp"]) {
      expect(audioCodecString({ index: 0, codec_name: codec })).toBeNull();
    }
  });
});

describe("directMime", () => {
  it("maps ffprobe's format names", () => {
    expect(directMime({ format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" } })).toBe("video/mp4");
    expect(directMime({ format: { format_name: "matroska,webm" } })).toBe("video/webm");
  });

  it("returns null for containers no webview opens", () => {
    for (const name of ["mpegts", "avi", "flv", "asf", "hls"]) {
      expect(directMime({ format: { format_name: name } })).toBeNull();
    }
    expect(directMime({})).toBeNull();
  });
});

describe("stream selection", () => {
  const probe: Probe = {
    format: { duration: "3600.5" },
    streams: [
      { index: 0, codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } },
      { index: 1, codec_type: "video", codec_name: "h264" },
      { index: 2, codec_type: "audio", codec_name: "truehd" },
      { index: 3, codec_type: "audio", codec_name: "aac", disposition: { default: 1 } },
      { index: 4, codec_type: "subtitle", codec_name: "subrip" },
    ],
  };

  it("skips attached cover art", () => {
    expect(primaryVideo(probe)?.index).toBe(1);
  });

  it("prefers the default-flagged audio track by ordinal", () => {
    // Ordinal within audio streams, not the absolute ffprobe index — that is
    // what ffmpeg's `0:a:N` takes and what travels on the wire.
    expect(defaultAudioOrdinal(probe)).toBe(1);
  });

  it("falls back to the first audio track when none is flagged", () => {
    expect(defaultAudioOrdinal({ streams: [{ index: 0, codec_type: "audio" }] })).toBe(0);
    expect(defaultAudioOrdinal({ streams: [] })).toBe(0);
  });

  it("groups streams by type", () => {
    expect(streamsOf(probe, "audio").map((s) => s.index)).toEqual([2, 3]);
    expect(streamsOf(probe, "subtitle").map((s) => s.index)).toEqual([4]);
  });

  it("reads duration, rejecting ffprobe's non-numeric answers", () => {
    expect(durationSec(probe)).toBeCloseTo(3600.5);
    expect(durationSec({ format: { duration: "N/A" } })).toBe(0);
    expect(durationSec({})).toBe(0);
  });
});

describe("isTextSubtitle", () => {
  it("accepts the formats that convert to WebVTT", () => {
    for (const codec of ["subrip", "ass", "ssa", "mov_text", "webvtt"]) {
      expect(isTextSubtitle(codec)).toBe(true);
    }
  });

  it("rejects bitmap subtitles, which cannot become WebVTT at all", () => {
    for (const codec of ["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub"]) {
      expect(isTextSubtitle(codec)).toBe(false);
    }
    expect(isTextSubtitle(undefined)).toBe(false);
  });
});
