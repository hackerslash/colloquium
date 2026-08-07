/** Self-check for the pause-aware duration clock and the level meter — the two
 * bits of real logic in VoiceRecorder. Run: `npx tsx src/services/room/voiceRecorder.test.ts` */
import { VoiceRecorder } from "./voiceRecorder";

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

type Inner = {
  bankedMs: number;
  runStartedAt: number;
  recorder: { state: string; pause(): void; resume(): void } | null;
  analyser: { getByteTimeDomainData(b: Uint8Array): void } | null;
  levelBuf: Uint8Array | null;
};

/** Drives the private clock/meter fields directly: `start()` needs getUserMedia. */
function harness(): { rec: VoiceRecorder; inner: Inner } {
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { rec, inner } = harness();

  // Paused time must not count toward the recording length.
  await sleep(120);
  ok(rec.pause(), "pause() succeeds while recording");
  ok(rec.isPaused, "isPaused reflects the paused state");
  const atPause = rec.durationMs;
  ok(atPause >= 100, `banked ~120ms, got ${atPause}`);

  await sleep(150);
  ok(rec.durationMs === atPause, "clock is frozen while paused");
  ok(!rec.pause(), "pause() is a no-op when already paused");

  ok(rec.resume(), "resume() succeeds while paused");
  ok(!rec.isPaused, "isPaused clears on resume");
  await sleep(120);
  const after = rec.durationMs;
  ok(after > atPause + 90, `clock resumed, got ${after} vs ${atPause}`);
  ok(after < atPause + 150, `the 150ms pause was excluded, got ${after}`);

  // A WebView that accepts pause() but keeps recording must not bank time.
  inner.recorder = { state: "recording", pause() {}, resume() {} };
  const before = rec.durationMs;
  ok(!rec.pause(), "pause() reports failure when state never flips");
  ok(rec.durationMs >= before, "a refused pause does not bank time");

  // level: peak distance from the 128 midpoint, normalised to 0..1.
  ok(rec.level === 0, "no analyser reports a flat level");
  inner.levelBuf = new Uint8Array(4);
  inner.analyser = { getByteTimeDomainData: (b) => b.set([128, 192, 128, 64]) };
  ok(rec.level === 0.5, `peak 64/128 from the midpoint = 0.5, got ${rec.level}`);
  inner.analyser = { getByteTimeDomainData: (b) => b.set([128, 128, 128, 128]) };
  ok(rec.level === 0, "silence reads 0");
  inner.analyser = { getByteTimeDomainData: (b) => b.set([0, 255, 128, 128]) };
  ok(rec.level === 1, "full scale clamps to 1");

  console.log("voiceRecorder: all checks passed");
}

void main();
