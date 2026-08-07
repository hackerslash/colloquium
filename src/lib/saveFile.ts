import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { toast } from "../stores/useToastStore";

/** True inside the Tauri WebView, false under a bare `vite dev` browser. */
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Browser fallback so `pnpm dev` still works outside the app shell. */
function anchorDownload(name: string, bytes: Uint8Array, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
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
    path = await save({ defaultPath: name });
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
