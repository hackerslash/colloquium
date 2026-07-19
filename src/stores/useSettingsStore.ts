import { create } from "zustand";
import * as settingsRepo from "../services/db/settingsRepo";
import * as callService from "../services/call/callService";
import * as roomCallService from "../services/call/roomCallService";
import { setCloseToTray as syncCloseToTray } from "../services/window";
import { toast } from "./useToastStore";

export type ThemePref = "system" | "light" | "dark";

export type AccentPreset = {
  key: string;
  label: string;
  base: string;
  hover: string;
  active: string;
  lightBase: string;
  lightHover: string;
  lightActive: string;
};

export const ACCENT_PRESETS: AccentPreset[] = [
  { key: "ember", label: "Ember", base: "#f2ad3f", hover: "#ffbc52", active: "#dd9a33", lightBase: "#bd7a1e", lightHover: "#a96c15", lightActive: "#965f0e" },
  { key: "indigo", label: "Indigo", base: "#8b8cf5", hover: "#a0a1f8", active: "#7576ea", lightBase: "#5b5fe0", lightHover: "#4a4ec9", lightActive: "#3f43b3" },
  { key: "blue", label: "Blue", base: "#5aa0f8", hover: "#7bb4fa", active: "#3b82f6", lightBase: "#2563eb", lightHover: "#1d4ed8", lightActive: "#1e40af" },
  { key: "emerald", label: "Emerald", base: "#34d399", hover: "#5ee0af", active: "#10b981", lightBase: "#059669", lightHover: "#047857", lightActive: "#065f46" },
  { key: "violet", label: "Violet", base: "#a78bfa", hover: "#bda4fc", active: "#8b5cf6", lightBase: "#7c3aed", lightHover: "#6d28d9", lightActive: "#5b21b6" },
  { key: "rose", label: "Rose", base: "#fb7185", hover: "#fd93a3", active: "#f43f5e", lightBase: "#e11d48", lightHover: "#be123c", lightActive: "#9f1239" },
];

type SettingsState = {
  theme: ThemePref;
  accent: string;
  pushToTalk: boolean;
  closeToTray: boolean;
  /** Show an OS notification for new messages while Colloquium is unfocused. */
  desktopNotifications: boolean;
  /** Play a chime for new messages arriving in a room you're not viewing. */
  notificationSounds: boolean;
  /** Include the sender's message text in OS notifications. Off = a generic
   * "New message" body, for shared/visible screens. */
  notificationPreviews: boolean;
  /** Mic noise reduction: the built-in DSP plus ML (RNNoise) suppression,
   * gated together by this one toggle. */
  noiseSuppression: boolean;
  /** Echo cancellation + auto gain. Needed on speakers, but on macOS the
   * voice-processing unit it engages also processes the OUTPUT path — and
   * re-pairs on every mic change, audibly altering how remote voices sound.
   * Headphone users can turn it off for untouched, device-stable playback. */
  echoCancellation: boolean;
  /** Selected audio input device (microphone). null = browser default. */
  audioInputDeviceId: string | null;
  /** Selected video input device (camera). null = browser default. */
  videoInputDeviceId: string | null;
  /** Selected audio output device (speaker/headphones). null = browser default. */
  audioOutputDeviceId: string | null;
  loaded: boolean;

  loadSettings: () => Promise<void>;
  setTheme: (theme: ThemePref) => Promise<void>;
  setAccent: (key: string) => Promise<void>;
  setPushToTalk: (on: boolean) => Promise<void>;
  setCloseToTray: (on: boolean) => Promise<void>;
  setDesktopNotifications: (on: boolean) => Promise<void>;
  setNotificationSounds: (on: boolean) => Promise<void>;
  setNotificationPreviews: (on: boolean) => Promise<void>;
  setNoiseSuppression: (on: boolean) => Promise<void>;
  setEchoCancellation: (on: boolean) => Promise<void>;
  setAudioInputDeviceId: (deviceId: string | null) => Promise<void>;
  setVideoInputDeviceId: (deviceId: string | null) => Promise<void>;
  setAudioOutputDeviceId: (deviceId: string | null) => Promise<void>;
};

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Applies the effective theme to <html> and caches it so the pre-paint inline
 * script in index.html can avoid a flash on the next launch. */
export function applyTheme(theme: ThemePref) {
  const effective = theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
  document.documentElement.setAttribute("data-theme", effective);
  localStorage.setItem("colloquium-theme", effective);
}

/** Sets the three accent CSS custom properties on :root.
 *  When the default "ember" is selected the inline styles are removed so the
 *  stylesheet-defined values apply instead.
 *
 *  Also caches the selected preset's resolved values (both light + dark
 *  variants) to localStorage under "colloquium-accent-vars". ACCENT_PRESETS is the
 *  single source of truth; the pre-paint script in index.html just replays this
 *  cache to avoid an accent flash on launch, so the hex values live in exactly
 *  one place. */
export function applyAccent(key: string) {
  const preset = ACCENT_PRESETS.find((p) => p.key === key);
  const style = document.documentElement.style;

  if (!preset || preset.key === "ember") {
    style.removeProperty("--color-accent");
    style.removeProperty("--color-accent-hover");
    style.removeProperty("--color-accent-active");
    localStorage.removeItem("colloquium-accent-vars");
    return;
  }

  const effectiveTheme = document.documentElement.getAttribute("data-theme");
  const isLight = effectiveTheme === "light";

  style.setProperty("--color-accent", isLight ? preset.lightBase : preset.base);
  style.setProperty("--color-accent-hover", isLight ? preset.lightHover : preset.hover);
  style.setProperty("--color-accent-active", isLight ? preset.lightActive : preset.active);

  localStorage.setItem(
    "colloquium-accent-vars",
    JSON.stringify({
      d: [preset.base, preset.hover, preset.active],
      l: [preset.lightBase, preset.lightHover, preset.lightActive],
    }),
  );
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  theme: "system",
  accent: "ember",
  pushToTalk: false,
  closeToTray: true,
  desktopNotifications: true,
  notificationSounds: true,
  notificationPreviews: true,
  noiseSuppression: true,
  echoCancellation: true,
  audioInputDeviceId: null,
  videoInputDeviceId: null,
  audioOutputDeviceId: null,
  loaded: false,

  loadSettings: async () => {
    const all = await settingsRepo.getAll();
    const theme = (all.theme as ThemePref) ?? "system";
    const accent = (all.accent as string) ?? "ember";
    const pushToTalk = (all.pushToTalk as boolean) ?? false;
    const closeToTray = (all.closeToTray as boolean) ?? true;
    const desktopNotifications = (all.desktopNotifications as boolean) ?? true;
    const notificationSounds = (all.notificationSounds as boolean) ?? true;
    const notificationPreviews = (all.notificationPreviews as boolean) ?? true;
    const noiseSuppression = (all.noiseSuppression as boolean) ?? true;
    const echoCancellation = (all.echoCancellation as boolean) ?? true;
    const audioInputDeviceId = (all.audioInputDeviceId as string | null) ?? null;
    const videoInputDeviceId = (all.videoInputDeviceId as string | null) ?? null;
    const audioOutputDeviceId = (all.audioOutputDeviceId as string | null) ?? null;
    applyTheme(theme);
    applyAccent(accent);
    set({
      theme,
      accent,
      pushToTalk,
      closeToTray,
      desktopNotifications,
      notificationSounds,
      notificationPreviews,
      noiseSuppression,
      echoCancellation,
      audioInputDeviceId,
      videoInputDeviceId,
      audioOutputDeviceId,
      loaded: true,
    });
    void syncCloseToTray(closeToTray);
  },

  setTheme: async (theme) => {
    const previous = get().theme;
    applyTheme(theme);
    // Re-apply accent so the correct light/dark variant is used
    applyAccent(get().accent);
    set({ theme });
    try {
      await settingsRepo.set("theme", theme);
    } catch (err) {
      console.error("Failed to save theme setting:", err);
      applyTheme(previous);
      applyAccent(get().accent);
      set({ theme: previous });
      toast.error("Setting not saved", "Please try again.");
    }
  },

  setAccent: async (key) => {
    const previous = get().accent;
    applyAccent(key); // also refreshes the cached "colloquium-accent-vars"
    set({ accent: key });
    try {
      await settingsRepo.set("accent", key);
    } catch (err) {
      console.error("Failed to save accent setting:", err);
      applyAccent(previous);
      set({ accent: previous });
      toast.error("Setting not saved", "Please try again.");
    }
  },

  setPushToTalk: async (on) => {
    const previous = get().pushToTalk;
    set({ pushToTalk: on });
    try {
      await settingsRepo.set("pushToTalk", on);
    } catch (err) {
      console.error("Failed to save push-to-talk setting:", err);
      set({ pushToTalk: previous });
      toast.error("Setting not saved", "Please try again.");
    }
  },

  setCloseToTray: async (on) => {
    const previous = get().closeToTray;
    set({ closeToTray: on });
    void syncCloseToTray(on);
    try {
      await settingsRepo.set("closeToTray", on);
    } catch (err) {
      console.error("Failed to save close-to-tray setting:", err);
      set({ closeToTray: previous });
      void syncCloseToTray(previous);
      toast.error("Setting not saved", "Please try again.");
    }
  },

  setDesktopNotifications: async (on) => {
    const previous = get().desktopNotifications;
    set({ desktopNotifications: on });
    try {
      await settingsRepo.set("desktopNotifications", on);
    } catch (err) {
      console.error("Failed to save desktop notifications setting:", err);
      set({ desktopNotifications: previous });
      toast.error("Setting not saved", "Please try again.");
    }
  },

  setNotificationSounds: async (on) => {
    const previous = get().notificationSounds;
    set({ notificationSounds: on });
    try {
      await settingsRepo.set("notificationSounds", on);
    } catch (err) {
      console.error("Failed to save notification sounds setting:", err);
      set({ notificationSounds: previous });
      toast.error("Setting not saved", "Please try again.");
    }
  },

  setNotificationPreviews: async (on) => {
    const previous = get().notificationPreviews;
    set({ notificationPreviews: on });
    try {
      await settingsRepo.set("notificationPreviews", on);
    } catch (err) {
      console.error("Failed to save notification previews setting:", err);
      set({ notificationPreviews: previous });
      toast.error("Setting not saved", "Please try again.");
    }
  },

  setNoiseSuppression: async (on) => {
    const previous = get().noiseSuppression;
    set({ noiseSuppression: on });
    applyVoiceSettingsToLiveCalls();
    try {
      await settingsRepo.set("noiseSuppression", on);
    } catch (err) {
      console.error("Failed to save noise suppression setting:", err);
      set({ noiseSuppression: previous });
      applyVoiceSettingsToLiveCalls();
      toast.error("Setting not saved", "Please try again.");
    }
  },

  setEchoCancellation: async (on) => {
    const previous = get().echoCancellation;
    set({ echoCancellation: on });
    // applyConstraints can't reliably change EC on a live WKWebView track —
    // re-acquire the mic instead (no-op when not in a call).
    void callService.switchMicDevice();
    void roomCallService.switchMicDevice();
    try {
      await settingsRepo.set("echoCancellation", on);
    } catch (err) {
      console.error("Failed to save echo cancellation setting:", err);
      set({ echoCancellation: previous });
      void callService.switchMicDevice();
      void roomCallService.switchMicDevice();
      toast.error("Setting not saved", "Please try again.");
    }
  },

  setAudioInputDeviceId: async (deviceId) => {
    const previous = get().audioInputDeviceId;
    set({ audioInputDeviceId: deviceId });
    // Switch the live mic track in both call types (no-op when not in a call).
    void callService.switchMicDevice();
    void roomCallService.switchMicDevice();
    try {
      await settingsRepo.set("audioInputDeviceId", deviceId);
    } catch (err) {
      console.error("Failed to save audio input device setting:", err);
      set({ audioInputDeviceId: previous });
      toast.error("Setting not saved", "Please try again.");
    }
  },

  setVideoInputDeviceId: async (deviceId) => {
    const previous = get().videoInputDeviceId;
    set({ videoInputDeviceId: deviceId });
    // Re-open the camera with the new device if camera is currently on.
    void callService.switchCameraDevice();
    void roomCallService.switchCameraDevice();
    try {
      await settingsRepo.set("videoInputDeviceId", deviceId);
    } catch (err) {
      console.error("Failed to save video input device setting:", err);
      set({ videoInputDeviceId: previous });
      toast.error("Setting not saved", "Please try again.");
    }
  },

  setAudioOutputDeviceId: async (deviceId) => {
    const previous = get().audioOutputDeviceId;
    set({ audioOutputDeviceId: deviceId });
    // VideoTile components subscribe to audioOutputDeviceId from the store
    // and call setSinkId on their <video> elements automatically.
    try {
      await settingsRepo.set("audioOutputDeviceId", deviceId);
    } catch (err) {
      console.error("Failed to save audio output device setting:", err);
      set({ audioOutputDeviceId: previous });
      toast.error("Setting not saved", "Please try again.");
    }
  },
}));

/** Voice-processing toggles take effect mid-call: re-apply constraints to
 * whichever call type (1:1 or room) currently holds a live mic. */
function applyVoiceSettingsToLiveCalls() {
  void callService.applyMicSettings();
  void roomCallService.applyMicSettings();
}
