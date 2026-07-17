import { useState, useRef } from "react";
import { MonitorUp } from "lucide-react";
import { IconButton } from "../ui/IconButton";
import { SCREEN_SHARE_OPTIONS, type ScreenShareQualityOption } from "../../services/call/screenShareConfig";
import { cx } from "../../lib/cx";

type ScreenShareButtonProps = {
  screenOn: boolean;
  disabled?: boolean;
  currentConfig: ScreenShareQualityOption;
  onConfigChange: (config: ScreenShareQualityOption) => void;
  onToggle: () => void;
  label?: string;
};

export function ScreenShareButton({
  screenOn,
  disabled,
  currentConfig,
  onConfigChange,
  onToggle,
  label,
}: ScreenShareButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleMouseEnter() {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setMenuOpen(true);
  }

  function handleMouseLeave() {
    timeoutRef.current = setTimeout(() => {
      setMenuOpen(false);
    }, 200);
  }

  return (
    <div 
      className="relative flex items-center justify-center"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <IconButton
        icon={MonitorUp}
        label={label || (screenOn ? "Stop sharing" : "Share screen")}
        size="lg"
        variant={screenOn ? "accent" : "solid"}
        active={screenOn}
        disabled={disabled}
        onClick={onToggle}
      />
      
      {/* Dropup Menu */}
      {menuOpen && !disabled && (
        <div className="absolute bottom-full left-1/2 mb-2 w-48 -translate-x-1/2 rounded-xl border border-border/50 bg-bg-elevated p-1.5 shadow-lg animate-in fade-in zoom-in-95 duration-100">
          <div className="mb-1 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            Quality Settings
          </div>
          <div className="flex flex-col">
            {SCREEN_SHARE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                onClick={() => {
                  onConfigChange(opt);
                  setMenuOpen(false);
                }}
                className={cx(
                  "flex items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12px] font-medium transition-colors",
                  currentConfig.id === opt.id
                    ? "bg-accent/15 text-accent"
                    : "text-text-secondary hover:bg-bg-secondary hover:text-text-primary"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
