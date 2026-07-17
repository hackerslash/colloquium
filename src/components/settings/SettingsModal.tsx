import { useEffect, useState } from "react";
import { useSettingsStore, type ThemePref, ACCENT_PRESETS } from "../../stores/useSettingsStore";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { Modal } from "../ui/Modal";
import { Switch } from "../ui/Switch";
import { Button } from "../ui/Button";
import { cx } from "../../lib/cx";
import { toast } from "../../stores/useToastStore";

const THEMES: { value: ThemePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

type SettingsModalProps = {
  open: boolean;
  onClose: () => void;
};

function ProfileSection() {
  const displayName = useIdentityStore((s) => s.self?.displayName ?? "");
  const updateDisplayName = useIdentityStore((s) => s.updateDisplayName);
  const [value, setValue] = useState(displayName);
  const [saving, setSaving] = useState(false);

  useEffect(() => setValue(displayName), [displayName]);

  const trimmed = value.trim();
  const dirty = trimmed.length > 0 && trimmed !== displayName;

  async function handleSave() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await updateDisplayName(trimmed);
      toast.success("Name updated");
    } catch (err) {
      console.error("Failed to update display name:", err);
      toast.error("Couldn't update your name", "Please try again.");
      setValue(displayName);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        Profile
      </p>
      <div className="mt-2 flex items-center gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSave()}
          maxLength={32}
          aria-label="Display name"
          className="flex-1 rounded-md border border-border bg-bg-base px-3 py-1.5 text-sm text-text-primary outline-none transition-colors focus:border-accent"
        />
        <Button size="sm" variant="secondary" loading={saving} disabled={!dirty} onClick={handleSave}>
          Save
        </Button>
      </div>
    </div>
  );
}

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

  return (
    <Modal open={open} onClose={onClose} title="Settings" size="md">
      <ProfileSection />

      <div className="mt-6">
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
                Uses AI (RNNoise) to remove background noise like fans, keyboards, and room
                sounds from your microphone
              </p>
            </div>
            <Switch
              checked={noiseSuppression}
              onChange={setNoiseSuppression}
              aria-label="Noise suppression"
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}
