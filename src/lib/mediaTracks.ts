/** True when the stream has video that's actually flowing. A remote track
 * whose sender crashed (or lost its network) goes `muted` when RTP stops —
 * without this check the UI keeps showing the frozen last frame. */
export function hasLiveVideo(stream: MediaStream | null): boolean {
  return stream?.getVideoTracks().some((t) => t.readyState === "live" && !t.muted) ?? false;
}
