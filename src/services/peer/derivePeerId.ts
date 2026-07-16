/** Deterministic PeerJS broker ID for a trusted identity — lets any other
 * trusted member dial this device without a directory server, and is how a
 * returning member is reachable again without ever re-inviting. */
export function derivePeerId(identityId: string): string {
  return `haven-${identityId.slice(0, 40)}`;
}
