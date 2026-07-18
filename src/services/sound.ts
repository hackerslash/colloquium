import { useSettingsStore } from "../stores/useSettingsStore";

let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!audioCtx) {
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
    audioCtx = new AudioContextCtor();
  }
  return audioCtx;
}

/** Plays a short two-tone chime for an incoming message, gated on the
 * notificationSounds setting. Best-effort: a browser autoplay block or
 * unsupported AudioContext should never break message handling. */
export function playMessageSound(): void {
  if (!useSettingsStore.getState().notificationSounds) return;
  try {
    const ctx = getCtx();
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    const now = ctx.currentTime;

    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.setValueAtTime(1174.66, now + 0.09);
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + 0.35);
  } catch {
    // Best-effort; sound failures shouldn't break message handling.
  }
}
