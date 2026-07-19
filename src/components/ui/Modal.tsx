import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { IconButton } from "./IconButton";
import { cx } from "../../lib/cx";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  size?: "sm" | "md" | "lg" | "xl";
  children: ReactNode;
  footer?: ReactNode;
};

const SIZE: Record<NonNullable<ModalProps["size"]>, string> = {
  sm: "w-80",
  md: "w-96",
  lg: "w-[32rem]",
  xl: "w-[46rem]",
};

function ModalPanel({ onClose, title, size = "md", children, footer }: Omit<ModalProps, "open">) {
  const trapRef = useFocusTrap<HTMLDivElement>(onClose);
  return (
    <motion.div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      initial={{ opacity: 0, scale: 0.9, y: 15 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: 10 }}
      transition={{ type: "spring", damping: 25, stiffness: 350 }}
      onClick={(e) => e.stopPropagation()}
      className={cx(
        "max-h-[85vh] overflow-y-auto rounded-[24px] border border-white/10 bg-bg-elevated/90 p-6 shadow-2xl backdrop-blur-3xl",
        SIZE[size],
      )}
    >
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-text-primary">{title}</h2>
        <IconButton icon={X} label="Close" size="sm" onClick={onClose} tooltip={false} />
      </div>
      {children}
      {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
    </motion.div>
  );
}

/** The single modal primitive: portal, backdrop, enter/exit animation, focus
 * trap (Escape + Tab cycling via useFocusTrap). Keep it mounted and drive
 * `open` so the exit animation can play. */
export function Modal({ open, ...rest }: ModalProps) {
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-md"
          onClick={rest.onClose}
        >
          <ModalPanel {...rest} />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
