import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
  type LucideIcon,
} from "lucide-react";
import { useToastStore, type Toast, type ToastVariant } from "../../stores/useToastStore";
import { cx } from "../../lib/cx";

const ICON: Record<ToastVariant, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
  warning: AlertTriangle,
};

const ICON_COLOR: Record<ToastVariant, string> = {
  info: "text-accent",
  success: "text-success",
  error: "text-danger",
  warning: "text-warning",
};

const DEFAULT_DURATION = 4_000;

function ToastCard({ toast }: { toast: Toast }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const Icon = ICON[toast.variant];

  useEffect(() => {
    if (toast.duration === null) return;
    const timer = setTimeout(() => dismiss(toast.id), toast.duration ?? DEFAULT_DURATION);
    return () => clearTimeout(timer);
  }, [toast.id, toast.duration, dismiss]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, height: 0, marginTop: 0 }}
      transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
      className="flex gap-2.5 rounded-lg border border-border bg-bg-elevated p-3 shadow-md"
    >
      <Icon size={18} className={cx("mt-0.5 shrink-0", ICON_COLOR[toast.variant])} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-primary">{toast.title}</p>
        {toast.description && (
          <p className="mt-0.5 break-words text-xs text-text-secondary">{toast.description}</p>
        )}
        {toast.actions && toast.actions.length > 0 && (
          <div className="mt-2 flex gap-2">
            {toast.actions.map((action) => (
              <button
                key={action.label}
                onClick={() => {
                  action.onClick();
                  dismiss(toast.id);
                }}
                className={cx(
                  "rounded-md px-2.5 py-1 text-xs font-medium",
                  action.variant === "danger"
                    ? "bg-danger text-white hover:bg-danger-hover"
                    : "bg-accent text-white hover:bg-accent-hover",
                )}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        onClick={() => dismiss(toast.id)}
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 text-text-muted hover:text-text-primary"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </motion.div>
  );
}

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  return createPortal(
    <div className="pointer-events-none fixed right-4 top-4 z-[120] flex w-80 flex-col gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto">
            <ToastCard toast={t} />
          </div>
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  );
}
