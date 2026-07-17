import type { ReactNode } from "react";
import { cx } from "../../lib/cx";

type TooltipProps = {
  label: string;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
};

const SIDE: Record<NonNullable<TooltipProps["side"]>, string> = {
  top: "bottom-full left-1/2 mb-1.5 -translate-x-1/2",
  bottom: "top-full left-1/2 mt-1.5 -translate-x-1/2",
  left: "right-full top-1/2 mr-1.5 -translate-y-1/2",
  right: "left-full top-1/2 ml-1.5 -translate-y-1/2",
};

/** Dependency-free hover/focus tooltip. */
export function Tooltip({ label, side = "top", children }: TooltipProps) {
  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={cx(
          "pointer-events-none absolute z-[110] whitespace-nowrap rounded-md bg-bg-base px-2 py-1 text-xs text-text-primary opacity-0 shadow-md transition-opacity delay-0 group-hover/tt:opacity-100 group-hover/tt:delay-300 group-focus-within/tt:opacity-100",
          SIDE[side],
        )}
      >
        {label}
      </span>
    </span>
  );
}
