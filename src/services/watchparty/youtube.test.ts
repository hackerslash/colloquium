import { describe, expect, it } from "vitest";
import { embedUrl, youtubeId } from "./youtube";

describe("youtubeId", () => {
  it("reads the id out of the link shapes people paste", () => {
    const id = "dQw4w9WgXcQ";
    expect(youtubeId("https://www.youtube.com/watch?v=" + id)).toBe(id);
    expect(youtubeId("https://youtube.com/watch?v=" + id + "&list=PL123&t=42s")).toBe(id);
    expect(youtubeId("https://m.youtube.com/watch?v=" + id)).toBe(id);
    expect(youtubeId("https://music.youtube.com/watch?v=" + id)).toBe(id);
    expect(youtubeId("https://youtu.be/" + id + "?t=42")).toBe(id);
    expect(youtubeId("https://www.youtube.com/shorts/" + id)).toBe(id);
    expect(youtubeId("https://www.youtube.com/live/" + id)).toBe(id);
    expect(youtubeId("https://www.youtube-nocookie.com/embed/" + id)).toBe(id);
    expect(youtubeId("  https://youtu.be/" + id + "  ")).toBe(id);
  });

  it("is null for everything else, so those sources still go to ffmpeg", () => {
    expect(youtubeId("https://example.com/film.mkv")).toBeNull();
    expect(youtubeId("https://www.youtube.com/@someone")).toBeNull();
    expect(youtubeId("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(youtubeId("/home/me/film.mkv")).toBeNull();
    expect(youtubeId("")).toBeNull();
    // A host that merely ends in youtube.com is not YouTube.
    expect(youtubeId("https://notyoutube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });
});

describe("embedUrl", () => {
  it("asks for a bare player, in the src where the player reads it", () => {
    const p = new URL(embedUrl("dQw4w9WgXcQ")).searchParams;
    expect(p.get("controls")).toBe("0");
    expect(p.get("enablejsapi")).toBe("1");
    expect(p.get("rel")).toBe("0");
    expect(p.get("disablekb")).toBe("1");
    expect(p.get("fs")).toBe("0");
    expect(p.get("autoplay")).toBe("0");
    expect(p.has("start")).toBe(false);
  });

  it("carries the position and an http origin, and drops a tauri:// one", () => {
    const p = new URL(
      embedUrl("dQw4w9WgXcQ", { startSec: 91.6, autoplay: true, origin: "http://tauri.localhost" }),
    ).searchParams;
    expect(p.get("start")).toBe("91");
    expect(p.get("autoplay")).toBe("1");
    expect(p.get("origin")).toBe("http://tauri.localhost");
    expect(new URL(embedUrl("dQw4w9WgXcQ", { origin: "tauri://localhost" })).searchParams.has("origin")).toBe(false);
  });
});
