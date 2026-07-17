import { create } from "zustand";
import * as settingsRepo from "../services/db/settingsRepo";

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
  { key: "indigo", label: "Indigo", base: "#6366f1", hover: "#4f46e5", active: "#4338ca", lightBase: "#5b5fe0", lightHover: "#4a4ec9", lightActive: "#3f43b3" },
  { key: "blue", label: "Blue", base: "#3b82f6", hover: "#2563eb", active: "#1d4ed8", lightBase: "#2563eb", lightHover: "#1d4ed8", lightActive: "#1e40af" },
  { key: "emerald", label: "Emerald", base: "#10b981", hover: "#059669", active: "#047857", lightBase: "#059669", lightHover: "#047857", lightActive: "#065f46" },
  { key: "violet", label: "Violet", base: "#8b5cf6", hover: "#7c3aed", active: "#6d28d9", lightBase: "#7c3aed", lightHover: "#6d28d9", lightActive: "#5b21b6" },
  { key: "rose", label: "Rose", base: "#f43f5e", hover: "#e11d48", active: "#be123c", lightBase: "#e11d48", lightHover: "#be123c", lightActive: "#9f1239" },
  { key: "amber", label: "Amber", base: "#f59e0b", hover: "#d97706", active: "#b45309", lightBase: "#d97706", lightHover: "#b45309", lightActive: "#92400e" },
];

type SettingsState = {
  theme: ThemePref;
  accent: string;
  pushToTalk: boolean;
  closeToTray: boolean;
  loaded: boolean;

  loadSettings: () => Promise<void>;
  setTheme: (theme: ThemePref) => Promise<void>;
  setAccent: (key: string) => Promise<void>;
  setPushToTalk: (on: boolean) => Promise<void>;
  setCloseToTray: (on: boolean) => Promise<void>;
};

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Applies the effective theme to <html> and caches it so the pre-paint inline
 * script in index.html can avoid a flash on the next launch. */
export function applyTheme(theme: ThemePref) {
  const effective = theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
  document.documentElement.setAttribute("data-theme", effective);
  localStorage.setItem("haven-theme", effective);
}

/** Sets the three accent CSS custom properties on :root.
 *  When the default "indigo" is selected the inline styles are removed so the
 *  stylesheet-defined values apply instead.
 *
 *  Also caches the selected preset's resolved values (both light + dark
 *  variants) to localStorage under "haven-accent-vars". ACCENT_PRESETS is the
 *  single source of truth; the pre-paint script in index.html just replays this
 *  cache to avoid an accent flash on launch, so the hex values live in exactly
 *  one place. */
export function applyAccent(key: string) {
  const preset = ACCENT_PRESETS.find((p) => p.key === key);
  const style = document.documentElement.style;

  if (!preset || preset.key === "indigo") {
    style.removeProperty("--color-accent");
    style.removeProperty("--color-accent-hover");
    style.removeProperty("--color-accent-active");
    localStorage.removeItem("haven-accent-vars");
    return;
  }

  const effectiveTheme = document.documentElement.getAttribute("data-theme");
  const isLight = effectiveTheme === "light";

  style.setProperty("--color-accent", isLight ? preset.lightBase : preset.base);
  style.setProperty("--color-accent-hover", isLight ? preset.lightHover : preset.hover);
  style.setProperty("--color-accent-active", isLight ? preset.lightActive : preset.active);

  localStorage.setItem(
    "haven-accent-vars",
    JSON.stringify({
      d: [preset.base, preset.hover, preset.active],
      l: [preset.lightBase, preset.lightHover, preset.lightActive],
    }),
  );
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  theme: "system",
  accent: "indigo",
  pushToTalk: false,
  closeToTray: true,
  loaded: false,

  loadSettings: async () => {
    const all = await settingsRepo.getAll();
    const theme = (all.theme as ThemePref) ?? "system";
    const accent = (all.accent as string) ?? "indigo";
    const pushToTalk = (all.pushToTalk as boolean) ?? false;
    const closeToTray = (all.closeToTray as boolean) ?? true;
    applyTheme(theme);
    applyAccent(accent);
    set({ theme, accent, pushToTalk, closeToTray, loaded: true });
  },

  setTheme: async (theme) => {
    applyTheme(theme);
    // Re-apply accent so the correct light/dark variant is used
    applyAccent(get().accent);
    set({ theme });
    await settingsRepo.set("theme", theme);
  },

  setAccent: async (key) => {
    applyAccent(key); // also refreshes the cached "haven-accent-vars"
    set({ accent: key });
    await settingsRepo.set("accent", key);
  },

  setPushToTalk: async (on) => {
    set({ pushToTalk: on });
    await settingsRepo.set("pushToTalk", on);
  },

  setCloseToTray: async (on) => {
    set({ closeToTray: on });
    await settingsRepo.set("closeToTray", on);
  },
}));
