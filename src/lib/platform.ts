export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    (navigator.platform ?? "");
  return platform.includes("Mac") || (navigator.userAgent ?? "").includes("Mac");
}
