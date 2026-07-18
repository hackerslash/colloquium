import { getCurrentWindow } from "@tauri-apps/api/window";
import { Image } from "@tauri-apps/api/image";

const isWindows = navigator.userAgent.toLowerCase().includes("windows");

let lastRendered = -1;

/** Rasterizes a small red count bubble to RGBA pixels for use as a Windows
 * taskbar overlay icon (Windows has no native badge API — see setAppBadge). */
function renderBadgeRgba(count: number): { rgba: Uint8Array; size: number } {
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  ctx.fillStyle = "#e5484d";
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.font = "700 17px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(count > 9 ? "9+" : String(count), size / 2, size / 2 + 1);

  const { data } = ctx.getImageData(0, 0, size, size);
  return { rgba: new Uint8Array(data.buffer), size };
}

/** Sets the OS taskbar/dock unread badge. macOS and Linux use the native
 * per-app badge count; Windows has no equivalent API, so a small rendered
 * count bubble is applied as a taskbar overlay icon instead. Best-effort —
 * a platform or permission failure here should never break the app. */
export async function setAppBadge(count: number): Promise<void> {
  if (count === lastRendered) return;
  lastRendered = count;
  try {
    const win = getCurrentWindow();
    if (isWindows) {
      if (count > 0) {
        const { rgba, size } = renderBadgeRgba(count);
        const image = await Image.new(rgba, size, size);
        await win.setOverlayIcon(image);
      } else {
        await win.setOverlayIcon(undefined);
      }
    } else {
      await win.setBadgeCount(count > 0 ? count : undefined);
    }
  } catch {
    // Best-effort; badge failures shouldn't break the app.
  }
}
