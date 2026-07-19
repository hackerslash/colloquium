// Plays native-captured system audio (interleaved stereo Float32 chunks posted
// from the main thread) out through a MediaStreamAudioDestinationNode, so it
// can be added to the WebRTC screen-share stream.
//
// Latency governor: production and consumption both run at 48 kHz, so whatever
// backlog exists (chunks that piled up while the AudioContext was still
// spinning up, or after a stall) NEVER drains by itself — it becomes a
// permanent audio delay behind the shared video. We watch the queue's
// *minimum* depth over a rolling window; the minimum is the part of the
// backlog that jitter never touched, i.e. pure added latency, and anything
// above the target cushion gets dropped in one cut. Using the window-min means
// normal arrival jitter (queue briefly deep, then drained) never triggers it.
class ColloquiumSysAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /** Queue of interleaved-stereo Float32Array chunks. */
    this.queue = [];
    this.current = null;
    this.offset = 0;
    /** Interleaved samples buffered across queue + current (2 per frame). */
    this.queuedSamples = 0;

    // Hard bound (last resort): ~85 chunks of 20 ms ≈ 1.7 s can never build up.
    this.maxSamples = 48000 * 2; // 1 s of stereo
    // Keep ~50 ms of cushion after a cut — enough to absorb IPC jitter.
    this.targetSamples = 4800;
    // Tolerate up to ~100 ms of standing latency before cutting.
    this.slackSamples = 9600;
    // ~2 s of 128-frame quanta per governor window.
    this.windowLength = 750;
    this.windowCalls = 0;
    this.windowMinSamples = Infinity;

    this.port.onmessage = (e) => {
      if (e.data === "flush") {
        this.queue = [];
        this.current = null;
        this.offset = 0;
        this.queuedSamples = 0;
        this.windowCalls = 0;
        this.windowMinSamples = Infinity;
        return;
      }
      this.queue.push(e.data);
      this.queuedSamples += e.data.length;
      if (this.queuedSamples > this.maxSamples) {
        this.dropSamples(this.queuedSamples - this.targetSamples);
      }
    };
  }

  /** Drops the OLDEST n interleaved samples (the stalest audio). */
  dropSamples(n) {
    let remaining = n;
    while (remaining > 0) {
      if (!this.current || this.offset >= this.current.length) {
        this.current = this.queue.shift() || null;
        this.offset = 0;
        if (!this.current) break;
      }
      const take = Math.min(this.current.length - this.offset, remaining);
      this.offset += take;
      this.queuedSamples -= take;
      remaining -= take;
    }
    // Depth changed discontinuously — old window measurements are stale.
    this.windowCalls = 0;
    this.windowMinSamples = Infinity;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out[1] || out[0];
    const frames = left.length;

    for (let i = 0; i < frames; i++) {
      if (!this.current || this.offset >= this.current.length) {
        this.current = this.queue.shift() || null;
        this.offset = 0;
      }
      if (this.current) {
        left[i] = this.current[this.offset++] || 0;
        right[i] = this.current[this.offset++] || 0;
        this.queuedSamples -= 2;
      } else {
        left[i] = 0;
        right[i] = 0;
      }
    }
    if (this.queuedSamples < 0) this.queuedSamples = 0;

    // Governor: cut standing latency down to the target cushion.
    if (this.queuedSamples < this.windowMinSamples) this.windowMinSamples = this.queuedSamples;
    if (++this.windowCalls >= this.windowLength) {
      if (this.windowMinSamples > this.slackSamples) {
        this.dropSamples(this.windowMinSamples - this.targetSamples);
      }
      this.windowCalls = 0;
      this.windowMinSamples = Infinity;
    }
    return true;
  }
}

registerProcessor("colloquium-sysaudio", ColloquiumSysAudioProcessor);
