/** Briefly opens the mic + camera, then releases them immediately.
 *
 * Two jobs. First, it's the only way to unlock labeled device enumeration:
 * until getUserMedia has run once in the document, enumerateDevices() returns
 * an EMPTY list (WKWebView) or entries with blank labels — so every picker
 * comes up empty. Second, it's what surfaces the OS permission dialog, which
 * we want on first launch rather than in the middle of someone's first call.
 *
 * Falls back to audio-only if the camera is unavailable/denied, so the
 * mic/speaker lists still populate. */
export async function primeDevicePermission(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    stream.getTracks().forEach((t) => t.stop());
    return;
  } catch {
    // Camera may be unavailable/denied — still try to unlock the mic list.
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    // Permission denied outright — nothing more we can do; lists stay limited.
  }
}
