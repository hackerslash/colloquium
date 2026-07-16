import { create } from "zustand";
import * as settingsRepo from "../services/db/settingsRepo";

export type ThemePref = "system" | "light" | "dark";

type SettingsState = {
  theme: ThemePref;
  pushToTalk: boolean;
  closeToTray: boolean;
  loaded: boolean;

  loadSettings: () => Promise<void>;
  setTheme: (theme: ThemePref) => Promise<void>;
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

export const useSettingsStore = create<SettingsState>((set) => ({
  theme: "system",
  pushToTalk: false,
  closeToTray: true,
  loaded: false,

  loadSettings: async () => {
    const all = await settingsRepo.getAll();
    const theme = (all.theme as ThemePref) ?? "system";
    const pushToTalk = (all.pushToTalk as boolean) ?? false;
    const closeToTray = (all.closeToTray as boolean) ?? true;
    applyTheme(theme);
    set({ theme, pushToTalk, closeToTray, loaded: true });
  },

  setTheme: async (theme) => {
    applyTheme(theme);
    set({ theme });
    await settingsRepo.set("theme", theme);
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
