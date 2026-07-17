import { MonitorUp } from "lucide-react";
import { IconButton } from "../ui/IconButton";

type ScreenShareButtonProps = {
  screenOn: boolean;
  disabled?: boolean;
  onToggle: () => void;
  label?: string;
};

/**
 * The screen-share toggle in the control bar. Quality selection lives in the
 * on-screen quality badge (ScreenQualityBadge) shown while sharing, so this is
 * just a start/stop button.
 */
export function ScreenShareButton({ screenOn, disabled, onToggle, label }: ScreenShareButtonProps) {
  return (
    <IconButton
      icon={MonitorUp}
      label={label || (screenOn ? "Stop sharing" : "Share screen")}
      size="lg"
      variant={screenOn ? "accent" : "solid"}
      active={screenOn}
      disabled={disabled}
      onClick={onToggle}
    />
  );
}
