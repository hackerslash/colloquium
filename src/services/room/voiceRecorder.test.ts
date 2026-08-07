import { describe, expect, it, vi } from "vitest";
import { VoiceRecorder } from "./voiceRecorder";

/** The clock and meter read private fields that `start()` can only populate via
 * getUserMedia, so drive them directly. */
type Inner = {
  bankedMs: number;
  runStartedAt: number;
  recorder: { state: string; pause(): void; resume(): void } | null;
  analyser: { getByteTimeDomainData(b: Uint8Array): void } | null;
  levelBuf: Uint8Array | null;
};

function recording(): { rec: VoiceRecorder; inner: Inner } {
  const rec = new VoiceRecorder();
  const inner = rec as unknown as Inner;
  inner.recorder = {
    state: "recording",
    pause() {
      this.state = "paused";
    },
    resume() {
      this.state = "recording";
    },
  };
  inner.bankedMs = 0;
  inner.runStartedAt = Date.now();
  return { rec, inner };
}

describe("recording clock", () => {
  it("excludes paused time from the duration", () => {
    vi.useFakeTimers();
    try {
      const { rec } = recording();
      vi.advanceTimersByTime(1_000);
      expect(rec.pause()).toBe(true);
      expect(rec.isPaused).toBe(true);
      expect(rec.durationMs).toBe(1_000);

      vi.advanceTimersByTime(5_000);
      expect(rec.durationMs).toBe(1_000);

      expect(rec.resume()).toBe(true);
      expect(rec.isPaused).toBe(false);
      vi.advanceTimersByTime(2_000);
      expect(rec.durationMs).toBe(3_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores pause/resume calls that do not apply", () => {
    const { rec } = recording();
    expect(rec.resume()).toBe(false); // not paused yet
    expect(rec.pause()).toBe(true);
    expect(rec.pause()).toBe(false); // already paused
  });

  it("does not bank time when the WebView refuses to pause", () => {
    vi.useFakeTimers();
    try {
      const { rec, inner } = recording();
      // Accepts the call but never leaves "recording", as some WebViews do.
      inner.recorder = { state: "recording", pause() {}, resume() {} };
      vi.advanceTimersByTime(1_000);
      expect(rec.pause()).toBe(false);
      expect(rec.isPaused).toBe(false);
      vi.advanceTimersByTime(1_000);
      expect(rec.durationMs).toBe(2_000); // still running, nothing double-counted
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("input level", () => {
  const withFrame = (frame: number[]) => {
    const { rec, inner } = recording();
    inner.levelBuf = new Uint8Array(frame.length);
    inner.analyser = { getByteTimeDomainData: (b) => b.set(frame) };
    return rec;
  };

  it("reports 0 when no analyser could be created", () => {
    expect(recording().rec.level).toBe(0);
  });

  it("measures peak distance from the 128 midpoint", () => {
    expect(withFrame([128, 192, 128, 64]).level).toBe(0.5);
  });

  it("reads silence as 0 and full scale as 1", () => {
    expect(withFrame([128, 128, 128, 128]).level).toBe(0);
    expect(withFrame([0, 255, 128, 128]).level).toBe(1);
  });
});
