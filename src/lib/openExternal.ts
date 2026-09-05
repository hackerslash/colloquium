/** Open an external http(s) URL in the system browser. Works in Tauri and plain web. */
export async function openExternal(raw: string): Promise<void> {
  const url = raw.trim();
  if (!/^https?:\/\//i.test(url)) return;
  // Tauri opener plugin — if present, opens in system browser instead of webview
  try {
    // Dynamic import so `pnpm dev` (web) doesn't require the plugin at bundle time
    const mod = await import("@tauri-apps/plugin-opener").catch(() => null) as
      | { openUrl?: (u: string) => Promise<void> }
      | null;
    if (mod?.openUrl) {
      await mod.openUrl(url);
      return;
    }
  } catch {
    // fall through to window.open
  }
  // Web fallback / Tauri fallback without plugin
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
    // last resort: navigate? we deliberately don't — external only
  }
}
