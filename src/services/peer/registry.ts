import { PeerRegistry } from "./PeerRegistry";

let instance: PeerRegistry | null = null;

export function initPeerRegistry(selfIdentityId: string): PeerRegistry {
  if (!instance) instance = new PeerRegistry(selfIdentityId);
  return instance;
}

export function getPeerRegistry(): PeerRegistry {
  if (!instance) throw new Error("PeerRegistry has not been initialized yet");
  return instance;
}
