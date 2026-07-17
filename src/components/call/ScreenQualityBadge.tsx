import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Check, ChevronDown, MonitorUp } from "lucide-react";
import type { ConnectionQuality } from "../../services/call/PeerConnectionWrapper";
import { SCREEN_SHARE_OPTIONS, type ScreenShareQualityOption } from "../../services/call/screenShareConfig";
import { cx } from "../../lib/cx";

type ScreenQualityBadgeProps = {
  currentConfig: ScreenShareQualityOption;
  onConfigChange: (config: ScreenShareQualityOption) => void;
  /** Live connection quality, shown as read-only info in the popup. */
  quality?: ConnectionQuality;
};

const QUALITY_META: Record<ConnectionQuality, { dot: string; label: string }> = {
  good: { dot: "bg-success", label: "Good" },
  fair: { dot: "bg-warning", label: "Fair" },
  poor: { dot: "bg-danger", label: "Poor" },
  unknown: { dot: "bg-text-muted", label: "Measuring…" },
};

function describe(config: ScreenShareQualityOption) {
  return {
    resolution: config.width && config.height ? `${config.width}×${config.height}` : "Native",
    frameRate: config.frameRate ? `${config.frameRate} fps` : "Adaptive",
    bitrate: config.maxBitrate ? `${(config.maxBitrate / 1_000_000).toFixed(config.maxBitrate < 1_000_000 ? 1 : 0)} Mbps` : "Adaptive",
  };
}

/**
 * On-screen screen-share quality control: a compact pill (top-right of the call
 * stage) showing the active quality. Clicking it opens a translucent panel with
 * the live stream details and options to switch quality on the fly.
 */
export function ScreenQualityBadge({ currentConfig, onConfigChange, quality }: ScreenQualityBadgeProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const info = describe(currentConfig);
  const q = QUALITY_META[quality ?? "unknown"];

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Screen share quality"
        className={cx(
          "flex items-center gap-1.5 rounded-full border border-white/15 bg-black/45 py-1 pl-2.5 pr-2 text-xs font-medium text-white/90 backdrop-blur-md transition-colors hover:bg-black/60",
          open && "bg-black/70",
        )}
      >
        <MonitorUp size={13} aria-hidden="true" className="text-white/70" />
        {currentConfig.short}
        <ChevronDown
          size={13}
          aria-hidden="true"
          className={cx("text-white/60 transition-transform", open && "rotate-180")}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
            className="absolute right-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-2xl border border-white/12 bg-bg-elevated/75 shadow-modal backdrop-blur-2xl"
          >
            {/* Live stream details */}
            <div className="border-b border-white/10 p-3">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                Screen share
              </p>
              <dl className="grid grid-cols-2 gap-y-1.5 text-xs">
                <dt className="text-text-secondary">Resolution</dt>
                <dd className="text-right font-medium text-text-primary">{info.resolution}</dd>
                <dt className="text-text-secondary">Frame rate</dt>
                <dd className="text-right font-medium text-text-primary">{info.frameRate}</dd>
                <dt className="text-text-secondary">Bitrate cap</dt>
                <dd className="text-right font-medium text-text-primary">{info.bitrate}</dd>
                {quality !== undefined && (
                  <>
                    <dt className="text-text-secondary">Connection</dt>
                    <dd className="flex items-center justify-end gap-1.5 font-medium text-text-primary">
                      <span className={cx("h-1.5 w-1.5 rounded-full", q.dot)} aria-hidden="true" />
                      {q.label}
                    </dd>
                  </>
                )}
              </dl>
            </div>

            {/* Quality switcher */}
            <div className="p-1.5">
              <p className="mb-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                Change quality
              </p>
              <div className="flex flex-col">
                {SCREEN_SHARE_OPTIONS.map((opt) => {
                  const active = currentConfig.id === opt.id;
                  return (
                    <button
                      key={opt.id}
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => {
                        onConfigChange(opt);
                        setOpen(false);
                      }}
                      className={cx(
                        "flex items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12px] font-medium transition-colors",
                        active
                          ? "bg-accent/15 text-accent"
                          : "text-text-secondary hover:bg-white/5 hover:text-text-primary",
                      )}
                    >
                      {opt.label}
                      {active && <Check size={14} aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
