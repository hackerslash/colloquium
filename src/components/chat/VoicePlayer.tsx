import { memo, useEffect, useRef, useState } from "react";
import { Download, Pause, Play } from "lucide-react";
import type { Message } from "../../types/domain";
import * as fileRepo from "../../services/db/fileRepo";
import { fetchAttachment } from "../../lib/fetchAttachment";
import { toast } from "../../stores/useToastStore";
import { cx } from "../../lib/cx";
import { saveToDisk } from "../../lib/saveFile";
import { VOICE_WAVEFORM_BARS } from "../../services/room/voiceRecorder";

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** Bars are sized in px, never `flex-1`: the message bubble is shrink-to-fit,
 * so percentage-width bars resolve to zero and the waveform disappears. */
const BAR_W = 3;
const BAR_GAP = 2;
const BAR_MIN_H = 3;
const BAR_MAX_H = 24;
const DOT_SIZE = 10;

/** Stable identity so `Bars` can memo out of the per-frame play-head renders. */
const FLAT_WAVEFORM = Array.from({ length: VOICE_WAVEFORM_BARS }, () => 0.4);

const Bars = memo(function Bars({ waveform, className }: { waveform: number[]; className: string }) {
  return (
    <div className="absolute inset-y-0 left-0 flex items-center" style={{ gap: `${BAR_GAP}px` }}>
      {waveform.map((v, i) => (
        <span
          key={i}
          className={cx("shrink-0 rounded-full", className)}
          style={{ width: `${BAR_W}px`, height: `${BAR_MIN_H + v * (BAR_MAX_H - BAR_MIN_H)}px` }}
        />
      ))}
    </div>
  );
});

export function VoicePlayer({ message, isOwn }: { message: Message; isOwn: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState<number>(message.voiceDurationMs ?? 0);

  const waveform = message.voiceWaveform ?? FLAT_WAVEFORM;

  useEffect(() => {
    if (!message.attachmentId) return;
    let cancelled = false;
    let objectUrl: string | null = null;

    // One round-trip, not two: gating on `fileExists` first left the play button
    // disabled across two IPC hops, which reads as "play does nothing".
    function check() {
      fileRepo.getFile(message.attachmentId!).then((file) => {
        if (cancelled) return;
        setLoaded(true);
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = null;
        }
        if (!file) {
          setUrl(null);
          return;
        }
        objectUrl = URL.createObjectURL(new Blob([file.data], { type: file.mimeType }));
        setUrl(objectUrl);
      });
    }
    check();
    const handler = (e: Event) => {
      const ce = e as CustomEvent<string>;
      if (ce.detail === message.attachmentId) {
        setRequesting(false);
        check();
      }
    };
    window.addEventListener("colloquium_file_downloaded", handler);
    return () => {
      cancelled = true;
      window.removeEventListener("colloquium_file_downloaded", handler);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [message.attachmentId]);

  // `timeupdate` only fires ~4x/sec, so a play head driven by it visibly steps.
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) setCurrentMs(audio.currentTime * 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);

  function fetchFromSender() {
    setRequesting(true);
    void fetchAttachment(message).finally(() => setRequesting(false));
  }

  async function downloadFile() {
    if (!message.attachmentId) return;
    const file = await fileRepo.getFile(message.attachmentId);
    if (!file) {
      toast.error("Download failed", "This voice message is no longer stored locally.");
      return;
    }
    await saveToDisk(file.name, file.data, file.mimeType);
  }

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio || !url) return;
    if (isPlaying) {
      audio.pause();
    } else {
      void audio.play().catch(() => toast.error("Playback failed", "Audio could not be played."));
    }
  }

  function seekToMs(ms: number) {
    const audio = audioRef.current;
    if (!audio || !durationMs) return;
    // voiceDurationMs is the recorder's wall clock and can overshoot the decoded
    // length; seeking past the end plays nothing.
    const maxS = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : durationMs / 1000;
    const s = Math.min(ms / 1000, maxS);
    audio.currentTime = s;
    setCurrentMs(s * 1000);
  }

  const progress = durationMs ? Math.min(1, currentMs / durationMs) : 0;
  const trackW = waveform.length * BAR_W + (waveform.length - 1) * BAR_GAP;

  if (!url) {
    return (
      <div
        className={cx(
          "flex items-center gap-2 text-xs",
          message.body && cx("mt-1 rounded px-3 py-2", isOwn ? "bg-black/20" : "bg-black/10"),
        )}
      >
        <span className={cx("flex-1 truncate", isOwn ? "text-white/80" : "text-text-secondary")}>
          {loaded ? "Voice message — not downloaded" : "Voice message"}
        </span>
        {!isOwn && (
          <button
            type="button"
            onClick={fetchFromSender}
            // Before the lookup resolves, a fetch could re-request a file we hold.
            disabled={requesting || !loaded}
            className="shrink-0 rounded px-2 py-1 font-medium text-accent hover:bg-black/10 disabled:text-text-muted"
          >
            {requesting ? "Fetching…" : "Fetch"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className={cx(
        "flex items-center gap-3",
        // See MessageAttachment: only inset when there's a caption to separate from.
        message.body && cx("mt-1 rounded-lg px-3 py-2", isOwn ? "bg-black/20" : "bg-black/10"),
      )}
    >
      <button
        type="button"
        onClick={togglePlay}
        disabled={!url}
        aria-label={isPlaying ? "Pause voice message" : "Play voice message"}
        className={cx(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40",
          isOwn ? "bg-white text-accent hover:bg-white/90" : "bg-accent text-white hover:bg-accent/90",
        )}
      >
        {isPlaying ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
      </button>

      {/* Waveform: unplayed bars, a played layer clipped to the play head, and a
          transparent range input on top for drag + keyboard seeking. */}
      <div className="relative h-6 min-w-0 shrink overflow-hidden" style={{ width: `${trackW}px` }}>
        <Bars waveform={waveform} className={isOwn ? "bg-white/40" : "bg-accent/30"} />
        <div className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${progress * 100}%` }}>
          <div className="relative h-full" style={{ width: `${trackW}px` }}>
            <Bars waveform={waveform} className={isOwn ? "bg-white" : "bg-accent"} />
          </div>
        </div>
        {durationMs > 0 && (
          <span
            aria-hidden="true"
            className={cx(
              "pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full shadow",
              isOwn ? "bg-white" : "bg-accent",
            )}
            // Travel is inset by half the dot so the track's overflow-hidden
            // (which clips bars in a squeezed bubble) can't shave it at 0%/100%.
            style={{
              width: `${DOT_SIZE}px`,
              height: `${DOT_SIZE}px`,
              left: `calc(${DOT_SIZE / 2}px + ${progress} * (100% - ${DOT_SIZE}px))`,
            }}
          />
        )}
        <input
          type="range"
          min={0}
          max={durationMs || 0}
          step="any"
          value={Math.min(currentMs, durationMs || 0)}
          onChange={(e) => seekToMs(Number(e.target.value))}
          disabled={!url || !durationMs}
          aria-label="Seek voice message"
          aria-valuetext={`${formatMs(currentMs)} of ${formatMs(durationMs)}`}
          // Native appearance is kept deliberately: `appearance-none` without a
          // styled ::-webkit-slider-thumb drops the thumb's hit area and breaks
          // dragging. Opacity hides it; the bars above are the visible control.
          className="absolute inset-0 m-0 h-full w-full cursor-pointer p-0 opacity-0 disabled:cursor-default"
        />
      </div>

      <span className={cx("shrink-0 text-xs tabular-nums", isOwn ? "text-white/80" : "text-text-secondary")}>
        {currentMs > 0 ? formatMs(currentMs) : formatMs(durationMs || 0)}
      </span>

      <button
        type="button"
        onClick={() => void downloadFile()}
        aria-label="Download voice message"
        title="Download"
        className={cx("shrink-0 rounded p-1 transition-colors", isOwn ? "hover:bg-white/20" : "hover:bg-black/10")}
      >
        <Download size={14} />
      </button>

      <audio
        ref={audioRef}
        src={url}
        // `auto` not `metadata`: the blob is already in memory, and deferring the
        // buffer until play() is what made playback start late.
        preload="auto"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDurationMs(Math.round(d * 1000));
        }}
        // `playing` not `play`: `play` fires on the request, so the pause icon
        // showed while the element was still stalled and silent.
        onPlaying={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false);
          setCurrentMs(0);
        }}
        className="hidden"
      />
    </div>
  );
}
