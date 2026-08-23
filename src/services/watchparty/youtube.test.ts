import { describe, expect, it } from "vitest";
import { youtubeId } from "./youtube";

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
