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
import {
  isMacOS,
  MACOS_QUARANTINE_HINT,
  startSystemAudioTrack,
  stopSystemAudioTrack,
  usesNativeSystemAudio,
} from "./systemAudio";
import {
  MAX_CAPTURE_HEIGHT,
  MAX_CAPTURE_WIDTH,
  type ScreenShareQualityOption,
} from "./screenShareConfig";

export type DisplayCapture = {
  stream: MediaStream;
  hasSystemAudio: boolean;
};

/** Why a screen share is stopping: the in-app Stop button ("user") vs the OS/
 * WebView ending the capture out from under us ("ended"). */
export type ScreenStopSource = "user" | "ended";

/** Cheap structured breadcrumbs for the screen-share lifecycle. WebView2
 * (Windows) can end a display capture for reasons the app never initiated
 * (captured surface lost, window minimized, GPU/WebView2 teardown), which
 * presents as a share "ending abruptly". These logs let an installed build be
 * diagnosed from DevTools without a debugger attached. */
export function logScreenShare(event: string, detail?: Record<string, unknown>): void {
  console.info(`[screenShare] ${event}`, detail ?? {});
}

/** Platform-appropriate copy for a getDisplayMedia rejection. A cancelled OS
 * picker rejects with `NotAllowedError` on every platform, so the macOS-only
 * "grant Screen Recording" wording must not be shown to Windows/Linux users
 * (who have no such permission and would be sent chasing a non-existent
 * setting). */
export function describeScreenShareError(err: unknown): string {
  const name = (err as Error)?.name;
  if (name === "NotAllowedError") {
    return isMacOS()
      ? "Screen share was cancelled or blocked. On macOS, grant Screen Recording to Haven in System Settings ▸ Privacy & Security." +
          MACOS_QUARANTINE_HINT
      : "Screen share was cancelled. Pick a screen or window and allow sharing to try again.";
  }
  return `Screen share isn't available: ${name ?? "unknown error"}.`;
}

// System audio (music, video, game) must be forwarded untouched. The mic-
// oriented DSP — echo cancellation, noise suppression, auto gain — is designed
// for a voice and would mangle full-range audio, so it's disabled here.
//
// This is only used on platforms WITHOUT native capture (Linux). On macOS and
// Windows we deliberately DON'T request getDisplayMedia audio at all: that tap
// is a whole-system loopback that also recaptures Haven's own playback of the
// remote participants, sending their voices back to them (echo). Those
// platforms capture system audio natively instead, excluding the app's own
// process (see systemAudio.ts / the Rust `sysaudio_*` commands).
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

  // On macOS/Windows we capture system audio natively (own-process-excluding),
  // so don't also ask getDisplayMedia for the echo-prone whole-system loopback.
  const native = usesNativeSystemAudio();
  logScreenShare("requesting getDisplayMedia", {
    frameRate,
    config: config?.id,
    audioSource: native ? "native" : "getDisplayMedia",
  });
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: MAX_CAPTURE_WIDTH },
      height: { ideal: MAX_CAPTURE_HEIGHT },
      frameRate: { ideal: frameRate },
    },
    audio: native ? false : SYSTEM_AUDIO_CONSTRAINTS,
  });

  // Diagnostic-only listeners on the video track (the teardown `onended` is set
  // by the caller). `mute`/`unmute` and an early `ended` are the fingerprints of
  // a WebView2 capture that dropped without the user pressing Stop.
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    logScreenShare("capture started", {
      label: videoTrack.label,
      settings: videoTrack.getSettings(),
    });
    videoTrack.addEventListener("mute", () =>
      logScreenShare("video track muted", { readyState: videoTrack.readyState }),
    );
    videoTrack.addEventListener("unmute", () =>
      logScreenShare("video track unmuted", { readyState: videoTrack.readyState }),
    );
    videoTrack.addEventListener("ended", () =>
      logScreenShare("video track ended (diagnostic)", { readyState: videoTrack.readyState }),
    );
  }

  // On macOS/Windows, splice in the natively-captured system audio (excludes
  // Haven's own output, so a call doesn't echo). Best-effort: if native capture
  // is unavailable the screen still shares, video-only.
  if (native && stream.getAudioTracks().length === 0) {
    const nativeTrack = await startSystemAudioTrack();
    if (nativeTrack) {
      stream.addTrack(nativeTrack);
      logScreenShare("native system audio attached", {});
    } else {
      logScreenShare("native system audio unavailable", {});
    }
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
