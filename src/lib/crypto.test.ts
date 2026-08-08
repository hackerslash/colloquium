import { describe, expect, it } from "vitest";
import { safetyNumber } from "./crypto";
import { bytesToBase64 } from "./base64";

function key(fill: number): string {
  return bytesToBase64(new Uint8Array(32).fill(fill));
}

const A = key(1);
const B = key(2);

describe("safetyNumber", () => {
  it("is symmetric — both devices derive the same number", async () => {
    expect(await safetyNumber(A, B)).toEqual(await safetyNumber(B, A));
  });

  it("is 12 groups of exactly 5 digits", async () => {
    const groups = await safetyNumber(A, B);
    expect(groups).toHaveLength(12);
    for (const g of groups) expect(g).toMatch(/^\d{5}$/);
  });

  it("changes if either key changes — a substituted key can't match", async () => {
    const real = await safetyNumber(A, B);
    const mitm = await safetyNumber(A, key(3));
    expect(mitm).not.toEqual(real);
  });

  it("distinguishes a one-byte key difference", async () => {
    const tweaked = new Uint8Array(32).fill(2);
    tweaked[31] = 3;
    expect(await safetyNumber(A, bytesToBase64(tweaked))).not.toEqual(await safetyNumber(A, B));
  });
});
