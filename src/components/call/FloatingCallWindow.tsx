import { useState, type ReactNode } from "react";
import { Maximize2, Minimize2, Minus, Move, PhoneOff } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { useDraggable } from "../../hooks/useDraggable";
import { cx } from "../../lib/cx";

type WindowState = "normal" | "minimized" | "maximized";

type FloatingCallWindowProps = {
  title: string;
  statusLabel?: string;
  statusDotColor?: string;
  onHangUp?: () => void;
  children: ReactNode;
  controls?: ReactNode;
  headerExtra?: ReactNode;
};

export function FloatingCallWindow({
  title,
  statusLabel,
  statusDotColor,
  onHangUp,
  children,
  controls,
  headerExtra,
}: FloatingCallWindowProps) {
  const [windowState, setWindowState] = useState<WindowState>("normal");
  const { pos, dragRef, headerProps } = useDraggable();

  function toggleMaximize() {
    setWindowState((s) => (s === "maximized" ? "normal" : "maximized"));
  }

  function toggleMinimize() {
    setWindowState((s) => (s === "minimized" ? "normal" : "minimized"));
  }

  // Calculate positioning style based on state
  const isMaximized = windowState === "maximized";
  const isMinimized = windowState === "minimized";

  let containerStyle: React.CSSProperties = {};
  if (isMaximized) {
    containerStyle = {
      position: "fixed",
      inset: "12px",
      zIndex: 60,
    };
  } else if (isMinimized) {
    containerStyle = {
      position: "fixed",
      bottom: "24px",
      right: "24px",
      width: "360px",
      height: "240px",
      zIndex: 60,
    };
  } else if (pos) {
    containerStyle = {
      position: "fixed",
      left: `${pos.x}px`,
      top: `${pos.y}px`,
      width: "min(840px, calc(100vw - 32px))",
      height: "min(560px, calc(100vh - 64px))",
      zIndex: 60,
    };
  } else {
    // Initial centered default position
    containerStyle = {
      position: "fixed",
      left: "50%",
      top: "50%",
      transform: "translate(-50%, -50%)",
      width: "min(840px, calc(100vw - 32px))",
      height: "min(560px, calc(100vh - 64px))",
      zIndex: 60,
    };
  }

  return (
    <AnimatePresence>
      <motion.div
        ref={dragRef}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        style={containerStyle}
        className={cx(
          "flex flex-col overflow-hidden rounded-2xl border border-border bg-bg-primary shadow-2xl backdrop-blur-md transition-shadow",
          isMinimized && "ring-2 ring-accent/30 shadow-modal",
        )}
      >
        {/* Window Header */}
        <header
          {...(isMaximized ? {} : headerProps)}
          onDoubleClick={toggleMaximize}
          className={cx(
            "flex h-11 shrink-0 items-center justify-between border-b border-border bg-bg-secondary/80 px-4 select-none",
            !isMaximized && "cursor-grab active:cursor-grabbing",
          )}
        >
          <div className="flex items-center gap-2 min-w-0">
            <Move size={14} className="text-text-muted shrink-0 opacity-60" aria-hidden="true" />
            <span className="font-semibold text-sm text-text-primary truncate">{title}</span>
            {statusLabel && (
              <span className="flex items-center gap-1.5 text-xs text-text-secondary truncate">
                {statusDotColor && (
                  <span className={cx("h-2 w-2 rounded-full shrink-0", statusDotColor)} aria-hidden="true" />
                )}
                {statusLabel}
              </span>
            )}
            {headerExtra}
          </div>

          <div className="flex items-center gap-1 shrink-0" data-nodrag>
            <button
              onClick={toggleMinimize}
              aria-label={isMinimized ? "Expand call window" : "Minimize call window"}
              title={isMinimized ? "Expand" : "Minimize to picture-in-picture"}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
            >
              {isMinimized ? <Maximize2 size={14} /> : <Minus size={14} />}
            </button>

            {!isMinimized && (
              <button
                onClick={toggleMaximize}
                aria-label={isMaximized ? "Restore window" : "Maximize window"}
                title={isMaximized ? "Restore window size" : "Maximize window"}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
              >
                {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            )}

            {onHangUp && (
              <button
                onClick={onHangUp}
                aria-label="Hang up call"
                title="Hang up call"
                className="flex h-7 w-7 items-center justify-center rounded-lg bg-danger/10 text-danger hover:bg-danger hover:text-white transition-colors ml-1"
              >
                <PhoneOff size={14} />
              </button>
            )}
          </div>
        </header>

        {/* Call Content Area */}
        <div className="relative flex flex-1 min-h-0 flex-col overflow-hidden bg-bg-base/40">
          {children}

          {/* Controls Bar at bottom if provided and not minimized */}
          {!isMinimized && controls && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 pointer-events-auto">
              {controls}
            </div>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
