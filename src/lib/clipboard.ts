/** Robust clipboard write that works during calls and in Tauri. */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  // 1) Standard async clipboard (requires transient activation + secure context)
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }

  // 2) Tauri clipboard-manager plugin (works even when webview clipboard is denied)
  try {
    const mod = await import("@tauri-apps/plugin-clipboard-manager").catch(() => null) as
      | { writeText?: (t: string) => Promise<void> }
      | null;
    if (mod?.writeText) {
      await mod.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }

  // 3) execCommand fallback — synchronous, needs a focused textarea
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    // iOS needs explicit range
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok) return true;
  } catch {
    // fall through
  }

  return false;
}
