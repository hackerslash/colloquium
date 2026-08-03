import { Modal } from "./Modal";
import { isMacOS } from "../../services/call/systemAudio";

type ShortcutsModalProps = {
  open: boolean;
  onClose: () => void;
};

/** `mod` renders as the platform's own modifier so the sheet matches the keys
 * actually under the user's fingers. */
function keysFor(spec: string[]): string[] {
  const mod = isMacOS() ? "⌘" : "Ctrl";
  const shift = isMacOS() ? "⇧" : "Shift";
  return spec.map((k) => (k === "mod" ? mod : k === "shift" ? shift : k));
}

const GROUPS: { title: string; items: { keys: string[]; label: string }[] }[] = [
  {
    title: "Navigation",
    items: [
      { keys: ["mod", "K"], label: "Jump to a person, room, or message" },
      { keys: ["mod", ","], label: "Open settings" },
      { keys: ["mod", "/"], label: "Show this list" },
      { keys: ["Esc"], label: "Close what's open" },
    ],
  },
  {
    title: "Writing",
    items: [
      { keys: ["Enter"], label: "Send" },
      { keys: ["shift", "Enter"], label: "New line" },
      { keys: ["↑"], label: "Edit your last message (empty composer)" },
      { keys: ["Esc"], label: "Cancel a reply or edit" },
      { keys: ["@"], label: "Mention someone" },
    ],
  },
  {
    title: "Calls",
    items: [
      { keys: ["M"], label: "Mute / unmute (while in a call)" },
      { keys: ["mod", "shift", "Space"], label: "Push-to-talk (hold, when enabled)" },
    ],
  },
  {
    title: "View",
    items: [
      { keys: ["mod", "+"], label: "Zoom in" },
      { keys: ["mod", "−"], label: "Zoom out" },
      { keys: ["mod", "0"], label: "Reset zoom" },
    ],
  },
];

export function ShortcutsModal({ open, onClose }: ShortcutsModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" size="lg">
      <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              {group.title}
            </h3>
            <ul className="flex flex-col gap-1.5">
              {group.items.map((item) => (
                <li key={item.label} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 text-sm text-text-secondary">{item.label}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {keysFor(item.keys).map((key) => (
                      <kbd
                        key={key}
                        className="rounded border border-border bg-bg-base px-1.5 py-0.5 font-sans text-[11px] font-medium text-text-primary"
                      >
                        {key}
                      </kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}
