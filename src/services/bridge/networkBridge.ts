import type { Identity, Presence } from "../../types/domain";
import type { HavenMessage, MsgAckMessage } from "../../types/wire";
import { initPeerRegistry, getOutbox } from "../peer/registry";
import { derivePeerId } from "../peer/derivePeerId";
import * as messageRepo from "../db/messageRepo";
import * as rosterService from "../roster/rosterService";
import * as friendRequestService from "../roster/friendRequestService";
import * as rosterRepo from "../db/rosterRepo";
import * as roomRepo from "../db/roomRepo";
import * as roomMembersRepo from "../db/roomMembersRepo";
import * as chatService from "../room/chatService";
import * as roomService from "../room/roomService";
import * as callService from "../call/callService";
import * as roomCallService from "../call/roomCallService";
import { getRoomCallPresenceTracker } from "../call/RoomCallPresenceTracker";
import { useRosterStore } from "../../stores/useRosterStore";
import { useRoomStore } from "../../stores/useRoomStore";
import { useChatStore } from "../../stores/useChatStore";
import { notifyIfUnfocused } from "../notify";

const DISCOVERY_INTERVAL_MS = 2_000;
const REANNOUNCE_INTERVAL_MS = 5 * 60_000;

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

/** Makes a freshly-trusted contact visible locally right away — reloads the
 * roster (sidebar) and ensures the DM room exists + backfills — instead of
 * waiting for the peer's roster_sync echo (which a connection blip can drop).
 * Used after accepting an incoming request and after our outgoing request is
 * accepted. */
export async function reflectNewContactLocally(
  self: Identity,
  contactId: string,
  peerId?: string,
): Promise<void> {
  await useRosterStore.getState().loadRoster();
  await syncDmWith(self, contactId, peerId ?? derivePeerId(contactId));
}

/** Starts this device's PeerJS registration, wires its events into the roster
 * store/DB, and kicks off the periodic discovery loop that's how a returning
 * trusted member becomes reachable again with no re-invite. Call once, after
 * identity is known, and call the returned teardown on sign-out/app close. */
export function initNetworkBridge(self: Identity): () => void {
  const registry = initPeerRegistry(self.identityId);
  let brokerUp = false;

  function setPresence(contactId: string, presence: Presence) {
    useRosterStore.getState().setPresence(contactId, presence);
  }

  registry.on("peer-connected", (peerId) => {
    const contact = findContactByPeerId(peerId);
    if (contact) {
      setPresence(contact.identityId, "online");
      void rosterRepo
        .markSeen(contact.identityId, peerId, Date.now())
        .catch((err) => console.error("failed to record peer seen", peerId, err));
      void syncDmWith(self, contact.identityId, peerId).catch((err) =>
        console.error("failed to sync DM with", peerId, err),
      );
    }
    void rosterService
      .sendRosterSync(self, peerId)
      .catch((err) => console.error("failed to send roster sync to", peerId, err));
  });

  registry.on("peer-disconnected", (peerId) => {
    const contact = findContactByPeerId(peerId);
    if (contact) setPresence(contact.identityId, "offline");
  });

  registry.on("dial-failed", (peerId) => {
    const contact = findContactByPeerId(peerId);
    if (contact) setPresence(contact.identityId, "offline");
  });

  registry.on("broker-down", () => {
    brokerUp = false;
    // Presence can't be trusted while signaling is down. Established
    // connections stay (their heartbeat is the authority); everyone else
    // drops out of "connecting" limbo.
    for (const contact of Object.values(useRosterStore.getState().contactsById)) {
      if (!registry.isConnected(derivePeerId(contact.identityId))) {
        setPresence(contact.identityId, "offline");
      }
    }
  });

  registry.on("broker-up", () => {
    brokerUp = true;
    discover();
  });

  // Messages from the SAME peer must be handled in arrival order — two
  // rtc_description messages handled concurrently (e.g. a renegotiation
  // racing a camera-toggle offer) can both observe signalingState "stable"
  // and both call setRemoteDescription, so the second throws and the
  // renegotiation is silently lost. Different peers stay fully concurrent;
  // only messages sharing a peerId queue behind each other.
  const perPeerChain = new Map<string, Promise<void>>();
  function enqueueForPeer(peerId: string, data: unknown) {
    const prevSettled = (perPeerChain.get(peerId) ?? Promise.resolve()).catch(() => {});
    const result = prevSettled.then(() => routeMessage(peerId, data));
    perPeerChain.set(peerId, result);
    result.catch((err) => console.error("failed handling message from", peerId, err));
  }

  registry.on("message", (peerId, data) => {
    enqueueForPeer(peerId, data);
  });

  registry.on("error", (err) => {
    console.warn("PeerRegistry error", err);
  });

  registry.start().catch((err) => {
    console.error("failed to register with the signaling broker", err);
  });

  function ackMessage(toPeerId: string, roomId: string, messageId: string) {
    const ack: MsgAckMessage = { type: "msg_ack", roomId, messageId };
    registry.send(toPeerId, ack);
  }

  /** Bumps the room's unread count unless it's the room the user is currently
   * viewing in a focused window (in which case it's read on arrival). */
  function markUnreadIfInactive(roomId: string) {
    const roomStore = useRoomStore.getState();
    const isActive = roomStore.activeRoomId === roomId && document.hasFocus();
    if (isActive) void roomStore.markRead(roomId);
    else roomStore.bumpUnread(roomId);
  }

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
      case "friend_request":
        await friendRequestService.handleFriendRequest(self, msg);
        break;
      case "friend_request_response": {
        const addedId = await friendRequestService.handleFriendRequestResponse(self, msg);
        if (addedId) await reflectNewContactLocally(self, addedId, peerId);
        break;
      }
      case "file_chunk":
        await chatService.handleFileChunk(msg);
        break;
      case "chat_message": {
        const stored = await chatService.handleChatMessage(self, msg, Date.now());
        if (stored) {
          ackMessage(peerId, stored.roomId, stored.id);
          useChatStore.getState().ingestMessage(stored);
          markUnreadIfInactive(stored.roomId);
          const author = useRosterStore.getState().contactsById[stored.authorId];
          void notifyIfUnfocused(
            author?.displayName ?? "New message",
            stored.body ?? "",
          );
        }
        break;
      }
      case "msg_ack":
        await messageRepo.setDeliveryStatus(msg.messageId, "delivered");
        useChatStore.getState().updateMessageStatus(msg.roomId, msg.messageId, "delivered");
        break;
      case "room_sync_request": {
        // The requester's have-vector doubles as a receipt: anything of ours
        // at or below their seq is already on their device.
        const flipped = await chatService.handleRoomSyncRequest(self.identityId, peerId, msg);
        if (flipped) await useChatStore.getState().refreshRoom(msg.roomId);
        break;
      }
      case "room_sync_response": {
        const stored = await chatService.handleRoomSyncResponse(self, msg, Date.now());
        for (const m of stored) {
          // Ack the author directly (best effort) — the relaying peer isn't
          // necessarily who wrote the message.
          ackMessage(derivePeerId(m.authorId), m.roomId, m.id);
          useChatStore.getState().ingestMessage(m);
          // Backfilled messages count as unread but don't fire a notification.
          markUnreadIfInactive(m.roomId);
        }
        break;
      }
      case "call_invite":
        callService.handleCallInvite(self, msg);
        break;
      case "call_ringing":
        callService.handleCallRinging(self, msg);
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
      case "room_leave":
        await roomService.handleRoomLeave(self, msg);
        await useRoomStore.getState().loadRooms();
        break;
      case "room_call_beacon":
        getRoomCallPresenceTracker().applyBeacon(msg);
        roomCallService.handleRoomCallBeacon(self, msg);
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
    registry.heartbeatTick(Date.now());
    getOutbox().sweep();
    getRoomCallPresenceTracker().sweep();
    if (!brokerUp) return;

    const contacts = Object.values(useRosterStore.getState().contactsById);
    for (const contact of contacts) {
      if (contact.revoked) continue;
      const peerId = derivePeerId(contact.identityId);

      // Already connected (incoming or outgoing) — reconcile presence. A
      // contact can also be added to the roster (via roster_sync) after the
      // connection to them already opened, so this covers that case too.
      if (registry.isConnected(peerId)) {
        setPresence(contact.identityId, "online");
        continue;
      }

      // Both sides dial; the registry resolves glare deterministically. A
      // peer in dial backoff just shows offline until its next attempt.
      if (!registry.canDial(peerId)) {
        setPresence(contact.identityId, "offline");
        continue;
      }

      setPresence(contact.identityId, "connecting");
      registry.connect(peerId).catch(() => {
        // dial-failed / peer-disconnected events settle presence
      });
    }
  }

  const intervalId = setInterval(discover, DISCOVERY_INTERVAL_MS);

  // Slow gossip: LWW-merged re-announces converge member sets that diverged
  // while someone was offline past the Outbox TTL.
  const reannounceId = setInterval(() => {
    void roomService.reannounceAllGroupRooms(self);
  }, REANNOUNCE_INTERVAL_MS);

  return () => {
    clearInterval(intervalId);
    clearInterval(reannounceId);
    registry.stop();
  };
}
