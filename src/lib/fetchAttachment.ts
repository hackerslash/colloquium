import type { Message } from "../types/domain";
import * as chatService from "../services/room/chatService";
import { toast } from "../stores/useToastStore";

/** Give up on a transfer that stops making progress. Matches the receiver-side
 * partial-assembly TTL, so we don't keep a toast alive past the point where the
 * chunks it's waiting on have already been swept. */
const STALL_MS = 30_000;

type ProgressDetail = { fileId: string; received: number; expected: number };

/** Asks the sender for an attachment and drives a progress toast until it
 * lands, stalls, or the sender turns out to be offline. Both the file row and
 * the voice player call this, so the two stay in sync.
 *
 * Resolves true once the file is stored locally, false otherwise. Callers that
 * show their own "Fetching…" state can just await it. */
export function fetchAttachment(message: Message): Promise<boolean> {
  const fileId = message.attachmentId;
  if (!fileId) return Promise.resolve(false);

  if (!chatService.requestAttachment(message)) {
    toast.info("Sender is offline", "The file will be available when they're back online.");
    return Promise.resolve(false);
  }

  const name = message.attachmentName ?? "file";
  const toastId = toast.busy("Downloading", name);

  return new Promise<boolean>((resolve) => {
    let stallTimer: ReturnType<typeof setTimeout>;

    const finish = (ok: boolean) => {
      clearTimeout(stallTimer);
      window.removeEventListener("colloquium_file_progress", onProgress);
      window.removeEventListener("colloquium_file_downloaded", onDone);
      if (ok) toast.settle(toastId, "success", "Downloaded", name);
      else toast.settle(toastId, "error", "Download failed", `${name} — the transfer stalled.`);
      resolve(ok);
    };

    // Any chunk for this file counts as liveness, so a slow-but-moving transfer
    // isn't killed by the stall timer.
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => finish(false), STALL_MS);
    };

    const onProgress = (e: Event) => {
      const d = (e as CustomEvent<ProgressDetail>).detail;
      if (d.fileId !== fileId) return;
      armStall();
      toast.setProgress(toastId, Math.round((d.received / d.expected) * 100));
    };

    const onDone = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== fileId) return;
      finish(true);
    };

    window.addEventListener("colloquium_file_progress", onProgress);
    window.addEventListener("colloquium_file_downloaded", onDone);
    armStall();
  });
}
