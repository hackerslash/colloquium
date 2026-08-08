import { base64ToBytes } from "./base64";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Recomputes hex(SHA-256(publicKey)) to sanity-check a claimed identityId
 * against the public key it's supposed to be derived from — cheap
 * defense-in-depth on top of signature verification for any identity claim
 * that crosses the network (invite payloads, invite_consume, roster entries). */
export async function computeIdentityId(publicKeyBase64: string): Promise<string> {
  return sha256Hex(base64ToBytes(publicKeyBase64));
}

/** Signal-style safety number for a pair of identities: 12 groups of 5 digits,
 * to be read aloud or compared in person. The one thing the broker-mediated
 * invite can't prove is that the key you received is the key they sent, and
 * this is the out-of-band check that closes it.
 *
 * The two public keys are concatenated in sorted order, not "mine then
 * theirs", so both devices derive the identical string with no negotiation.
 * 60 digits is ~199 bits — Signal's iterated hashing exists to slow brute-force
 * of a truncated fingerprint, and there is nothing truncated enough here to
 * bother. */
export async function safetyNumber(
  publicKeyA: string,
  publicKeyB: string,
): Promise<string[]> {
  const [lo, hi] = [publicKeyA, publicKeyB].sort();
  const a = base64ToBytes(lo);
  const b = base64ToBytes(hi);
  const input = new Uint8Array(a.length + b.length);
  input.set(a);
  input.set(b, a.length);

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", input.buffer));
  const groups: string[] = [];
  for (let i = 0; i < 60; i += 5) {
    // 5 bytes big-endian: max 2^40, well inside float64's exact integer range.
    let v = 0;
    for (let j = 0; j < 5; j++) v = v * 256 + digest[i + j];
    groups.push(String(v % 100000).padStart(5, "0"));
  }
  return groups;
}
