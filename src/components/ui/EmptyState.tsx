import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
};

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-bg-tertiary text-text-secondary">
        <Icon size={22} aria-hidden="true" />
      </span>
      <p className="text-sm font-medium text-text-primary">{title}</p>
      {description && <p className="max-w-xs text-xs text-text-secondary">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
