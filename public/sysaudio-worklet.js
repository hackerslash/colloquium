// Plays native-captured system audio (interleaved stereo Float32 chunks posted
// from the main thread) out through a MediaStreamAudioDestinationNode, so it
// can be added to the WebRTC screen-share stream.
class HavenSysAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /** Queue of interleaved-stereo Float32Array chunks. */
    this.queue = [];
    this.current = null;
    this.offset = 0;
    // Bound latency: if we ever fall this far behind, drop the backlog.
    this.maxChunks = 32;
    this.port.onmessage = (e) => {
      if (e.data === "flush") {
        this.queue = [];
        this.current = null;
        this.offset = 0;
        return;
      }
      if (this.queue.length >= this.maxChunks) this.queue.shift();
      this.queue.push(e.data);
    };
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
      } else {
        left[i] = 0;
        right[i] = 0;
      }
    }
    return true;
  }
}

registerProcessor("haven-sysaudio", HavenSysAudioProcessor);
