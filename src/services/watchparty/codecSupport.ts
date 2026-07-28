/**
 * Interprets ffprobe's report, and asks *this* webview what it can actually
 * decode.
 *
 * The playback decision is capability-matched, never platform-matched. A table
 * saying "HEVC → transcode" would burn VideoToolbox cycles on every Mac for
 * nothing, because WKWebView decodes HEVC natively; the same file on a Windows
 * box without the HEVC Video Extension genuinely does need a transcode. Asking
 * the engine gets both right.
 */

/** The subset of ffprobe's `-show_streams` output we act on. */
export type ProbeStream = {
  index: number;
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  level?: number;
  width?: number;
  height?: number;
  pix_fmt?: string;
  channels?: number;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
};

export type Probe = {
  format?: { format_name?: string; duration?: string; bit_rate?: string };
  streams?: ProbeStream[];
};

/** What this webview can decode. Injected so the plan stays pure and testable. */
export type Capabilities = {
  /** MSE support for a video codec inside fMP4 — the HLS remux target. */
  mp4Video: (codec: string) => boolean;
  /** MSE support for an audio codec inside fMP4. */
  mp4Audio: (codec: string) => boolean;
  /** `<video src>` support for a whole container MIME, for the direct path. */
  direct: (mime: string) => boolean;
};

export function streamsOf(probe: Probe, type: string): ProbeStream[] {
  return (probe.streams ?? []).filter((s) => s.codec_type === type);
}

export function primaryVideo(probe: Probe): ProbeStream | undefined {
  return streamsOf(probe, "video").find((s) => s.disposition?.attached_pic !== 1);
}

/** Ordinal of the audio stream to start on: the one flagged default, else the
 * first. Ordinal within the audio streams, matching ffmpeg's `0:a:N`. */
export function defaultAudioOrdinal(probe: Probe): number {
  const audio = streamsOf(probe, "audio");
  const flagged = audio.findIndex((s) => s.disposition?.default === 1);
  return flagged >= 0 ? flagged : 0;
}

export function durationSec(probe: Probe): number {
  const d = Number(probe.format?.duration);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/** Text subtitles convert to WebVTT losslessly enough (ASS styling and
 * positioning are dropped). PGS and VOBSUB are bitmap formats and cannot become
 * WebVTT at all, so the UI greys them out rather than failing mysteriously. */
export function isTextSubtitle(codecName: string | undefined): boolean {
  return TEXT_SUBTITLE_CODECS.has(codecName ?? "");
}

const TEXT_SUBTITLE_CODECS = new Set([
  "subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text", "stl",
  "jacosub", "microdvd", "sami", "realtext", "subviewer", "subviewer1",
  "vplayer", "pjs", "mpl2", "eia_608",
]);

// ------------------------------------------------------- RFC 6381 codec strings

// H.264 `avc1.PPCCLL`: profile_idc, constraint-flags byte, level_idc, all hex.
// The constraint byte is not in ffprobe's output, so these are the conventional
// values for each profile — engines match on profile and level, and a 10-bit or
// 4:4:4 stream has to be recognised as its own profile because Chromium cannot
// decode those even though it decodes H.264.
const AVC_PROFILES: Record<string, string> = {
  "Constrained Baseline": "42E0",
  Baseline: "4200",
  Main: "4D40",
  Extended: "5800",
  High: "6400",
  "High 10": "6E00",
  "High 4:2:2": "7A00",
  "High 4:4:4 Predictive": "F400",
};

// HEVC `hvc1.<profile_idc>.<compat-flags>.<tier><level>.<constraints>`.
const HEVC_PROFILES: Record<string, { idc: number; compat: string }> = {
  Main: { idc: 1, compat: "6" },
  "Main 10": { idc: 2, compat: "4" },
  "Main Still Picture": { idc: 3, compat: "2" },
  Rext: { idc: 4, compat: "0" },
};

const AV1_PROFILES: Record<string, number> = { Main: 0, High: 1, Professional: 2 };

// AAC object types. HE-AAC streams have to be declared as such or Safari
// refuses them.
const AAC_PROFILES: Record<string, string> = {
  LC: "mp4a.40.2",
  "HE-AAC": "mp4a.40.5",
  "HE-AACv2": "mp4a.40.29",
  Main: "mp4a.40.1",
  SSR: "mp4a.40.3",
  LTP: "mp4a.40.4",
};

function hex2(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, "0");
}

function bitDepth(pixFmt: string | undefined): string {
  if (!pixFmt) return "08";
  if (pixFmt.includes("12")) return "12";
  if (pixFmt.includes("10")) return "10";
  return "08";
}

/**
 * The RFC 6381 codec string for a video stream, or `null` when we have no way
 * to express it — which is the signal to transcode. Returning `null` for
 * anything unrecognised is what makes an unknown codec fail safe.
 */
export function videoCodecString(s: ProbeStream | undefined): string | null {
  if (!s?.codec_name) return null;
  switch (s.codec_name) {
    case "h264": {
      const profile = AVC_PROFILES[s.profile ?? ""] ?? "4D40";
      return `avc1.${profile}${hex2(s.level ?? 40)}`;
    }
    case "hevc": {
      const p = HEVC_PROFILES[s.profile ?? ""] ?? HEVC_PROFILES.Main;
      return `hvc1.${p.idc}.${p.compat}.L${s.level ?? 120}.B0`;
    }
    case "av1": {
      const profile = AV1_PROFILES[s.profile ?? ""] ?? 0;
      const level = String(s.level ?? 5).padStart(2, "0");
      return `av01.${profile}.${level}M.${bitDepth(s.pix_fmt)}`;
    }
    case "vp9":
      return "vp09.00.10.08";
    case "vp8":
      return "vp8";
    default:
      // MPEG-2, MPEG-4 part 2, VC-1, WMV, Theora, ProRes, DV — none of them
      // play in a webview and none survive a remux.
      return null;
  }
}

export function audioCodecString(s: ProbeStream | undefined): string | null {
  if (!s?.codec_name) return null;
  switch (s.codec_name) {
    case "aac":
      return AAC_PROFILES[s.profile ?? ""] ?? "mp4a.40.2";
    case "mp3":
      return "mp4a.40.34";
    case "ac3":
      return "ac-3";
    case "eac3":
      return "ec-3";
    case "opus":
      return "opus";
    case "vorbis":
      return "vorbis";
    case "flac":
      return "flac";
    case "alac":
      return "alac";
    default:
      // DTS, TrueHD, PCM — lossless/cinema formats no browser decodes. These
      // are the common companions of HEVC in a real movie rip, which is why the
      // audio decision has to be independent of the video one.
      return null;
  }
}

/** The container MIME to test for direct playback, or `null` for containers no
 * webview handles (MPEG-TS, AVI, FLV, WMV). ffprobe cannot tell a `.mkv` from a
 * `.webm` — both report `matroska,webm` — so both are offered as `video/webm`
 * and the engine decides. An MKV holding H.264/AAC simply fails that test and
 * falls through to the remux path, which is the right answer anyway. */
export function directMime(probe: Probe): string | null {
  const name = probe.format?.format_name ?? "";
  const parts = name.split(",");
  if (parts.some((p) => p === "mp4" || p === "mov" || p === "m4a")) return "video/mp4";
  if (parts.some((p) => p === "matroska" || p === "webm")) return "video/webm";
  if (parts.some((p) => p === "ogg")) return "video/ogg";
  return null;
}

// -------------------------------------------------------------- runtime probing

/**
 * Asks the live webview what it supports. Built fresh rather than cached at
 * module load because `MediaSource` and codec availability can depend on
 * hardware/OS components (the HEVC Video Extension on Windows) that the user
 * may install between runs.
 */
export function webviewCapabilities(): Capabilities {
  const el = document.createElement("video");
  const mse = typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function";
  return {
    mp4Video: (codec) => mse && MediaSource.isTypeSupported(`video/mp4; codecs="${codec}"`),
    mp4Audio: (codec) => mse && MediaSource.isTypeSupported(`audio/mp4; codecs="${codec}"`),
    direct: (mime) => el.canPlayType(mime) !== "",
  };
}
