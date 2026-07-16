import { useSettingsStore, type ThemePref } from "../../stores/useSettingsStore";
import { useFocusTrap } from "../../hooks/useFocusTrap";

const THEMES: { value: ThemePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

type SettingsModalProps = {
  onClose: () => void;
};

export function SettingsModal({ onClose }: SettingsModalProps) {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const pushToTalk = useSettingsStore((s) => s.pushToTalk);
  const setPushToTalk = useSettingsStore((s) => s.setPushToTalk);
  const closeToTray = useSettingsStore((s) => s.closeToTray);
  const setCloseToTray = useSettingsStore((s) => s.setCloseToTray);

  const trapRef = useFocusTrap<HTMLDivElement>(onClose);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        ref={trapRef}
        className="w-96 rounded-2xl bg-bg-secondary p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">Settings</h2>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="rounded px-2 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
          >
            ✕
          </button>
        </div>

        <div className="mt-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
            Appearance
          </p>
          <div className="mt-2 flex gap-2" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <button
                key={t.value}
                role="radio"
                aria-checked={theme === t.value}
                onClick={() => setTheme(t.value)}
                className={`flex-1 rounded-lg border px-3 py-1.5 text-sm ${
                  theme === t.value
                    ? "border-accent bg-accent/10 text-text-primary"
                    : "border-border text-text-secondary hover:bg-bg-tertiary"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-6 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
            Calls &amp; window
          </p>
          <label className="flex items-center justify-between text-sm text-text-primary">
            <span>
              Push-to-talk
              <span className="block text-xs text-text-secondary">
                Hold {navigator.platform.includes("Mac") ? "⌘⇧Space" : "Ctrl+Shift+Space"} to
                unmute while in a call
              </span>
            </span>
            <input
              type="checkbox"
              checked={pushToTalk}
              onChange={(e) => setPushToTalk(e.target.checked)}
            />
          </label>
          <label className="flex items-center justify-between text-sm text-text-primary">
            <span>
              Close to tray
              <span className="block text-xs text-text-secondary">
                Keep Haven running when the window is closed
              </span>
            </span>
            <input
              type="checkbox"
              checked={closeToTray}
              onChange={(e) => setCloseToTray(e.target.checked)}
            />
          </label>
        </div>
      </div>
    </div>
  );
}
