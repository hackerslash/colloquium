import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { downloadDir, join } from "@tauri-apps/api/path";
import { toast } from "../stores/useToastStore";

/** True inside the Tauri WebView, false under a bare `vite dev` browser. */
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Attachment names come from a peer, so they can't be pasted into a path as
 * they are — separators would point the pre-filled save location somewhere
 * other than the folder we resolved, past a user who trusts the default. */
export function safeFileName(name: string): string {
  const flat = name
    .replace(/[/\\]+/g, "_")
    // Reserved on Windows, silently mangled or rejected elsewhere.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return flat || "download";
}

/** Where the save dialog should open. Bare filenames make it inherit the
 * process CWD, which is `src-tauri` in dev — never what the user wants. */
async function defaultSavePath(name: string): Promise<string> {
  const safe = safeFileName(name);
  try {
    return await join(await downloadDir(), safe);
  } catch {
    // No Downloads folder (unset XDG dir, sandbox); let the dialog pick.
    return safe;
  }
}

/** Browser fallback so `pnpm dev` still works outside the app shell. */
function anchorDownload(name: string, bytes: Uint8Array, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
  const a = document.createElement("a");
  a.href = url;
  a.download = safeFileName(name);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** Every "download to disk" in the app goes through here: native save dialog,
 * then a busy toast that settles into the real path or the real error. The
 * write is atomic, so the bar is indeterminate rather than a percentage.
 * Returns false if the user cancelled the dialog. */
export async function saveToDisk(
  name: string,
  bytes: Uint8Array,
  mimeType = "application/octet-stream",
): Promise<boolean> {
  if (!inTauri()) {
    anchorDownload(name, bytes, mimeType);
    toast.success("Download started", name);
    return true;
  }

  let path: string | null;
  try {
    path = await save({ defaultPath: await defaultSavePath(name) });
  } catch (err) {
    toast.error("Save failed", err instanceof Error ? err.message : String(err));
    return false;
  }
  if (!path) return false;

  const id = toast.busy("Saving…", name);
  try {
    await writeFile(path, bytes);
    toast.settle(id, "success", "Saved", path);
    return true;
  } catch (err) {
    toast.settle(id, "error", "Save failed", err instanceof Error ? err.message : String(err));
    return false;
  }
}
