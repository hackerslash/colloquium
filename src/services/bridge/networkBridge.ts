import type { Identity } from "../../types/domain";
import { initPeerRegistry } from "../peer/registry";
import { derivePeerId } from "../peer/derivePeerId";
import * as rosterService from "../roster/rosterService";
import * as rosterRepo from "../db/rosterRepo";
import { useRosterStore } from "../../stores/useRosterStore";

const DISCOVERY_INTERVAL_MS = 20_000;

function findContactByPeerId(peerId: string) {
  const contacts = Object.values(useRosterStore.getState().contactsById);
  return contacts.find((c) => derivePeerId(c.identityId) === peerId) ?? null;
}

/** Starts this device's PeerJS registration, wires its events into the roster
 * store/DB, and kicks off the periodic discovery loop that's how a returning
 * trusted member becomes reachable again with no re-invite. Call once, after
 * identity is known, and call the returned teardown on sign-out/app close. */
export function initNetworkBridge(self: Identity): () => void {
  const registry = initPeerRegistry(self.identityId);

  registry.on("peer-connected", (peerId) => {
    const contact = findContactByPeerId(peerId);
    if (contact) {
      useRosterStore.getState().setPresence(contact.identityId, "online");
      void rosterRepo.markSeen(contact.identityId, peerId, Date.now());
    }
    void rosterService.sendRosterSync(self, peerId);
  });

  registry.on("peer-disconnected", (peerId) => {
    const contact = findContactByPeerId(peerId);
    if (contact) {
      useRosterStore.getState().setPresence(contact.identityId, "offline");
    }
  });

  registry.on("message", (peerId, data) => {
    void rosterService
      .handleIncomingMessage(self, peerId, data)
      .then(() => useRosterStore.getState().loadRoster())
      .then(discover)
      .catch((err) => console.error("failed handling message from", peerId, err));
  });

  registry.on("error", (err) => {
    console.warn("PeerRegistry error", err);
  });

  registry.start().catch((err) => {
    console.error("failed to register with the signaling broker", err);
  });

  function discover() {
    const contacts = Object.values(useRosterStore.getState().contactsById);
    for (const contact of contacts) {
      if (contact.revoked) continue;
      const peerId = derivePeerId(contact.identityId);

      // Already connected — a contact can be added to the roster (e.g. via
      // roster_sync) after the connection to them was already opened, so
      // this reconciles presence for that case instead of only reacting to
      // the "peer-connected" event, which may have fired before the roster
      // row existed.
      if (registry.isConnected(peerId)) {
        useRosterStore.getState().setPresence(contact.identityId, "online");
        continue;
      }

      useRosterStore.getState().setPresence(contact.identityId, "connecting");
      registry.connect(peerId).catch(() => {
        useRosterStore.getState().setPresence(contact.identityId, "offline");
      });
    }
  }

  discover();
  const intervalId = setInterval(discover, DISCOVERY_INTERVAL_MS);

  return () => {
    clearInterval(intervalId);
    registry.stop();
  };
}
