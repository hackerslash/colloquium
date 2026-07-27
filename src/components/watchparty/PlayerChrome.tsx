
/**
 * The over-video control voice: buttons, chips and menus that sit on the film
 * rather than in a panel.
 *
 * These deliberately do not reuse IconButton/Button. Those carry theme surfaces
 * (`bg-bg-tertiary`, `bg-bg-elevated`), which over video means a pale grey box
 * floating on a dark picture in Day theme. Chrome that sits on the film is
 * light-on-dark in both themes, because the film is dark in both themes.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import type { LucideIcon } from "lucide-react";
import { Check, ChevronDown } from "lucide-react";
import { cx } from "../../lib/cx";
import { Tooltip } from "../ui/Tooltip";

type ChromeButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
  size?: "md" | "lg";
  /** Ember fill — the one primary action on the surface (play/pause). */
  primary?: boolean;
  tooltip?: boolean;
};

export function ChromeButton({
  icon: Icon,
  label,
  size = "md",
  primary = false,
  tooltip = true,
  className,
  ...rest
}: ChromeButtonProps) {
  const button = (
    <button
      type="button"
      aria-label={label}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-full transition-[background-color,color,opacity] duration-150",
        "disabled:cursor-not-allowed disabled:opacity-40",
        size === "lg" ? "h-11 w-11" : "h-9 w-9",
        primary
          ? "bg-accent text-accent-ink hover:bg-accent-hover active:bg-accent-active"
          : "text-white/85 hover:bg-white/15 hover:text-white active:bg-white/25",
        className,
      )}
      {...rest}
    >
      <Icon size={size === "lg" ? 22 : 18} aria-hidden="true" />
    </button>
  );
  return tooltip ? <Tooltip label={label}>{button}</Tooltip> : button;
}

type ChromeTextButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: LucideIcon;
  tone?: "neutral" | "danger";
};

/** Labelled action on the film. Matches Button's pill geometry so the two read
 * as the same family, but carries its own light-on-dark surface — Button's
 * `secondary` variant is `text-text-primary`, which is near-black in Day theme
 * and therefore invisible here. */
export function ChromeTextButton({
  icon: Icon,
  tone = "neutral",
  className,
  children,
  ...rest
}: ChromeTextButtonProps) {
  return (
    <button
      type="button"
      className={cx(
        "inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-full px-3 text-xs font-semibold transition-colors duration-150",
        "disabled:cursor-not-allowed disabled:opacity-40",
        tone === "danger"
          ? "bg-danger/90 text-white hover:bg-danger"
          : "bg-white/12 text-white hover:bg-white/22",
        className,
      )}
      {...rest}
    >
      {Icon && <Icon size={14} aria-hidden="true" />}
      {children}
    </button>
  );
}

/** Read-only status text on the film — never interactive, so it takes no focus
 * and reads as information rather than as a disabled control. */
export function ChromeChip({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "accent";
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs whitespace-nowrap",
        tone === "accent"
          ? "bg-accent/15 text-accent"
          : "bg-white/10 text-white/70",
      )}
    >
      {children}
    </span>
  );
}

export type MenuItem = {
  value: string;
  label: string;
  /** Secondary line — a codec, a language, why the item is unavailable. */
  hint?: string;
  disabled?: boolean;
};

type PlayerMenuProps = {
  label: string;
  items: MenuItem[];
  onSelect: (value: string) => void;
  /** Marks the checked item. Omit for a menu of actions rather than a choice. */
  value?: string;
  icon?: LucideIcon;
  /** Text trigger, for values worth reading at a glance (playback speed). */
  text?: string;
  disabled?: boolean;
  /** Which edge of the trigger the panel lines up with. */
  align?: "start" | "end";
  /** Which way the panel opens. Transport menus open upward; a menu in the top
   * bar has to open downward or it lands off-screen. */
  side?: "top" | "bottom";
  heading?: string;
  /** Extra controls below the list — subtitle delay, "add a file". */
  footer?: ReactNode;
  /** Spinner on the trigger while the selection is still being applied. */
  busy?: boolean;
};

const FOCUSABLE = '[role="menuitemradio"]:not([disabled]),[role="menuitem"]:not([disabled])';

export function PlayerMenu({
  label,
  items,
  onSelect,
  value,
  icon: Icon,
  text,
  disabled = false,
  align = "end",
  side = "top",
  heading,
  footer,
  busy = false,
}: PlayerMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Focus lands on the current choice, so arrow keys start from where the user
  // actually is rather than at the top of the list.
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const checked = list?.querySelector<HTMLElement>('[aria-checked="true"]:not([disabled])');
    (checked ?? list?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
  }, [open]);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  const move = (delta: number) => {
    const nodes = Array.from(listRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (nodes.length === 0) return;
    const at = nodes.indexOf(document.activeElement as HTMLElement);
    const next = (at + delta + nodes.length) % nodes.length;
    nodes[next]?.focus();
  };

  return (
    <div className="relative" ref={wrapRef}>
      <Tooltip label={label}>
        <button
          ref={triggerRef}
          type="button"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
            }
          }}
          className={cx(
            "inline-flex h-9 shrink-0 items-center justify-center gap-1 rounded-full transition-[background-color,color,opacity] duration-150",
            "disabled:cursor-not-allowed disabled:opacity-40",
            Icon && !text ? "w-9" : "px-2.5",
            open ? "bg-white/20 text-white" : "text-white/85 hover:bg-white/15 hover:text-white",
          )}
        >
          {busy ? (
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            Icon && <Icon size={18} aria-hidden="true" />
          )}
          {text && <span className="text-xs font-semibold tabular-nums">{text}</span>}
          {text && !Icon && <ChevronDown size={13} aria-hidden="true" className="opacity-60" />}
        </button>
      </Tooltip>

      {open && (
        <div
          id={panelId}
          ref={listRef}
          role="menu"
          aria-label={label}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              close(true);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              move(-1);
            } else if (e.key === "Tab") {
              close(false);
            }
          }}
          className={cx(
            "absolute z-10 min-w-52 max-w-72 overflow-hidden rounded-xl border border-border bg-bg-elevated py-1 shadow-modal",
            "animate-[menu-in_140ms_cubic-bezier(0.16,1,0.3,1)] motion-reduce:animate-none",
            side === "top" ? "bottom-full mb-2 origin-bottom" : "top-full mt-2 origin-top",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {heading && (
            <p className="px-3 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-text-muted uppercase">
              {heading}
            </p>
          )}
          <div className="max-h-72 overflow-y-auto">
            {items.map((item) => {
              const checked = value !== undefined && item.value === value;
              return (
                <button
                  key={item.value}
                  type="button"
                  role={value === undefined ? "menuitem" : "menuitemradio"}
                  aria-checked={value === undefined ? undefined : checked}
                  disabled={item.disabled}
                  onClick={() => {
                    onSelect(item.value);
                    close(true);
                  }}
                  className={cx(
                    "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors",
                    "disabled:cursor-not-allowed disabled:opacity-45",
                    checked ? "text-text-primary" : "text-text-secondary",
                    "hover:bg-bg-tertiary hover:text-text-primary focus-visible:bg-bg-tertiary disabled:hover:bg-transparent",
                  )}
                >
                  <Check
                    size={14}
                    aria-hidden="true"
                    className={cx("shrink-0 text-accent", !checked && "invisible")}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{item.label}</span>
                    {item.hint && (
                      <span className="block truncate text-xs text-text-muted">{item.hint}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          {footer && <div className="mt-1 border-t border-border px-3 py-2">{footer}</div>}
        </div>
      )}
    </div>
  );
}
