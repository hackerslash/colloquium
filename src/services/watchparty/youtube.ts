/**
 * Recognising a YouTube link. A watch page is not a media source — neither the
 * webview nor the ffmpeg sidecar can open one — so this is what decides that a
 * link has to go through yt-dlp before anything can play it.
 */

const VIDEO_ID = /^[\w-]{11}$/;

/** The video id in any link shape people actually paste, or null if this is not
 * a YouTube link at all. */
export function youtubeId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  const ok = (id: string | null | undefined) => (id && VIDEO_ID.test(id) ? id : null);
  if (host === "youtu.be") return ok(u.pathname.split("/")[1]);
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
  if (u.pathname === "/watch") return ok(u.searchParams.get("v"));
  const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
  return ok(m?.[1]);
}
