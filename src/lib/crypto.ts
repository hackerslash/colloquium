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
