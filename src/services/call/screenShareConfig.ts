export type ScreenShareQualityOption = {
  id: string;
  label: string;
  width?: number;
  height?: number;
  frameRate?: number;
  maxBitrate?: number;
};

export const SCREEN_SHARE_OPTIONS: ScreenShareQualityOption[] = [
  { id: "auto", label: "Auto" },
  { id: "720p_30_low", label: "720p 30fps Low", width: 1280, height: 720, frameRate: 30, maxBitrate: 1_000_000 },
  { id: "720p_60_med", label: "720p 60fps Med", width: 1280, height: 720, frameRate: 60, maxBitrate: 2_500_000 },
  { id: "1080p_30_med", label: "1080p 30fps Med", width: 1920, height: 1080, frameRate: 30, maxBitrate: 3_000_000 },
  { id: "1080p_60_high", label: "1080p 60fps High", width: 1920, height: 1080, frameRate: 60, maxBitrate: 8_000_000 },
  { id: "4k_30_low", label: "4K 30fps Low", width: 3840, height: 2160, frameRate: 30, maxBitrate: 5_000_000 },
  { id: "4k_60_med", label: "4K 60fps Med", width: 3840, height: 2160, frameRate: 60, maxBitrate: 15_000_000 },
];
