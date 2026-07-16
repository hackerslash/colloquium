import type { Identity } from "../../types/domain";
import type { HavenMessage } from "../../types/wire";
import { initPeerRegistry } from "../peer/registry";
import { derivePeerId } from "../peer/derivePeerId";
import * as rosterService from "../roster/rosterService";
import * as rosterRepo from "../db/rosterRepo";
import * as roomRepo from "../db/roomRepo";
import * as roomMembersRepo from "../db/roomMembersRepo";
import * as chatService from "../room/chatService";
import * as roomService from "../room/roomService";
import * as callService from "../call/callService";
import * as roomCallService from "../call/roomCallService";
import { useRosterStore } from "../../stores/useRosterStore";
import { useRoomStore } from "../../stores/useRoomStore";
import { useChatStore } from "../../stores/useChatStore";
import { notifyIfUnfocused } from "../notify";

const DISCOVERY_INTERVAL_MS = 2_000;

function findContactByPeerId(peerId: string) {
  const contacts = Object.values(useRosterStore.getState().contactsById);
  return contacts.find((c) => derivePeerId(c.identityId) === peerId) ?? null;
}

/** Ensures the DM room for a contact exists locally, then asks that peer to
 * backfill anything we're missing in it. Both sides derive the same room id,
 * so this is symmetric with no room-metadata exchange. */
async function syncDmWith(self: Identity, contactId: string, peerId: string) {
  const roomId = await chatService.dmRoomId(self.identityId, contactId);
  await roomRepo.ensureDmRoom(roomId, self.identityId, Date.now());
  await useRoomStore.getState().loadRooms();
  await chatService.requestRoomSync(roomId, peerId);

  // Backfill any group rooms we share with this peer too, so messages sent
  // while either side was offline converge on reconnect.
  const groupRooms = await roomMembersRepo.sharedGroupRoomIds(contactId);
  for (const gid of groupRooms) await chatService.requestRoomSync(gid, peerId);

  // Tell this peer about any group rooms we share, so rooms created while they
  // were offline still reach them (announce-on-create alone misses that case).
  await roomService.announceRoomsToPeer(self, contactId, peerId);
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
      void syncDmWith(self, contact.identityId, peerId);
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
    void routeMessage(peerId, data).catch((err) =>
      console.error("failed handling message from", peerId, err),
    );
  });

  registry.on("error", (err) => {
    console.warn("PeerRegistry error", err);
  });

  // Dial everyone as soon as the broker connection is actually open. The
  // initial discover() below fires before that and mostly no-ops; this is what
  // makes presence appear promptly instead of waiting for the next interval.
  registry.on("ready", () => discover());

  registry.start().catch((err) => {
    console.error("failed to register with the signaling broker", err);
  });

  async function routeMessage(peerId: string, data: unknown) {
    const msg = data as HavenMessage;
    switch (msg?.type) {
      case "invite_consume":
      case "invite_ack":
      case "roster_sync": {
        await rosterService.handleIncomingMessage(self, peerId, data);
        await useRosterStore.getState().loadRoster();
        // A newly-trusted contact needs its DM room and a backfill pass.
        const contact = findContactByPeerId(peerId);
        if (contact) await syncDmWith(self, contact.identityId, peerId);
        discover();
        break;
      }
      case "chat_message": {
        const stored = await chatService.handleChatMessage(self, msg, Date.now());
        if (stored) {
          useChatStore.getState().ingestMessage(stored);
          const author = useRosterStore.getState().contactsById[stored.authorId];
          void notifyIfUnfocused(
            author?.displayName ?? "New message",
            stored.body ?? "",
          );
        }
        break;
      }
      case "room_sync_request":
        await chatService.handleRoomSyncRequest(peerId, msg);
        break;
      case "room_sync_response": {
        const stored = await chatService.handleRoomSyncResponse(self, msg, Date.now());
        for (const m of stored) useChatStore.getState().ingestMessage(m);
        break;
      }
      case "call_invite":
        callService.handleCallInvite(self, msg);
        break;
      case "call_accept":
        callService.handleCallAccept(self, msg);
        break;
      case "call_decline":
        callService.handleCallDecline(self, msg);
        break;
      case "call_hangup":
        callService.handleCallHangup(self, msg);
        break;
      case "rtc_description":
        if (msg.channel === "dm") await callService.handleRtcDescription(self, msg);
        else await roomCallService.handleRtcDescription(self, msg);
        break;
      case "rtc_candidate":
        if (msg.channel === "dm") await callService.handleRtcCandidate(self, msg);
        else await roomCallService.handleRtcCandidate(self, msg);
        break;
      case "room_announce":
        await roomService.handleRoomAnnounce(self, msg);
        await useRoomStore.getState().loadRooms();
        break;
      case "room_call_join":
        roomCallService.handleRoomCallJoin(self, msg);
        break;
      case "room_call_leave":
        roomCallService.handleRoomCallLeave(self, msg);
        break;
      case "room_call_presence":
        roomCallService.handleRoomCallPresence(self, msg);
        break;
      case "slot_claim":
        roomCallService.handleSlotClaim(self, msg);
        break;
      case "slot_heartbeat":
        roomCallService.handleSlotHeartbeat(self, msg);
        break;
      case "slot_release":
        roomCallService.handleSlotRelease(self, msg);
        break;
    }
  }

  function discover() {
    const contacts = Object.values(useRosterStore.getState().contactsById);
    for (const contact of contacts) {
      if (contact.revoked) continue;
      const peerId = derivePeerId(contact.identityId);

      // Already connected (incoming or outgoing) — reconcile presence. A
      // contact can also be added to the roster (via roster_sync) after the
      // connection to them already opened, so this covers that case too.
      if (registry.isConnected(peerId)) {
        useRosterStore.getState().setPresence(contact.identityId, "online");
        continue;
      }

      // Only the lexicographically-smaller identity dials; the other waits for
      // the incoming connection. This makes exactly one connection per pair,
      // avoiding the glare where both dial and each side keeps a different
      // physical connection (which silently breaks delivery in one direction).
      if (self.identityId < contact.identityId) {
        useRosterStore.getState().setPresence(contact.identityId, "connecting");
        registry.connect(peerId).catch(() => {
          useRosterStore.getState().setPresence(contact.identityId, "offline");
        });
      } else {
        useRosterStore.getState().setPresence(contact.identityId, "offline");
      }
    }
  }

  discover();
  const intervalId = setInterval(discover, DISCOVERY_INTERVAL_MS);

  return () => {
    clearInterval(intervalId);
    registry.stop();
  };
}
