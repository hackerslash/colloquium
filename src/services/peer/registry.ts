import { PeerRegistry } from "./PeerRegistry";
import { Outbox } from "./Outbox";

let instance: PeerRegistry | null = null;
let outbox: Outbox | null = null;

export function initPeerRegistry(selfIdentityId: string): PeerRegistry {
  if (!instance) {
    instance = new PeerRegistry(selfIdentityId);
    outbox = new Outbox(instance);
  }
  return instance;
}

export function getPeerRegistry(): PeerRegistry {
  if (!instance) throw new Error("PeerRegistry has not been initialized yet");
  return instance;
}

export function getOutbox(): Outbox {
  if (!outbox) throw new Error("PeerRegistry has not been initialized yet");
  return outbox;
}
