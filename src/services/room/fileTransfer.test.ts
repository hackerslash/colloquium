import { describe, expect, it } from "vitest";
import { MAX_FILE_CHUNKS, MAX_FILE_SIZE } from "./chatService";

/** Mirrors the send path: base64-encode, then slice into CHUNK_SIZE pieces. */
function chunksFor(bytes: number): number {
  const base64Length = Math.ceil(bytes / 3) * 4;
  return Math.max(1, Math.ceil(base64Length / (16 * 1024)));
}

describe("attachment chunk bound", () => {
  it("accepts a file at exactly the advertised limit", () => {
    expect(chunksFor(MAX_FILE_SIZE)).toBeLessThanOrEqual(MAX_FILE_CHUNKS);
  });

  it("accepts the whole range the sender allows, not just the low end", () => {
    for (const bytes of [0, 1, 1024, MAX_FILE_SIZE - 4096, MAX_FILE_SIZE - 1, MAX_FILE_SIZE]) {
      expect(chunksFor(bytes)).toBeLessThanOrEqual(MAX_FILE_CHUNKS);
    }
  });

  it("still rejects a sender claiming more chunks than the limit can produce", () => {
    expect(chunksFor(MAX_FILE_SIZE * 2)).toBeGreaterThan(MAX_FILE_CHUNKS);
  });
});
