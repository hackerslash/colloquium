/**
 * Screen capture with best-effort system (loopback) audio.
 *
 * System-audio support depends entirely on the platform's system WebView,
 * because Tauri ships no browser of its own:
 *   - Windows (WebView2 / Chromium): supported — the picker shows a
 *     "Share system audio" / "Share tab audio" option.
 *   - Linux (WebKitGTK): partial/unreliable, PipeWire-dependent.
 *   - macOS (WKWebView): getDisplayMedia returns no audio track at all.
 * We therefore treat audio as optional: if the platform gives us an audio
 * track we forward it; otherwise the screen still shares, video-only, with no
 * error.
 *
 * The microphone is NEVER part of this stream — getDisplayMedia only taps the
 * display/system output. The call microphone is a separate getUserMedia track,
 * so "only system audio is shared" holds by construction.
 */
import { isMacOS, startSystemAudioTrack, stopSystemAudioTrack } from "./systemAudio";
import {
  MAX_CAPTURE_HEIGHT,
  MAX_CAPTURE_WIDTH,
  type ScreenShareQualityOption,
} from "./screenShareConfig";

export type DisplayCapture = {
  stream: MediaStream;
  hasSystemAudio: boolean;
};

// System audio (music, video, game) must be forwarded untouched. The mic-
// oriented DSP — echo cancellation, noise suppression, auto gain — is designed
// for a voice and would mangle full-range audio, so it's disabled here. Voice
// feedback between call participants is handled upstream by each microphone's
// echo cancellation, not by processing the shared audio.
const SYSTEM_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

export async function captureDisplay(config?: ScreenShareQualityOption): Promise<DisplayCapture> {
  // Always capture at the display's FULL PHYSICAL resolution. Without explicit
  // width/height, HiDPI screens are captured at their logical size (e.g. a
  // Retina Mac yields ~1728×1117, a 4K monitor at 150% scaling yields
  // 2560×1440), which silently caps every quality tier at ~1080p — selecting
  // 4K then changes nothing. Asking for 4K "ideal" unlocks physical pixels;
  // the browser clamps to the real screen size, never upscales. Quality is
  // then applied in the encoder (downscale via scaleResolutionDownBy +
  // bitrate/framerate caps), so the user can switch resolution live — down
  // AND back up to native — without re-prompting the OS picker.
  const frameRate = config && config.id !== "auto" && config.frameRate ? config.frameRate : 30;

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: MAX_CAPTURE_WIDTH },
      height: { ideal: MAX_CAPTURE_HEIGHT },
      frameRate: { ideal: frameRate },
    },
    audio: SYSTEM_AUDIO_CONSTRAINTS,
  });

  // macOS WKWebView never returns display audio — capture it natively and
  // splice the track in so downstream code forwards it like any other.
  if (stream.getAudioTracks().length === 0 && isMacOS()) {
    const nativeTrack = await startSystemAudioTrack();
    if (nativeTrack) stream.addTrack(nativeTrack);
  }

  for (const track of stream.getAudioTracks()) {
    // Hint the encoder to preserve fidelity rather than optimize for speech.
    try {
      track.contentHint = "music";
    } catch {
      // contentHint is advisory
    }
  }

  return { stream, hasSystemAudio: stream.getAudioTracks().length > 0 };
}

/** Stops any native system-audio capture started by captureDisplay(). Safe to
 * call unconditionally when a screen share or call ends. */
export function releaseDisplayAudio(): void {
  void stopSystemAudioTrack();
}
