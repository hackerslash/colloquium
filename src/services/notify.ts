import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";

let permissionChecked = false;
let permissionGranted = false;

async function ensurePermission(): Promise<boolean> {
  if (permissionChecked) return permissionGranted;
  permissionChecked = true;
  permissionGranted = await isPermissionGranted();
  if (!permissionGranted) {
    permissionGranted = (await requestPermission()) === "granted";
  }
  return permissionGranted;
}

/** Fires an OS notification only when the window isn't focused, so an active
 * user isn't double-notified for something already on screen. */
export async function notifyIfUnfocused(title: string, body: string): Promise<void> {
  try {
    if (await getCurrentWindow().isFocused()) return;
    if (!(await ensurePermission())) return;
    sendNotification({ title, body });
  } catch {
    // Notifications are best-effort; never let them break message handling.
  }
}
