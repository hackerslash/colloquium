import { useCallback, useRef, useState, useEffect } from "react";

export type Position = { x: number; y: number };

export function useDraggable(initialPos?: Position) {
  const [pos, setPos] = useState<Position | null>(initialPos ?? null);
  const dragRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const offset = useRef<Position>({ x: 0, y: 0 });

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Only drag with left mouse button
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Don't drag if clicking interactive elements inside header
    if (target.closest("button, input, select, textarea, a, [data-nodrag]")) return;

    const rect = dragRef.current?.getBoundingClientRect();
    if (!rect) return;

    dragging.current = true;
    offset.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
    target.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const newX = e.clientX - offset.current.x;
    const newY = e.clientY - offset.current.y;

    // Keep within window bounds with padding
    const maxX = Math.max(10, window.innerWidth - (dragRef.current?.offsetWidth ?? 300) - 10);
    const maxY = Math.max(10, window.innerHeight - (dragRef.current?.offsetHeight ?? 200) - 10);

    setPos({
      x: Math.max(10, Math.min(newX, maxX)),
      y: Math.max(10, Math.min(newY, maxY)),
    });
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (dragging.current) {
      dragging.current = false;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // Safe fallback
      }
    }
  }, []);

  // Window resize handler to keep within bounds
  useEffect(() => {
    function handleResize() {
      setPos((prev) => {
        if (!prev || !dragRef.current) return prev;
        const maxX = Math.max(10, window.innerWidth - dragRef.current.offsetWidth - 10);
        const maxY = Math.max(10, window.innerHeight - dragRef.current.offsetHeight - 10);
        return {
          x: Math.max(10, Math.min(prev.x, maxX)),
          y: Math.max(10, Math.min(prev.y, maxY)),
        };
      });
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return {
    pos,
    setPos,
    dragRef,
    headerProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
    },
  };
}
