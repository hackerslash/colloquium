/** Structured console logging for diagnosing audio-pipeline issues (mic
 * switches changing remote playback, screen-share echo). Always on — the
 * output is only visible with devtools open, and these events are rare. */

export function logCallDebug(tag: string, data?: unknown) {
  // Stringified so the values survive a copy/paste from the inspector
  // (Safari shows objects as a collapsed "Object" otherwise).
  console.info(`[call-debug] ${tag} ${data === undefined ? "" : JSON.stringify(data)}`);
}

export function trackDebugInfo(track: MediaStreamTrack | null | undefined) {
  if (!track) return null;
  const s = track.getSettings();
  return {
    label: track.label,
    id: track.id.slice(0, 8),
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
    deviceId: s.deviceId?.slice(0, 12),
    sampleRate: s.sampleRate,
    echoCancellation: s.echoCancellation,
    autoGainControl: s.autoGainControl,
    noiseSuppression: s.noiseSuppression,
  };
}
