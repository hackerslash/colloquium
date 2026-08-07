import { useEffect, useRef, useState } from "react";
import { Download, Pause, Play } from "lucide-react";
import type { Message } from "../../types/domain";
import * as fileRepo from "../../services/db/fileRepo";
import * as chatService from "../../services/room/chatService";
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

export function VoicePlayer({ message, isOwn }: { message: Message; isOwn: boolean }) {
/** Bars are sized in px, never `flex-1`: the message bubble is shrink-to-fit,
 * so percentage-width bars resolve to zero and the waveform disappears. */
const BAR_W = 3;
const BAR_GAP = 2;
const BAR_MIN_H = 3;
const BAR_MAX_H = 24;

function Bars({ waveform, className }: { waveform: number[]; className: string }) {
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
}

  const [url, setUrl] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const requestTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState<number>(message.voiceDurationMs ?? 0);

  const waveform = message.voiceWaveform ?? Array.from({ length: VOICE_WAVEFORM_BARS }, () => 0.4);

  useEffect(() => () => clearTimeout(requestTimer.current), []);

  useEffect(() => {
    if (!message.attachmentId) return;
    let cancelled = false;
    let objectUrl: string | null = null;

    function check() {
      const id = message.attachmentId!;
      fileRepo.fileExists(id).then((exists) => {
        if (cancelled) return;
        setAvailable(exists);
        if (!exists) {
          if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = null;
          }
          setUrl(null);
          return;
        }
        fileRepo.getFile(id).then((file) => {
          if (cancelled || !file) return;
          const blob = new Blob([file.data], { type: file.mimeType });
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        });
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

  function fetchFromSender() {
    if (!chatService.requestAttachment(message)) {
      toast.info("Sender is offline", "Voice will be available when they're back online.");
      return;
    }
    setRequesting(true);
    clearTimeout(requestTimer.current);
    requestTimer.current = setTimeout(() => setRequesting(false), 30_000);
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
    audio.currentTime = ms / 1000;
    setCurrentMs(ms);
  }

  const progress = durationMs ? Math.min(1, currentMs / durationMs) : 0;
  const trackW = waveform.length * BAR_W + (waveform.length - 1) * BAR_GAP;

  if (!available) {
    return (
      <div className={cx("mt-1 flex items-center gap-2 rounded px-3 py-2 text-xs", isOwn ? "bg-black/20" : "bg-black/10")}>
        <span className="flex-1 truncate text-text-muted">Voice message — not downloaded</span>
        {!isOwn && (
          <button
            type="button"
            onClick={fetchFromSender}
            disabled={requesting}
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
        "mt-1 flex items-center gap-3 rounded-lg px-3 py-2",
        isOwn ? "bg-black/20" : "bg-black/10",
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
              "pointer-events-none absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full shadow",
              isOwn ? "bg-white" : "bg-accent",
            )}
            style={{ left: `${progress * 100}%` }}
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

      <span className="shrink-0 text-xs tabular-nums text-text-muted">
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

      {url && (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setDurationMs(Math.round(d * 1000));
          }}
          onTimeUpdate={(e) => setCurrentMs(Math.round(e.currentTarget.currentTime * 1000))}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => {
            setIsPlaying(false);
            setCurrentMs(0);
          }}
          className="hidden"
        />
      )}
    </div>
  );
}
