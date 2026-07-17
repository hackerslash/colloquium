import { useSettingsStore, type ThemePref } from "../../stores/useSettingsStore";
import { Modal } from "../ui/Modal";
import { Switch } from "../ui/Switch";
import { cx } from "../../lib/cx";

const THEMES: { value: ThemePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

type SettingsModalProps = {
  open: boolean;
  onClose: () => void;
};

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const pushToTalk = useSettingsStore((s) => s.pushToTalk);
  const setPushToTalk = useSettingsStore((s) => s.setPushToTalk);
  const closeToTray = useSettingsStore((s) => s.closeToTray);
  const setCloseToTray = useSettingsStore((s) => s.setCloseToTray);

  return (
    <Modal open={open} onClose={onClose} title="Settings" size="md">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Appearance
        </p>
        <div className="mt-2 flex rounded-md bg-bg-base p-0.5" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.value}
              role="radio"
              aria-checked={theme === t.value}
              onClick={() => setTheme(t.value)}
              className={cx(
                "flex-1 rounded px-3 py-1.5 text-sm transition-colors",
                theme === t.value
                  ? "bg-bg-tertiary text-text-primary shadow-sm"
                  : "text-text-secondary hover:text-text-primary",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Calls &amp; window
        </p>
        <div className="mt-2 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-text-primary">Push-to-talk</p>
              <p className="text-xs text-text-secondary">
                Hold {navigator.platform.includes("Mac") ? "⌘⇧Space" : "Ctrl+Shift+Space"} to
                unmute while in a call
              </p>
            </div>
            <Switch checked={pushToTalk} onChange={setPushToTalk} aria-label="Push-to-talk" />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-text-primary">Close to tray</p>
              <p className="text-xs text-text-secondary">
                Keep Haven running when the window is closed
              </p>
            </div>
            <Switch checked={closeToTray} onChange={setCloseToTray} aria-label="Close to tray" />
          </div>
        </div>
      </div>
    </Modal>
  );
}
