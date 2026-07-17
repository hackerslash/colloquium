import type { ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";
import { cx } from "../../lib/cx";
import { Tooltip } from "./Tooltip";

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  /** Accessible name; also the tooltip text. */
  label: string;
  size?: "sm" | "md" | "lg";
  variant?: "ghost" | "solid" | "danger" | "accent";
  /** Pressed-state styling (mirrors aria-pressed). */
  active?: boolean;
  tooltip?: boolean;
  tooltipSide?: "top" | "bottom" | "left" | "right";
};

const SIZE: Record<NonNullable<IconButtonProps["size"]>, { btn: string; icon: number }> = {
  sm: { btn: "h-7 w-7", icon: 16 },
  md: { btn: "h-8 w-8", icon: 18 },
  lg: { btn: "h-11 w-11", icon: 22 },
};

const VARIANT: Record<NonNullable<IconButtonProps["variant"]>, string> = {
  ghost: "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary",
  solid: "bg-bg-tertiary text-text-primary hover:bg-bg-elevated",
  danger: "bg-danger text-white hover:bg-danger-hover",
  accent: "bg-accent text-white hover:bg-accent-hover",
};

export function IconButton({
  icon: Icon,
  label,
  size = "md",
  variant = "ghost",
  active = false,
  tooltip = true,
  tooltipSide = "top",
  className,
  ...rest
}: IconButtonProps) {
  const button = (
    <button
      aria-label={label}
      aria-pressed={active || undefined}
      className={cx(
        "inline-flex shrink-0 items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "lg" ? "rounded-full" : "rounded-md",
        SIZE[size].btn,
        VARIANT[variant],
        active && variant === "ghost" && "bg-bg-tertiary text-text-primary",
        className,
      )}
      {...rest}
    >
      <Icon size={SIZE[size].icon} aria-hidden="true" />
    </button>
  );
  return tooltip ? (
    <Tooltip label={label} side={tooltipSide}>
      {button}
    </Tooltip>
  ) : (
    button
  );
}
