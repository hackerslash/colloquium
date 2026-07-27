import { useRef, useState } from "react";
import { cx } from "../../lib/cx";
import { formatClock } from "../../lib/time";

type ScrubberProps = {
  positionSec: number;
  durationSec: number;
  /** Contiguous buffer ahead of the playhead, from the player. Drawn as a real
   * measurement — no decorative "loading" fill. */
  bufferedSec: number;
  disabled: boolean;
  onSeek: (sec: number) => void;
};

/**
 * The seek bar. A real `input[type=range]` carries the interaction — click,
 * drag, arrow keys and screen-reader semantics all come free — and is laid
 * transparently over the painted track, so the visuals are ours and the
 * behaviour is the platform's.
 */
export function Scrubber({
  positionSec,
  durationSec,
  bufferedSec,
  disabled,
  onSeek,
}: ScrubberProps) {
  const railRef = useRef<HTMLDivElement>(null);
  // Held while the pointer owns the thumb, so incoming sync positions don't
  // yank it out from under the drag.
  const [dragSec, setDragSec] = useState<number | null>(null);
  const [hover, setHover] = useState<{ sec: number; x: number } | null>(null);

  const duration = durationSec > 0 ? durationSec : 0;
  const shown = dragSec ?? Math.min(positionSec, duration || positionSec);
  const pct = (sec: number) => (duration > 0 ? Math.min(100, Math.max(0, (sec / duration) * 100)) : 0);

  return (
    <div className="group relative flex h-5 w-full items-center">
      <div
        ref={railRef}
        className={cx(
          "relative h-1 w-full overflow-hidden rounded-full bg-white/20 transition-[height] duration-150",
          // The range input is transparent, so its own focus ring would be
          // invisible; the rail wears it instead.
          "group-focus-within:outline-2 group-focus-within:outline-offset-4 group-focus-within:outline-accent",
          !disabled && "group-hover:h-1.5 group-focus-within:h-1.5",
        )}
      >
        <div
          className="absolute inset-y-0 left-0 bg-white/35"
          style={{ width: `${pct(shown + Math.max(0, bufferedSec))}%` }}
        />
        <div
          className="absolute inset-y-0 left-0 bg-accent"
          style={{ width: `${pct(shown)}%` }}
        />
      </div>

      <span
        aria-hidden="true"
        className={cx(
          "pointer-events-none absolute h-3 w-3 -translate-x-1/2 rounded-full bg-accent shadow-sm transition-transform duration-150",
          "scale-0 motion-reduce:transition-none",
          !disabled && "group-hover:scale-100 group-focus-within:scale-100",
        )}
        style={{ left: `${pct(shown)}%` }}
      />

      {hover && !disabled && duration > 0 && (
        <span
          className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 rounded-md bg-bg-base px-1.5 py-0.5 text-xs tabular-nums text-text-primary shadow-md"
          style={{ left: `${hover.x}px` }}
        >
          {formatClock(hover.sec)}
        </span>
      )}

      <input
        type="range"
        aria-label="Seek"
        min={0}
        max={duration || 1}
        step={0.1}
        value={shown}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (dragSec !== null) setDragSec(v);
          onSeek(v);
        }}
        onPointerDown={() => setDragSec(shown)}
        onPointerUp={() => setDragSec(null)}
        onPointerCancel={() => setDragSec(null)}
        onPointerMove={(e) => {
          const rect = railRef.current?.getBoundingClientRect();
          if (!rect || rect.width === 0) return;
          const x = Math.min(rect.width, Math.max(0, e.clientX - rect.left));
          setHover({ sec: (x / rect.width) * duration, x });
        }}
        onPointerLeave={() => setHover(null)}
        className={cx(
          "absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0",
          disabled && "cursor-not-allowed",
        )}
      />
    </div>
  );
}
