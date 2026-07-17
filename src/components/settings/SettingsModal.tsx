import { useSettingsStore, type ThemePref, ACCENT_PRESETS } from "../../stores/useSettingsStore";
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
  const accent = useSettingsStore((s) => s.accent);
  const setAccent = useSettingsStore((s) => s.setAccent);
  const pushToTalk = useSettingsStore((s) => s.pushToTalk);
  const setPushToTalk = useSettingsStore((s) => s.setPushToTalk);
  const closeToTray = useSettingsStore((s) => s.closeToTray);
  const setCloseToTray = useSettingsStore((s) => s.setCloseToTray);
  const noiseSuppression = useSettingsStore((s) => s.noiseSuppression);
  const setNoiseSuppression = useSettingsStore((s) => s.setNoiseSuppression);
  const voiceIsolation = useSettingsStore((s) => s.voiceIsolation);
  const setVoiceIsolation = useSettingsStore((s) => s.setVoiceIsolation);

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

        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-text-secondary">Accent</p>
          <div className="flex gap-2" role="radiogroup" aria-label="Accent color">
            {ACCENT_PRESETS.map((p) => (
              <button
                key={p.key}
                role="radio"
                aria-checked={accent === p.key}
                aria-label={p.label}
                onClick={() => setAccent(p.key)}
                className={cx(
                  "size-6 rounded-full transition-shadow",
                  accent === p.key
                    ? "ring-2 ring-text-primary ring-offset-2 ring-offset-bg-elevated"
                    : "hover:ring-2 hover:ring-text-muted hover:ring-offset-2 hover:ring-offset-bg-elevated",
                )}
                style={{ backgroundColor: p.base }}
              />
            ))}
          </div>
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

      <div className="mt-6">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Voice</p>
        <div className="mt-2 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-text-primary">Noise suppression</p>
              <p className="text-xs text-text-secondary">
                Reduce background noise picked up by your microphone
              </p>
            </div>
            <Switch
              checked={noiseSuppression}
              onChange={setNoiseSuppression}
              aria-label="Noise suppression"
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-text-primary">Voice isolation</p>
              <p className="text-xs text-text-secondary">
                Stronger filtering that mutes everything except your voice, like keyboard and
                room sounds (where supported)
              </p>
            </div>
            <Switch
              checked={voiceIsolation}
              onChange={setVoiceIsolation}
              aria-label="Voice isolation"
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}
