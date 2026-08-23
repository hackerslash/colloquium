/**
 * YouTube sources. The ffmpeg sidecar cannot demux a YouTube watch page, so a
 * pasted link is played by YouTube's own iframe player instead of the normal
 * pipeline — see the `yt` backend in watchPartyPlayer.ts.
 */

/** Only what this app calls. The full API is much larger; typing it all would
 * be typing a library we do not depend on. */
export type YtPlayer = {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(sec: number, allowSeekAhead: boolean): void;
  setPlaybackRate(rate: number): void;
  setVolume(pct: number): void;
  mute(): void;
  unMute(): void;
  getCurrentTime(): number;
  getDuration(): number;
  getVideoLoadedFraction(): number;
  getVideoData(): { title?: string } | undefined;
  destroy(): void;
};

export type YtPlayerOptions = {
  events?: {
    onReady?: () => void;
    onStateChange?: (e: { data: number }) => void;
    onError?: (e: { data: number }) => void;
  };
};

type YtNamespace = {
  /** Given an <iframe> that already points at an `enablejsapi=1` embed, the API
   * binds to it instead of building one. */
  Player: new (frame: HTMLIFrameElement, opts: YtPlayerOptions) => YtPlayer;
};

/** `onStateChange` codes. Named here rather than read off YT.PlayerState so the
 * constants are available before the API script has loaded. */
export const YT_ENDED = 0;
export const YT_PLAYING = 1;
export const YT_PAUSED = 2;
export const YT_BUFFERING = 3;

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

/**
 * The embed URL, written out rather than handed to the API as `playerVars` —
 * which is where `controls=0` went to die: the player came up with YouTube's
 * full control bar, "More videos" and all.
 *
 * `origin` is what `enablejsapi` posts its messages back to. YouTube wants a
 * real http(s) origin, so a `tauri://` one is left off rather than sent and
 * rejected.
 */
export function embedUrl(
  videoId: string,
  opts: { startSec?: number; autoplay?: boolean; origin?: string } = {},
): string {
  const params = new URLSearchParams({
    enablejsapi: "1",
    // The party's own transport is the only control.
    controls: "0",
    disablekb: "1",
    fs: "0",
    rel: "0",
    playsinline: "1",
    iv_load_policy: "3",
    autoplay: opts.autoplay ? "1" : "0",
  });
  const start = Math.floor(opts.startSec ?? 0);
  if (start > 0) params.set("start", String(start));
  if (opts.origin?.startsWith("http")) params.set("origin", opts.origin);
  return `https://www.youtube.com/embed/${videoId}?${params}`;
}

let apiPromise: Promise<YtNamespace> | null = null;

/** Loads (once) the iframe API script. It calls a global when ready, which is
 * the only handshake it offers. */
export function loadIframeApi(): Promise<YtNamespace> {
  if (apiPromise) return apiPromise;
  const w = window as unknown as { YT?: YtNamespace; onYouTubeIframeAPIReady?: () => void };
  apiPromise = new Promise<YtNamespace>((resolve, reject) => {
    if (w.YT?.Player) {
      resolve(w.YT);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => reject(new Error("YouTube's player could not be loaded"));
    w.onYouTubeIframeAPIReady = () => {
      if (w.YT?.Player) resolve(w.YT);
      else reject(new Error("YouTube's player could not be loaded"));
    };
    document.head.appendChild(script);
  }).catch((err) => {
    // Offline at the wrong moment must not poison every later attempt.
    apiPromise = null;
    throw err;
  });
  return apiPromise;
}

/** What the player reports when it refuses a video, in words a viewer can act
 * on. Codes: https://developers.google.com/youtube/iframe_api_reference */
export function ytErrorText(code: number): string {
  switch (code) {
    case 2:
      return "That YouTube link doesn't look right.";
    case 5:
      return "YouTube can't play this video here.";
    case 100:
      return "That video is private or has been removed.";
    case 101:
    case 150:
      return "The owner doesn't allow this video to be played outside YouTube.";
    default:
      return `YouTube player error ${code}`;
  }
}
