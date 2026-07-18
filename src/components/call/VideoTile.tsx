import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { Maximize2, Minimize2 } from "lucide-react";
import type { ConnectionQuality } from "../../services/call/PeerConnectionWrapper";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { Avatar } from "../ui/Avatar";
import { cx } from "../../lib/cx";
import { QUALITY_DOT } from "./qualityDot";

/** setSinkId exists in Chromium-based browsers; declare on interface if needed. */
declare global {
  interface HTMLMediaElement {
    setSinkId(sinkId: string): Promise<void>;
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
  /** Avatar size for the no-video state; small tiles (PiP) should pass "md". */
  avatarSize?: "md" | "xl";
};

function VideoInner({ stream, muted, mirror, label, hasVideo, participantId, quality, avatarSize }: VideoTileProps) {
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
      {!hasVideo && <Avatar id={participantId ?? label} name={label} size={avatarSize ?? "xl"} />}
      <span className="absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-sm">
        {quality && quality !== "unknown" && (
          <span
            className={cx("h-1.5 w-1.5 shrink-0 rounded-full", QUALITY_DOT[quality])}
            aria-hidden="true"
          />
        )}
        <span className="truncate">{label}</span>
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
  avatarSize,
}: VideoTileProps) {
  const [expanded, setExpanded] = useState(false);
  const inner = { stream, muted, mirror, label, hasVideo, participantId, quality, avatarSize };

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
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="pointer-events-none absolute inset-0 z-10 rounded-lg border-2 border-success"
          />
        )}
        {/* Mute the inline copy while the fullscreen portal is open, else a
            remote tile plays its audio through two <video> elements at once. */}
        <VideoInner {...inner} muted={inner.muted || expanded} />
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
            <VideoInner {...inner} avatarSize="xl" />
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
