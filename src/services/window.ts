import { invoke } from "@tauri-apps/api/core";

/** Syncs the close-to-tray setting to the Rust-side window-close handler,
 * which runs ahead of any JS listener and needs to know whether to hide the
 * window or let the app quit normally. */
export function setCloseToTray(enabled: boolean): Promise<void> {
  return invoke("set_close_to_tray", { enabled });
}

/** True when this process was launched by the autostart entry at login, in
 * which case the window should stay hidden and the app just runs in the tray.
 * Only Rust can see the process arguments, hence the round trip. */
export function shouldStartHidden(): Promise<boolean> {
  return invoke("should_start_hidden");
}
