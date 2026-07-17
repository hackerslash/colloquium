export type ScreenShareQualityOption = {
  id: string;
  label: string;
  /** Compact label for the on-screen quality badge (e.g. "1080p", "4K"). */
  short: string;
  width?: number;
  height?: number;
  frameRate?: number;
  maxBitrate?: number;
};

// Bitrate caps rise monotonically with pixels×fps so stepping "up" a tier is
// always a real quality increase (4K at 1080p bitrates looks *worse* than
// 1080p — fewer bits per pixel).
export const SCREEN_SHARE_OPTIONS: ScreenShareQualityOption[] = [
  { id: "auto", label: "Auto", short: "Auto" },
  { id: "720p_30", label: "720p · 30fps", short: "720p", width: 1280, height: 720, frameRate: 30, maxBitrate: 1_500_000 },
  { id: "720p_60", label: "720p · 60fps", short: "720p60", width: 1280, height: 720, frameRate: 60, maxBitrate: 2_500_000 },
  { id: "1080p_30", label: "1080p · 30fps", short: "1080p", width: 1920, height: 1080, frameRate: 30, maxBitrate: 4_000_000 },
  { id: "1080p_60", label: "1080p · 60fps", short: "1080p60", width: 1920, height: 1080, frameRate: 60, maxBitrate: 8_000_000 },
  { id: "4k_30", label: "4K · 30fps", short: "4K", width: 3840, height: 2160, frameRate: 30, maxBitrate: 12_000_000 },
  { id: "4k_60", label: "4K · 60fps", short: "4K60", width: 3840, height: 2160, frameRate: 60, maxBitrate: 20_000_000 },
];

/** The largest capture we ever ask the OS for — getDisplayMedia clamps this to
 * the display's real size, so it's a "give me full physical pixels" request,
 * not an upscale. Matches the top of SCREEN_SHARE_OPTIONS. */
export const MAX_CAPTURE_WIDTH = 3840;
export const MAX_CAPTURE_HEIGHT = 2160;

/** Encoding tier resolved for a live screen sender. Structurally matches the
 * PeerConnectionWrapper `Tier` shape so it can be handed straight to
 * addVideoTrack / applyVideoTier. */
export type ResolvedScreenTier = {
  maxBitrate: number;
  scaleResolutionDownBy: number;
  maxFramerate: number;
};

/**
 * Turns a quality selection into a concrete encoder tier.
 *
 * The screen is always captured at its native resolution (see displayMedia),
 * so switching quality live means downscaling in the encoder via
 * scaleResolutionDownBy — computed from the actual captured width — rather than
 * re-capturing. Picking a resolution at or above native leaves scale at 1.
 * `Auto` returns undefined, handing the sender back to adaptive control.
 */
export function resolveScreenTier(
  config: ScreenShareQualityOption,
  sourceWidth?: number,
): ResolvedScreenTier | undefined {
  if (config.id === "auto" || !config.maxBitrate) return undefined;
  let scaleResolutionDownBy = 1;
  if (sourceWidth && config.width && config.width < sourceWidth) {
    scaleResolutionDownBy = sourceWidth / config.width;
  }
  return {
    maxBitrate: config.maxBitrate,
    scaleResolutionDownBy,
    maxFramerate: config.frameRate ?? 30,
  };
}
