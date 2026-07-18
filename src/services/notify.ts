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
// user flips on later (via OS settings, without restarting Haven) is picked
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
      "Haven won't alert you about messages or calls while unfocused. Enable notifications for Haven in your OS settings to turn this back on.",
    );
  }
  return false;
}

/** Fires an OS notification only when the window isn't focused, so an active
 * user isn't double-notified for something already on screen. */
export async function notifyIfUnfocused(title: string, body: string): Promise<void> {
  try {
    if (!useSettingsStore.getState().desktopNotifications) return;
    if (await getCurrentWindow().isFocused()) return;
    if (!(await ensurePermission())) return;
    sendNotification({ title, body });
  } catch {
    // Notifications are best-effort; never let them break message handling.
  }
}
