import { invoke } from "@tauri-apps/api/core";

/** Syncs the close-to-tray setting to the Rust-side window-close handler,
 * which runs ahead of any JS listener and needs to know whether to hide the
 * window or let the app quit normally. */
export function setCloseToTray(enabled: boolean): Promise<void> {
  return invoke("set_close_to_tray", { enabled });
}
