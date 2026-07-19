import { describe, expect, it } from "vitest";
import {
  humanizeMentions,
  mentionToken,
  mentionedIds,
  mentionsIdentity,
} from "./mentions";

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);

describe("mentionToken", () => {
  it("round-trips through the parser", () => {
    const token = mentionToken("Alice", ID_A);
    expect(token).toBe(`@[Alice](${ID_A})`);
    expect([...mentionedIds(token)]).toEqual([ID_A]);
  });

  it("strips characters that would break the token grammar", () => {
    const token = mentionToken("Ali]ce\nBob", ID_A);
    expect(token).toBe(`@[AliceBob](${ID_A})`);
    // Still parses to exactly the one id.
    expect([...mentionedIds(token)]).toEqual([ID_A]);
  });

  it("keeps parentheses in the display name (only ] and newline are unsafe)", () => {
    const token = mentionToken("Bob (Work)", ID_B);
    expect([...mentionedIds(token)]).toEqual([ID_B]);
  });

  it("falls back to a placeholder name when sanitization empties it", () => {
    expect(mentionToken("]]]", ID_A)).toBe(`@[user](${ID_A})`);
  });

  it("clamps the display name to 64 chars", () => {
    const token = mentionToken("x".repeat(200), ID_A);
    expect([...mentionedIds(token)]).toEqual([ID_A]);
  });
});

describe("mentionedIds", () => {
  it("returns empty for null/empty/plain text", () => {
    expect(mentionedIds(null).size).toBe(0);
    expect(mentionedIds("").size).toBe(0);
    expect(mentionedIds("no mentions here").size).toBe(0);
  });

  it("collects multiple distinct ids and dedupes", () => {
    const body = `hey ${mentionToken("A", ID_A)} and ${mentionToken("B", ID_B)} and ${mentionToken("A2", ID_A)}`;
    expect([...mentionedIds(body)].sort()).toEqual([ID_A, ID_B].sort());
  });

  it("does not match a bare id or an @name without the token shape", () => {
    expect(mentionedIds(`@Alice`).size).toBe(0);
    expect(mentionedIds(`@[Alice]`).size).toBe(0);
    expect(mentionedIds(`[Alice](${ID_A})`).size).toBe(0);
  });
});

describe("mentionsIdentity", () => {
  it("is true only for an id actually mentioned", () => {
    const body = mentionToken("Alice", ID_A);
    expect(mentionsIdentity(body, ID_A)).toBe(true);
    expect(mentionsIdentity(body, ID_B)).toBe(false);
  });

  it("is false for null body or empty id", () => {
    expect(mentionsIdentity(null, ID_A)).toBe(false);
    expect(mentionsIdentity(mentionToken("Alice", ID_A), "")).toBe(false);
  });

  it("is not fooled by a prefix of the id", () => {
    const body = mentionToken("Alice", ID_A);
    expect(mentionsIdentity(body, ID_A.slice(0, 32))).toBe(false);
  });
});

describe("humanizeMentions", () => {
  it("replaces tokens with @Name and leaves other text intact", () => {
    const body = `ping ${mentionToken("Alice", ID_A)}, thanks`;
    expect(humanizeMentions(body)).toBe("ping @Alice, thanks");
  });

  it("handles multiple tokens", () => {
    const body = `${mentionToken("A", ID_A)} ${mentionToken("B", ID_B)}`;
    expect(humanizeMentions(body)).toBe("@A @B");
  });

  it("is a no-op for text with no tokens", () => {
    expect(humanizeMentions("plain text")).toBe("plain text");
  });
});
