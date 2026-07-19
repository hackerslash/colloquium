import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../../lib/cx";

type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  size?: "sm" | "lg";
};

export function EmptyState({ icon: Icon, title, description, action, size = "sm" }: EmptyStateProps) {
  const lg = size === "lg";
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <span className="relative flex items-center justify-center">
        <span
          aria-hidden="true"
          className={cx(
            "absolute rounded-full bg-accent/15 blur-2xl",
            lg ? "size-24" : "size-16",
          )}
        />
        <span
          className={cx(
            "relative flex items-center justify-center rounded-full border border-border bg-bg-tertiary text-text-secondary",
            lg ? "size-16" : "size-12",
          )}
        >
          <Icon size={lg ? 28 : 22} strokeWidth={1.5} aria-hidden="true" />
        </span>
      </span>
      <p
        className={cx(
          "font-display text-text-primary",
          lg ? "text-xl font-medium" : "text-sm font-medium",
        )}
      >
        {title}
      </p>
      {description && <p className="max-w-xs text-xs text-text-secondary">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
