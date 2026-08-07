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
  private startedAt = 0;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private onAutoStop: (() => void) | null = null;

  mimeType: string | null = null;

  async start(opts?: { onAutoStop?: () => void }): Promise<void> {
    if (this.recorder) throw new Error("already recording");
    this.onAutoStop = opts?.onAutoStop ?? null;
    const mime = getPreferredVoiceMimeType();
    if (!mime) throw new Error("Voice recording not supported in this WebView");
    this.mimeType = mime;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    this.chunks = [];
    this.startedAt = Date.now();

    this.recorder = new MediaRecorder(this.stream, { mimeType: mime });
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(100);

    this.maxTimer = setTimeout(() => this.onAutoStop?.(), MAX_VOICE_DURATION_MS);
  }

  get durationMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  get isRecording(): boolean {
    return !!this.recorder && this.recorder.state === "recording";
  }

  async stop(): Promise<VoiceCapture> {
    const rec = this.recorder;
    const stream = this.stream;
    if (!rec) throw new Error("not recording");
    if (this.maxTimer) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
    const mime = this.mimeType ?? "audio/webm";
    const durationMs = this.durationMs;
    this.recorder = null;
    this.stream = null;

    const chunksRef = this.chunks;
    this.chunks = [];

    const blob: Blob = await new Promise((resolve, reject) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        resolve(new Blob(chunksRef, { type: mime }));
      };
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.push(e.data);
      };
      rec.onstop = finish;
      rec.onerror = () => {
        if (!resolved) reject(new Error("MediaRecorder error"));
      };
      try {
        rec.stop();
      } catch (e) {
        reject(e as Error);
      }
      setTimeout(finish, 400);
    });

    stream?.getTracks().forEach((t) => t.stop());

    if (durationMs < MIN_VOICE_DURATION_MS) throw new Error("Recording too short");

    const waveform = await extractWaveform(blob);
    return { blob, durationMs, waveform, mimeType: mime };
  }

  cancel(): void {
    if (this.maxTimer) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
    try {
      if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    } catch {
      // ignore
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
  }
}
