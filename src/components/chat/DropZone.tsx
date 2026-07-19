import { useCallback, useRef, useState, type DragEvent, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { UploadCloud } from "lucide-react";

type DropZoneProps = {
  /** First dropped file is handed off (the composer only supports one attachment). */
  onFileDrop: (file: File) => void;
  children: ReactNode;
};

function isFileDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

/** Wraps a chat surface (DM or room) so any OS file drag over the window —
 * message list, header, composer, anywhere — attaches the file, Discord-style.
 * Depth is counted rather than toggled on enter/leave because those events
 * fire per child element as the pointer crosses them, and a plain boolean
 * would flicker the overlay off every time the pointer passes over a nested
 * element on its way further into the window. */
export function DropZone({ onFileDrop, children }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const depth = useRef(0);

  const handleDragEnter = useCallback((e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    depth.current += 1;
    setIsDragging(true);
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth.current = 0;
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) onFileDrop(file);
    },
    [onFileDrop],
  );

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {children}
      <AnimatePresence>
        {isDragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-bg-primary/85 backdrop-blur-sm"
          >
            <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-accent/70 bg-bg-elevated px-10 py-8 shadow-xl">
              <UploadCloud size={36} className="text-accent" />
              <p className="text-sm font-semibold text-text-primary">Drop file to attach</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
