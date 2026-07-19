import type { ReactNode } from "react";
import { cx } from "../../lib/cx";

export function UnreadBadge({ count, muted = false }: { count: number; muted?: boolean }) {
  if (count <= 0) return null;
  return (
    <span
      className={cx(
        "flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-bold",
        muted ? "bg-bg-tertiary text-text-muted" : "bg-unread text-white",
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary",
        className,
      )}
    >
      {children}
    </span>
  );
}
