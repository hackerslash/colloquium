export const MAX_VOICE_DURATION_MS = 120_000;
export const MIN_VOICE_DURATION_MS = 500;
export const VOICE_WAVEFORM_BARS = 40;

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/aac",
  "audio/ogg;codecs=opus",
];

let cachedMime: string | null | undefined;

export function getPreferredVoiceMimeType(): string | null {
  if (cachedMime !== undefined) return cachedMime;
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    cachedMime = null;
    return cachedMime;
  }
  for (const m of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) {
        cachedMime = m;
        return cachedMime;
      }
    } catch {
      // ignore
    }
  }
  cachedMime = null;
  return cachedMime;
}

export function isVoiceSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined" &&
    getPreferredVoiceMimeType() !== null
  );
}

function bufferWaveform(buffer: AudioBuffer, bars: number): number[] {
  const data = buffer.getChannelData(0);
  const block = Math.max(1, Math.floor(data.length / bars));
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    const start = i * block;
    const end = i === bars - 1 ? data.length : start + block;
    let max = 0;
    for (let j = start; j < end; j++) {
      const v = Math.abs(data[j]);
      if (v > max) max = v;
    }
    out.push(max);
  }
  const peak = Math.max(...out, 1e-6);
  return out.map((v) => Math.min(1, v / peak));
}

function fallbackWaveform(bars: number): number[] {
  return Array.from({ length: bars }, (_, i) => 0.25 + 0.5 * Math.abs(Math.sin((i + 0.5) * 0.9)));
}

export async function extractWaveform(blob: Blob, bars = VOICE_WAVEFORM_BARS): Promise<number[]> {
  try {
    const arrayBuf = await blob.arrayBuffer();
    const Ctx =
      (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return fallbackWaveform(bars);
    const ctx = new Ctx();
    try {
      const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
      const wf = bufferWaveform(decoded, bars);
      await ctx.close().catch(() => {});
      return wf;
    } catch {
      await ctx.close().catch(() => {});
      return fallbackWaveform(bars);
    }
  } catch {
    return fallbackWaveform(bars);
  }
}

export type VoiceCapture = {
  blob: Blob;
  durationMs: number;
  waveform: number[];
  mimeType: string;
};

/** Imperative recorder — owns MediaRecorder + getUserMedia stream lifecycle. */
export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  /** Duration banked before the current run; `runStartedAt` is 0 while paused,
   * so paused time never counts toward the recording length. */
  private bankedMs = 0;
  private runStartedAt = 0;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelBuf: Uint8Array<ArrayBuffer> | null = null;

  mimeType: string | null = null;

  async start(): Promise<void> {
    if (this.recorder) throw new Error("already recording");
    const mime = getPreferredVoiceMimeType();
    if (!mime) throw new Error("Voice recording not supported in this WebView");
    this.mimeType = mime;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    this.chunks = [];
    this.bankedMs = 0;
    this.runStartedAt = Date.now();

    this.recorder = new MediaRecorder(this.stream, { mimeType: mime });
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    // No timeslice: chunks are only concatenated at the end, and stitching
    // hundreds of fragments back together made playback stutter at the seams.
    this.recorder.start();

    // Best-effort input meter: without AudioContext recording still works,
    // `level` just reads 0.
    try {
      const Ctx =
        (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
          .AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        this.audioCtx = new Ctx();
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 1024;
        this.levelBuf = new Uint8Array(this.analyser.fftSize);
        this.audioCtx.createMediaStreamSource(this.stream).connect(this.analyser);
      }
    } catch {
      this.analyser = null;
    }
  }

  /** Peak amplitude of the last input frame, 0..1. */
  get level(): number {
    if (!this.analyser || !this.levelBuf) return 0;
    this.analyser.getByteTimeDomainData(this.levelBuf);
    let peak = 0;
    for (const v of this.levelBuf) {
      const d = Math.abs(v - 128) / 128;
      if (d > peak) peak = d;
    }
    return Math.min(1, peak);
  }

  get durationMs(): number {
    return this.bankedMs + (this.runStartedAt ? Date.now() - this.runStartedAt : 0);
  }

  get isPaused(): boolean {
    return !!this.recorder && this.recorder.state === "paused";
  }

  /** False when this WebView's MediaRecorder won't honour pause/resume. */
  pause(): boolean {
    if (!this.recorder || this.recorder.state !== "recording") return false;
    try {
      this.recorder.pause();
    } catch {
      return false;
    }
    // Cast because TS can't see that pause() mutates `state`; the check is real,
    // a WebView can accept the call and stay recording.
    if ((this.recorder.state as string) !== "paused") return false;
    this.bankedMs += Date.now() - this.runStartedAt;
    this.runStartedAt = 0;
    return true;
  }

  resume(): boolean {
    if (!this.recorder || this.recorder.state !== "paused") return false;
    try {
      this.recorder.resume();
    } catch {
      return false;
    }
    this.runStartedAt = Date.now();
    return true;
  }

  async stop(): Promise<VoiceCapture> {
    const rec = this.recorder;
    const stream = this.stream;
    if (!rec) throw new Error("not recording");
    const mime = this.mimeType ?? "audio/webm";
    const durationMs = this.durationMs;
    this.recorder = null;
    this.stream = null;
    this.runStartedAt = 0;
    this.closeMeter();

    const chunksRef = this.chunks;
    this.chunks = [];

    // stop() fires the final `dataavailable` before `stop`, so only `stop` means
    // the recording is complete. Resolving on a short timer instead handed back
    // whatever had arrived — a truncated, glitchy clip.
    const blob: Blob = await new Promise((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error("MediaRecorder never stopped")), 5000);
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.push(e.data);
      };
      rec.onstop = () => {
        clearTimeout(guard);
        resolve(new Blob(chunksRef, { type: mime }));
      };
      rec.onerror = () => {
        clearTimeout(guard);
        reject(new Error("MediaRecorder error"));
      };
      try {
        rec.stop();
      } catch (e) {
        clearTimeout(guard);
        reject(e as Error);
      }
    });

    stream?.getTracks().forEach((t) => t.stop());

    if (durationMs < MIN_VOICE_DURATION_MS) throw new Error("Recording too short");

    const waveform = await extractWaveform(blob);
    return { blob, durationMs, waveform, mimeType: mime };
  }

  cancel(): void {
    try {
      if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    } catch {
      // ignore
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
    this.runStartedAt = 0;
    this.closeMeter();
  }

  private closeMeter(): void {
    this.analyser = null;
    this.levelBuf = null;
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }
}
