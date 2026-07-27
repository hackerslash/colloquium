import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Fullscreen for a desktop shell.
 *
 * The DOM API is tried first: it makes the given element the fullscreen root, so
 * overlay chrome inside it stays on top and the webview handles Escape itself.
 * Element fullscreen is not enabled in every webview build though, and a silent
 * rejection would leave a double-click doing nothing at all — so the Tauri
 * window API is the fallback. A surface that is already `fixed inset-0` looks
 * the same either way.
 */
export async function enterFullscreen(el: HTMLElement): Promise<void> {
  if (document.fullscreenEnabled) {
    try {
      await el.requestFullscreen();
      return;
    } catch {
      // Fall through to the window API.
    }
  }
  await getCurrentWindow().setFullscreen(true);
}

/** Exits by whichever route took us in. Takes no element, so it stays callable
 * from teardown, after the surface has already gone. */
export async function exitFullscreen(): Promise<void> {
  if (document.fullscreenElement) {
    try {
      await document.exitFullscreen();
      return;
    } catch {
      // Fall through to the window API.
    }
  }
  await getCurrentWindow().setFullscreen(false);
}
