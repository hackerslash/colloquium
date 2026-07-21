import { describe, expect, it } from "vitest";
import {
  ANIMATED_EMOJI,
  ANIMATED_EMOJI_RE,
  animatedEmojiToken,
  humanizeAnimatedEmoji,
  isAnimatedEmojiToken,
  jumboAnimatedEmojiIds,
  resolveAnimatedEmojiUrl,
  resolveEmoji,
} from "./animatedEmoji";

describe("animatedEmojiToken / isAnimatedEmojiToken", () => {
  it("round-trips a known id", () => {
    const token = animatedEmojiToken("tada");
    expect(token).toBe(":fx:tada:");
    expect(isAnimatedEmojiToken(token)?.id).toBe("tada");
  });

  it("returns null for an unknown id", () => {
    expect(isAnimatedEmojiToken(":fx:not-a-real-emoji:")).toBeNull();
  });

  it("returns null for malformed tokens", () => {
    expect(isAnimatedEmojiToken(":fx:")).toBeNull();
    expect(isAnimatedEmojiToken("fx:tada:")).toBeNull();
    expect(isAnimatedEmojiToken(":fx:tada")).toBeNull();
    expect(isAnimatedEmojiToken(":fx:TADA:")).toBeNull();
    expect(isAnimatedEmojiToken(`:fx:${"x".repeat(25)}:`)).toBeNull();
  });

  it("is not fooled by a plain Unicode glyph", () => {
    expect(isAnimatedEmojiToken("🎉")).toBeNull();
  });
});

describe("ANIMATED_EMOJI_RE", () => {
  it("extracts all tokens from a mixed body string", () => {
    const body = "gg :fx:tada: nice work :fx:fire: 🔥";
    const ids = [...body.matchAll(new RegExp(ANIMATED_EMOJI_RE.source, "g"))].map((m) => m[1]);
    expect(ids).toEqual(["tada", "fire"]);
  });

  it("does not match near-miss strings", () => {
    const body = ":fx: not-a-token :fx:TOO-LONG-ID-OVER-24-CHARS-XX: fx:tada:";
    const ids = [...body.matchAll(new RegExp(ANIMATED_EMOJI_RE.source, "g"))];
    expect(ids).toHaveLength(0);
  });
});

describe("resolveEmoji", () => {
  it("resolves a plain glyph as-is", () => {
    expect(resolveEmoji("🎉")).toEqual({ kind: "glyph", glyph: "🎉" });
  });

  it("resolves a known token to its animated asset", () => {
    const resolved = resolveEmoji(":fx:tada:");
    expect(resolved.kind).toBe("animated");
    if (resolved.kind === "animated") {
      expect(resolved.name).toBe("Party Popper");
      expect(resolved.url).toBeTruthy();
    }
  });

  it("falls back to glyph rendering for an unknown/stale token", () => {
    expect(resolveEmoji(":fx:removed-in-a-future-release:")).toEqual({
      kind: "glyph",
      glyph: ":fx:removed-in-a-future-release:",
    });
  });
});

describe("humanizeAnimatedEmoji", () => {
  it("replaces tokens with a readable [Name] label", () => {
    expect(humanizeAnimatedEmoji("nice :fx:tada: work")).toBe("nice [Party Popper] work");
  });

  it("handles multiple tokens", () => {
    expect(humanizeAnimatedEmoji(":fx:fire::fx:tada:")).toBe("[Fire][Party Popper]");
  });

  it("is a no-op for text with no tokens", () => {
    expect(humanizeAnimatedEmoji("plain text 🎉")).toBe("plain text 🎉");
  });

  it("leaves an unknown token as literal text", () => {
    expect(humanizeAnimatedEmoji("hi :fx:not-real:")).toBe("hi :fx:not-real:");
  });
});

describe("jumboAnimatedEmojiIds", () => {
  it("returns the id for a single-emoji body", () => {
    expect(jumboAnimatedEmojiIds(":fx:tada:")).toEqual(["tada"]);
  });

  it("returns ids in order for up to 3 emoji with only whitespace between them", () => {
    expect(jumboAnimatedEmojiIds(":fx:tada: :fx:fire:  :fx:heart:")).toEqual(["tada", "fire", "heart"]);
    expect(jumboAnimatedEmojiIds(":fx:tada::fx:fire:")).toEqual(["tada", "fire"]);
  });

  it("returns null for mixed text and emoji", () => {
    expect(jumboAnimatedEmojiIds("nice :fx:tada:")).toBeNull();
    expect(jumboAnimatedEmojiIds(":fx:tada: nice")).toBeNull();
  });

  it("returns null for a plain glyph or plain text body", () => {
    expect(jumboAnimatedEmojiIds("🎉")).toBeNull();
    expect(jumboAnimatedEmojiIds("hello")).toBeNull();
  });

  it("returns null for null or empty/whitespace-only body", () => {
    expect(jumboAnimatedEmojiIds(null)).toBeNull();
    expect(jumboAnimatedEmojiIds("")).toBeNull();
    expect(jumboAnimatedEmojiIds("   ")).toBeNull();
  });

  it("returns null when there are more than 3 emoji", () => {
    expect(jumboAnimatedEmojiIds(":fx:tada: :fx:fire: :fx:heart: :fx:joy:")).toBeNull();
  });

  it("returns null when a token's id isn't a known emoji", () => {
    expect(jumboAnimatedEmojiIds(":fx:not-real:")).toBeNull();
  });
});

describe("ANIMATED_EMOJI manifest", () => {
  it("every entry resolves to a bundled asset", () => {
    for (const def of ANIMATED_EMOJI) {
      expect(resolveAnimatedEmojiUrl(def.id), `missing asset for id "${def.id}"`).toBeTruthy();
    }
  });

  it("has no duplicate ids", () => {
    const ids = ANIMATED_EMOJI.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every id matches the token id grammar", () => {
    for (const def of ANIMATED_EMOJI) {
      expect(def.id).toMatch(/^[a-z0-9-]{1,24}$/);
    }
  });
});
