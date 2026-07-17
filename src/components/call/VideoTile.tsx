import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { Maximize2, Minimize2 } from "lucide-react";
import type { ConnectionQuality } from "../../services/call/PeerConnectionWrapper";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { Avatar } from "../ui/Avatar";
import { cx } from "../../lib/cx";

/** setSinkId exists in Chromium-based browsers but is not yet in TypeScript's
 * lib.dom — extend the interface so we can call it without `any` casts. */
declare global {
  interface HTMLMediaElement {
    setSinkId?(sinkId: string): Promise<void>;
  }
}

type VideoTileProps = {
  stream: MediaStream | null;
  muted?: boolean;
  mirror?: boolean;
  label: string;
  hasVideo: boolean;
  /** "grid": fixed 16:9 tile (cameras). "fill": fills whatever box the layout
   * gives it, bounded by BOTH axes — screens letterbox to their natural
   * aspect instead of being cropped by a forced 16:9 container. */
  fit?: "grid" | "fill";
  /** Real identity id for a deterministic avatar color (falls back to label). */
  participantId?: string;
  quality?: ConnectionQuality;
  speaking?: boolean;
};

const QUALITY_DOT: Record<ConnectionQuality, string> = {
  good: "bg-success",
  fair: "bg-warning",
  poor: "bg-danger",
  unknown: "bg-text-muted",
};

function VideoInner({ stream, muted, mirror, label, hasVideo, participantId }: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioOutputDeviceId = useSettingsStore((s) => s.audioOutputDeviceId);

  useEffect(() => {
    const el = videoRef.current;
    if (el && el.srcObject !== stream) el.srcObject = stream;
  }, [stream]);

  // Apply the selected audio output device (speaker/headphone routing).
  // setSinkId is only available in Chromium-based browsers; guard before calling.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !el.setSinkId) return;
    const id = audioOutputDeviceId ?? "";
    el.setSinkId(id).catch((err) => {
      // Device may have been unplugged or the id is stale — fail silently.
      console.warn("VideoTile: setSinkId failed", err);
    });
  }, [audioOutputDeviceId]);

  return (
    <>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className={cx("h-full w-full object-contain", !hasVideo && "hidden", mirror && "-scale-x-100")}
      />
      {!hasVideo && <Avatar id={participantId ?? label} name={label} size="xl" />}
      <span className="absolute bottom-2 left-2 rounded-md bg-black/60 px-2 py-0.5 text-xs text-white backdrop-blur-sm">
        {label}
      </span>
    </>
  );
}

export function VideoTile({
  stream,
  muted,
  mirror,
  label,
  hasVideo,
  fit = "grid",
  participantId,
  quality,
  speaking,
}: VideoTileProps) {
  const [expanded, setExpanded] = useState(false);
  const inner = { stream, muted, mirror, label, hasVideo, participantId };

  return (
    <>
      <div
        onDoubleClick={() => setExpanded(true)}
        className={cx(
          "group relative flex items-center justify-center overflow-hidden rounded-lg bg-black ring-1 ring-border/50",
          fit === "fill" ? "h-full w-full min-h-0" : "aspect-video",
        )}
      >
        {speaking && (
          <motion.div
            layoutId={`speaking-ring-${label}`}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="absolute inset-0 z-10 rounded-lg border-2 border-success"
          />
        )}
        <VideoInner {...inner} />
        {quality && quality !== "unknown" && (
          <span
            className={cx("absolute left-2 top-2 h-2 w-2 rounded-full", QUALITY_DOT[quality])}
            aria-hidden="true"
          />
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(true);
          }}
          aria-label="Expand to fullscreen"
          title="Expand (or double-click)"
          className="absolute right-2 top-2 flex rounded bg-black/50 p-1 text-white opacity-0 transition-opacity group-hover:opacity-90 hover:!opacity-100"
        >
          <Maximize2 size={14} aria-hidden="true" />
        </button>
      </div>

      {expanded &&
        createPortal(
          <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black"
            onDoubleClick={() => setExpanded(false)}
          >
            <VideoInner {...inner} />
            <button
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(false);
              }}
              aria-label="Exit fullscreen"
              title="Exit fullscreen (or double-click)"
              className="absolute right-4 top-4 flex rounded bg-black/60 p-2 text-white opacity-70 transition-opacity hover:opacity-100"
            >
              <Minimize2 size={16} aria-hidden="true" />
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
