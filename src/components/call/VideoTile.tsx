import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type VideoTileProps = {
  stream: MediaStream | null;
  muted?: boolean;
  mirror?: boolean;
  label: string;
  hasVideo: boolean;
};

/** Renders the actual <video> element, reused in both normal and fullscreen modes. */
function VideoInner({
  stream,
  muted,
  mirror,
  label,
  hasVideo,
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (el && el.srcObject !== stream) el.srcObject = stream;
  }, [stream]);

  return (
    <>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className={`h-full w-full object-contain ${hasVideo ? "" : "hidden"} ${
          mirror ? "-scale-x-100" : ""
        }`}
      />
      {!hasVideo && (
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-bg-tertiary text-xl font-semibold text-text-primary">
          {label.slice(0, 1).toUpperCase()}
        </div>
      )}
      <span className="absolute bottom-2 left-2 rounded bg-black/50 px-2 py-0.5 text-xs text-white">
        {label}
      </span>
    </>
  );
}

export function VideoTile({ stream, muted, mirror, label, hasVideo }: VideoTileProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      {/* Normal inline tile */}
      <div
        onDoubleClick={() => setExpanded(true)}
        className="group relative flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-black"
      >
        <VideoInner
          stream={stream}
          muted={muted}
          mirror={mirror}
          label={label}
          hasVideo={hasVideo}
        />
        {/* Expand button — visible on hover */}
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
          aria-label="Expand to fullscreen"
          title="Expand (or double-click)"
          className="absolute right-2 top-2 flex rounded bg-black/50 p-1 text-white opacity-0 transition-opacity group-hover:opacity-90 hover:!opacity-100"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </button>
      </div>

      {/* CSS fullscreen overlay — rendered into document.body via portal */}
      {expanded &&
        createPortal(
          <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black"
            onDoubleClick={() => setExpanded(false)}
          >
            <VideoInner
              stream={stream}
              muted={muted}
              mirror={mirror}
              label={label}
              hasVideo={hasVideo}
            />
            {/* Close button */}
            <button
              onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
              aria-label="Exit fullscreen"
              title="Exit fullscreen (or double-click)"
              className="absolute right-4 top-4 flex rounded bg-black/60 p-2 text-white opacity-70 transition-opacity hover:opacity-100"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="10" y1="14" x2="21" y2="3" />
                <line x1="3" y1="21" x2="14" y2="10" />
              </svg>
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
