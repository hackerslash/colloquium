import { describe, expect, it } from "vitest";
import { contiguousSeqs, toFtsQuery } from "./messageRepo";

describe("contiguousSeqs", () => {
  const pairs = (author: string, seqs: number[]) =>
    seqs.map((author_seq) => ({ author_id: author, author_seq }));

  it("reports the full run when there are no gaps", () => {
    expect(contiguousSeqs(pairs("a", [1, 2, 3]))).toEqual({ a: 3 });
  });

  it("stops at the first gap so the peer resends the missing middle", () => {
    expect(contiguousSeqs(pairs("a", [1, 2, 5, 6]))).toEqual({ a: 2 });
  });

  it("omits an author whose first message is missing", () => {
    expect(contiguousSeqs(pairs("a", [2, 3]))).toEqual({});
  });

  it("tracks each author independently", () => {
    expect(contiguousSeqs([...pairs("a", [1, 2]), ...pairs("b", [1, 3])])).toEqual({ a: 2, b: 1 });
  });

  it("is empty for a room we hold nothing in", () => {
    expect(contiguousSeqs([])).toEqual({});
  });
});

describe("toFtsQuery", () => {
  it("quotes and prefix-matches a single token", () => {
    expect(toFtsQuery("foo")).toBe('"foo"*');
  });

  it("quotes each token of a multi-token query", () => {
    expect(toFtsQuery("foo ba")).toBe('"foo"* "ba"*');
  });

  it("collapses arbitrary whitespace between tokens", () => {
    expect(toFtsQuery("  foo\t bar\n baz ")).toBe('"foo"* "bar"* "baz"*');
  });

  it("escapes embedded double quotes so they are literals", () => {
    expect(toFtsQuery('fo"o')).toBe('"fo""o"*');
  });

  it("treats FTS metacharacters as literal text (no throw semantics)", () => {
    expect(toFtsQuery('"foo (bar')).toBe('"""foo"* "(bar"*');
  });

  it("returns null for an empty or whitespace-only query", () => {
    expect(toFtsQuery("")).toBeNull();
    expect(toFtsQuery("   \t\n ")).toBeNull();
  });
});
