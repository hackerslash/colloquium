import { useEffect, useRef, useState } from "react";
import { useSettingsStore, type ThemePref, ACCENT_PRESETS } from "../../stores/useSettingsStore";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { useAvatarStore } from "../../stores/useAvatarStore";
import { Modal } from "../ui/Modal";
import { Switch } from "../ui/Switch";
import { Button } from "../ui/Button";
import { Avatar } from "../ui/Avatar";
import { cx } from "../../lib/cx";
import { toast } from "../../stores/useToastStore";
import * as avatarService from "../../services/avatar/avatarService";

const THEMES: { value: ThemePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

type SettingsModalProps = {
  open: boolean;
  onClose: () => void;
};

/** Whether the browser supports routing audio output to a specific device. */
const SINK_ID_SUPPORTED = "setSinkId" in HTMLMediaElement.prototype;

type DeviceInfo = { deviceId: string; label: string };

/** Briefly opens the mic + camera, then releases them immediately. This is the
 * only way to unlock labeled device enumeration: until getUserMedia has run
 * once in the document, enumerateDevices() returns an EMPTY list (WKWebView) or
 * entries with blank labels — so every picker comes up empty. Falls back to
 * audio-only if the camera is unavailable/denied, so the mic/speaker lists
 * still populate. */
async function primeDevicePermission(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    stream.getTracks().forEach((t) => t.stop());
    return;
  } catch {
    // Camera may be unavailable/denied — still try to unlock the mic list.
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    // Permission denied outright — nothing more we can do; lists stay limited.
  }
}

function useMediaDevices() {
  const [audioInputs, setAudioInputs] = useState<DeviceInfo[]>([]);
  const [videoInputs, setVideoInputs] = useState<DeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<DeviceInfo[]>([]);

  useEffect(() => {
    let active = true;
    let primed = false;

    async function refresh() {
      try {
        let devices = await navigator.mediaDevices.enumerateDevices();
        // No usable inputs, or all labels blank → permission hasn't been granted
        // in this document yet. Prime it once, then re-read.
        const noInputs = !devices.some(
          (d) => d.kind === "audioinput" || d.kind === "videoinput",
        );
        const unlabeled = devices.length > 0 && devices.every((d) => d.label === "");
        if (!primed && (noInputs || unlabeled)) {
          primed = true;
          await primeDevicePermission();
          if (!active) return;
          devices = await navigator.mediaDevices.enumerateDevices();
        }
        if (!active) return;
        // Only keep entries with a real deviceId; label falls back to a generic
        // name if the platform still withholds it.
        const toInfo = (d: MediaDeviceInfo, i: number): DeviceInfo => ({
          deviceId: d.deviceId,
          label: d.label || `Device ${i + 1}`,
        });
        setAudioInputs(
          devices.filter((d) => d.kind === "audioinput" && d.deviceId).map(toInfo),
        );
        setVideoInputs(
          devices.filter((d) => d.kind === "videoinput" && d.deviceId).map(toInfo),
        );
        setAudioOutputs(
          devices.filter((d) => d.kind === "audiooutput" && d.deviceId).map(toInfo),
        );
      } catch (err) {
        console.warn("enumerateDevices failed:", err);
      }
    }

    void refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => {
      active = false;
      navigator.mediaDevices.removeEventListener("devicechange", refresh);
    };
  }, []);

  return { audioInputs, videoInputs, audioOutputs };
}

function DevicesSection() {
  const audioInputDeviceId = useSettingsStore((s) => s.audioInputDeviceId);
  const videoInputDeviceId = useSettingsStore((s) => s.videoInputDeviceId);
  const audioOutputDeviceId = useSettingsStore((s) => s.audioOutputDeviceId);
  const setAudioInputDeviceId = useSettingsStore((s) => s.setAudioInputDeviceId);
  const setVideoInputDeviceId = useSettingsStore((s) => s.setVideoInputDeviceId);
  const setAudioOutputDeviceId = useSettingsStore((s) => s.setAudioOutputDeviceId);
  const { audioInputs, videoInputs, audioOutputs } = useMediaDevices();

  const selectClass =
    "border border-border bg-bg-base px-3 py-1.5 text-sm text-text-primary rounded-md w-full outline-none focus:border-accent transition-colors";

  return (
    <div className="mt-6">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Devices</p>
      <div className="mt-2 space-y-3">
        <div>
          <label className="mb-1 block text-sm text-text-primary">Microphone</label>
          <select
            className={selectClass}
            value={audioInputDeviceId ?? ""}
            onChange={(e) => void setAudioInputDeviceId(e.target.value || null)}
          >
            <option value="">Default</option>
            {audioInputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm text-text-primary">Camera</label>
          <select
            className={selectClass}
            value={videoInputDeviceId ?? ""}
            onChange={(e) => void setVideoInputDeviceId(e.target.value || null)}
          >
            <option value="">Default</option>
            {videoInputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        </div>

        {SINK_ID_SUPPORTED && (
          <div>
            <label className="mb-1 block text-sm text-text-primary">Speaker</label>
            <select
              className={selectClass}
              value={audioOutputDeviceId ?? ""}
              onChange={(e) => void setAudioOutputDeviceId(e.target.value || null)}
            >
              <option value="">Default</option>
              {audioOutputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-text-muted">
              Speaker selection may not be available on all platforms.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function AvatarSection() {
  const self = useIdentityStore((s) => s.self);
  const displayName = useIdentityStore((s) => s.self?.displayName ?? "");
  const hasAvatar = useAvatarStore((s) => (self ? !!s.urlById[self.identityId] : false));
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  if (!self) return null;

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !self) return;
    setBusy(true);
    try {
      await avatarService.setSelfAvatar(self, file);
      toast.success("Avatar updated");
    } catch (err) {
      console.error("Failed to set avatar:", err);
      toast.error("Couldn't update your avatar", "Please pick a smaller image.");
    } finally {
      setBusy(false);
    }
  }

  async function onRemove() {
    if (!self) return;
    setBusy(true);
    try {
      await avatarService.clearSelfAvatar(self);
    } catch (err) {
      console.error("Failed to remove avatar:", err);
      toast.error("Couldn't remove your avatar", "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
        aria-label="Change avatar"
      >
        <Avatar id={self.identityId} name={displayName} size="xl" />
      </button>
      <div className="flex flex-col gap-1">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
          Change
        </Button>
        {hasAvatar && (
          <button
            type="button"
            onClick={onRemove}
            disabled={busy}
            className="text-xs text-text-muted transition-colors hover:text-text-secondary disabled:opacity-60"
          >
            Remove
          </button>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onPick}
      />
    </div>
  );
}

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
      <div className="mt-3">
        <AvatarSection />
      </div>
      <div className="mt-3 flex items-center gap-2">
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

      <DevicesSection />
    </Modal>
  );
}
