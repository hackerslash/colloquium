import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "../stores/useToastStore";
import { useSettingsStore } from "../stores/useSettingsStore";

// Only the OS *prompt* is one-shot (re-asking on every call would be
// obnoxious); actual grant state is re-checked every time so a permission the
// user flips on later (via OS settings, without restarting Colloquium) is picked
// up instead of staying permanently "denied" from a stale first check.
let hasPrompted = false;
let deniedNoticeShown = false;

async function ensurePermission(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  if (!hasPrompted) {
    hasPrompted = true;
    if ((await requestPermission()) === "granted") return true;
  }
  if (!deniedNoticeShown) {
    deniedNoticeShown = true;
    toast.warning(
      "Notifications are off",
      "Colloquium won't alert you about messages or calls while unfocused. Enable notifications for Colloquium in your OS settings to turn this back on.",
    );
  }
  return false;
}

/** Fires an OS notification only when the window isn't focused, so an active
 * user isn't double-notified for something already on screen. Returns whether
 * a notification was actually posted, so callers can pair side effects (e.g.
 * an audible chime) with the moments the user is actually being alerted. */
export async function notifyIfUnfocused(title: string, body: string): Promise<boolean> {
  try {
    if (!useSettingsStore.getState().desktopNotifications) return false;
    if (await getCurrentWindow().isFocused()) return false;
    if (!(await ensurePermission())) return false;
    sendNotification({ title, body });
    return true;
  } catch {
    // Notifications are best-effort; never let them break message handling.
    return false;
  }
}
