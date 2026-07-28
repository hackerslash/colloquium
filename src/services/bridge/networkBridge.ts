import type { Identity, Message, Presence } from "../../types/domain";
import type { ColloquiumMessage, MsgAckMessage } from "../../types/wire";
import { initPeerRegistry, getOutbox } from "../peer/registry";
import { derivePeerId } from "../peer/derivePeerId";
import * as messageRepo from "../db/messageRepo";
import * as rosterService from "../roster/rosterService";
import * as avatarService from "../avatar/avatarService";
import * as rosterRepo from "../db/rosterRepo";
import * as roomRepo from "../db/roomRepo";
import * as roomMembersRepo from "../db/roomMembersRepo";
import * as chatService from "../room/chatService";
import * as roomService from "../room/roomService";
import * as callService from "../call/callService";
import * as roomCallService from "../call/roomCallService";
import * as watchPartyService from "../watchparty/watchPartyService";
import { getRoomCallPresenceTracker } from "../call/RoomCallPresenceTracker";
import { useRosterStore } from "../../stores/useRosterStore";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { useRoomStore } from "../../stores/useRoomStore";
import { useChatStore } from "../../stores/useChatStore";
import { useTypingStore } from "../../stores/useTypingStore";
import { useRoomCallStore } from "../../stores/useRoomCallStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { notifyIfUnfocused } from "../notify";
import { playMessageSound } from "../sound";
import { humanizeMentions, mentionsIdentity } from "../../lib/mentions";
import { humanizeAnimatedEmoji } from "../../lib/animatedEmoji";

const DISCOVERY_INTERVAL_MS = 2_000;
const REANNOUNCE_INTERVAL_MS = 5 * 60_000;

/** Notification body for an incoming message. Attachment-only messages have a
 * null body, so describe them instead of showing an empty banner; with
 * previews off, never leak content — just say a message arrived. */
function messageNotificationBody(message: Message): string {
  if (!useSettingsStore.getState().notificationPreviews) return "New message";
  if (message.body) return humanizeAnimatedEmoji(humanizeMentions(message.body));
  if (message.contentType === "image") return "Sent an image";
  if (message.contentType === "file") {
    return message.attachmentName ? `Sent a file: ${message.attachmentName}` : "Sent a file";
  }
  return "New message";
}

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

  // The bridge starts once with the boot-time identity, but the display name
  // (and avatar) can change mid-session. Always read the live identity so a
  // reconnect never re-announces a stale profile with a fresher LWW timestamp,
  // which would clobber the correct name on a peer that already received it.
  const getSelf = () => useIdentityStore.getState().self ?? self;

  function setPresence(contactId: string, presence: Presence) {
    useRosterStore.getState().setPresence(contactId, presence);
  }

  // Throttles the periodic "last seen" persistence for a peer that stays
  // online, so the timestamp survives a force-quit without writing every tick.
  const lastSeenPersist = new Map<string, number>();
  function recordSeen(contactId: string, peerId: string) {
    const now = Date.now();
    lastSeenPersist.set(contactId, now);
    useRosterStore.getState().noteSeen(contactId, now);
    void rosterRepo
      .markSeen(contactId, peerId, now)
      .catch((err) => console.error("failed to record peer seen", peerId, err));
  }

  registry.on("peer-connected", (peerId) => {
    const contact = findContactByPeerId(peerId);
    if (contact) {
      setPresence(contact.identityId, "online");
      recordSeen(contact.identityId, peerId);
      void syncDmWith(getSelf(), contact.identityId, peerId).catch((err) =>
        console.error("failed to sync DM with", peerId, err),
      );
      // Only ever share the roster with a peer we already trust — otherwise any
      // stranger who dials receives every contact's id, key, and display name.
      void rosterService
        .sendRosterSync(getSelf(), peerId)
        .catch((err) => console.error("failed to send roster sync to", peerId, err));
      void avatarService
        .announceProfileTo(getSelf(), peerId)
        .catch((err) => console.error("failed to announce profile to", peerId, err));
    }
  });

  registry.on("peer-disconnected", (peerId) => {
    const contact = findContactByPeerId(peerId);
    if (contact) {
      setPresence(contact.identityId, "offline");
      // Record the session end too, so "last seen" reflects when they dropped.
      recordSeen(contact.identityId, peerId);
    }
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

  // Release our broker id the moment the window goes away (quit or reload).
  // Without this the broker holds the id as a ghost until its heartbeat
  // timeout, and the next launch can't register under the canonical id.
  const onPageHide = () => registry.stop();
  window.addEventListener("pagehide", onPageHide);

  function ackMessage(toPeerId: string, roomId: string, messageId: string) {
    const ack: MsgAckMessage = { type: "msg_ack", roomId, messageId };
    registry.send(toPeerId, ack);
  }

  /** Bumps the room's unread count unless it's the room the user is currently
   * viewing in a focused window (in which case it's read on arrival). Returns
   * whether the room was active, so callers can gate per-message alerts. */
  function markUnreadIfInactive(roomId: string, count = 1): boolean {
    const roomStore = useRoomStore.getState();
    const isActive = roomStore.activeRoomId === roomId && document.hasFocus();
    if (isActive) void roomStore.markRead(roomId);
    else roomStore.bumpUnread(roomId, count);
    return isActive;
  }

  // The invite handshake is how trust is first established, so it's the only
  // traffic accepted from a peer that isn't yet a contact. Everything else —
  // chat, roster sync, room sync, acks, call/room-call signaling — must come
  // from a peer that maps to a trusted, non-revoked contact. Without this gate
  // a stranger who dials could inject messages, pull room history, forge roster
  // and leave events, flip delivery state, or spam call invites.
  const TRUST_ESTABLISHING = new Set<ColloquiumMessage["type"]>([
    "invite_consume",
    "invite_ack",
  ]);

  async function routeMessage(peerId: string, data: unknown) {
    const msg = data as ColloquiumMessage;
    if (!msg?.type) return;
    const sender = findContactByPeerId(peerId);
    if (!TRUST_ESTABLISHING.has(msg.type) && (!sender || sender.revoked)) {
      console.warn("dropping", msg.type, "from untrusted peer", peerId);
      return;
    }
    switch (msg.type) {
      case "invite_consume":
      case "invite_ack":
      case "roster_sync": {
        await rosterService.handleIncomingMessage(getSelf(), peerId, data);
        await useRosterStore.getState().loadRoster();
        // A newly-trusted contact needs its DM room and a backfill pass.
        const contact = findContactByPeerId(peerId);
        if (contact) await syncDmWith(getSelf(), contact.identityId, peerId);
        discover();
        break;
      }
      case "profile_announce":
        if (sender) await avatarService.handleProfileAnnounce(sender, peerId, msg);
        break;
      case "avatar_request":
        await avatarService.handleAvatarRequest(getSelf(), peerId);
        break;
      case "avatar_data":
        if (sender) await avatarService.handleAvatarData(sender, msg);
        break;
      case "file_chunk":
        await chatService.handleFileChunk(msg);
        break;
      case "chat_message": {
        const result = await chatService.handleChatMessage(self, msg, Date.now());
        if (!result) break;
        const stored = result.message;
        // Ack regardless of status — it's an idempotent delivery receipt.
        ackMessage(peerId, stored.roomId, stored.id);
        if (result.status === "updated") {
          // A live edit/tombstone of a message we already held — reflect it,
          // never notify, and recount unread (tombstones drop out).
          useChatStore.getState().applyMessageUpdate(stored);
          if (stored.deletedAt) void useRoomStore.getState().loadUnread();
          break;
        }
        if (result.status === "known") break;

        // status === "new"
        useChatStore.getState().ingestMessage(stored);
        const isActive = markUnreadIfInactive(stored.roomId);
        const mentioned = mentionsIdentity(stored.body, self.identityId);
        const muted = !!useRoomStore.getState().mutedByRoom[stored.roomId];
        // A muted room stays silent — no notification, sound, or badge —
        // unless the message @-mentions you, which always pierces mute.
        if (!muted || mentioned) {
          const author = useRosterStore.getState().contactsById[stored.authorId];
          const authorName = author?.displayName ?? "Someone";
          const previews = useSettingsStore.getState().notificationPreviews;
          const title = mentioned ? `${authorName} mentioned you` : authorName;
          const body = previews
            ? messageNotificationBody(stored)
            : mentioned
              ? "Mentioned you"
              : "New message";
          // Chime when the message lands outside the viewed room OR whenever
          // an OS notification fired (the banner itself is silent) — otherwise
          // an unfocused window with the room open notifies without a sound.
          void notifyIfUnfocused(title, body).then((notified) => {
            if (!isActive || notified) playMessageSound();
          });
        }
        break;
      }
      case "reaction": {
        if (!sender) break;
        const reaction = await chatService.handleReaction(self.identityId, sender.identityId, msg);
        if (reaction) useChatStore.getState().ingestReaction(reaction, msg.op);
        break;
      }
      case "msg_edit": {
        if (!sender) break;
        const updated = await chatService.handleEdit(self, sender.identityId, msg);
        if (updated) useChatStore.getState().applyMessageUpdate(updated);
        break;
      }
      case "msg_delete": {
        if (!sender) break;
        const updated = await chatService.handleDelete(self, sender.identityId, msg);
        if (updated) {
          useChatStore.getState().applyMessageUpdate(updated);
          // A deleted message no longer counts as unread (the DB query excludes
          // tombstones); recompute so the sidebar/badge drop it.
          void useRoomStore.getState().loadUnread();
        }
        break;
      }
      case "msg_ack":
        await messageRepo.setDeliveryStatus(msg.messageId, "delivered");
        useChatStore.getState().updateMessageStatus(msg.roomId, msg.messageId, "delivered");
        break;
      case "read_receipt": {
        if (!sender) break;
        const changed = await chatService.handleReadReceipt(
          self.identityId,
          sender.identityId,
          msg,
        );
        if (changed) await useChatStore.getState().refreshRoom(msg.roomId);
        break;
      }
      case "typing":
        // Attribute to the authenticated peer, not the spoofable wire fromId.
        if (sender) useTypingStore.getState().setTyping(msg.roomId, sender.identityId, msg.typing);
        break;
      case "room_sync_request": {
        // The requester's have-vector doubles as a receipt: anything of ours
        // at or below their seq is already on their device.
        if (!sender) break;
        const flipped = await chatService.handleRoomSyncRequest(
          self.identityId,
          peerId,
          sender.identityId,
          msg,
        );
        if (flipped) await useChatStore.getState().refreshRoom(msg.roomId);
        break;
      }
      case "room_sync_response": {
        if (!sender) break;
        const { created, updated } = await chatService.handleRoomSyncResponse(
          self,
          sender.identityId,
          msg,
          Date.now(),
        );
        // Single merge + one room-list refresh for the whole backfill.
        useChatStore.getState().ingestMessages(created);
        // Edits/tombstones that arrived for messages we already held.
        for (const m of updated) useChatStore.getState().applyMessageUpdate(m);
        await useChatStore.getState().refreshReactions(msg.roomId);
        const backfillByRoom = new Map<string, number>();
        for (const m of created) {
          // Ack the author directly (best effort) — the relaying peer isn't
          // necessarily who wrote the message.
          ackMessage(derivePeerId(m.authorId), m.roomId, m.id);
          // Tombstones backfilled as new rows shouldn't inflate unread.
          if (m.deletedAt) continue;
          backfillByRoom.set(m.roomId, (backfillByRoom.get(m.roomId) ?? 0) + 1);
        }
        // Backfilled messages count as unread but don't fire a notification.
        for (const [roomId, count] of backfillByRoom) markUnreadIfInactive(roomId, count);
        // A backfilled tombstone can drop a previously-counted unread.
        if (updated.some((m) => m.deletedAt)) void useRoomStore.getState().loadUnread();
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
      case "call_media_state":
        callService.handleCallMediaState(self, msg);
        break;
      case "room_call_media_state":
        roomCallService.handleRoomCallMediaState(self, msg);
        break;
      case "call_screen_watch":
        callService.handleCallScreenWatch(self, msg);
        break;
      case "room_screen_watch":
        roomCallService.handleRoomScreenWatch(self, msg);
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
        // A member can only tombstone itself: the leave must come from the peer
        // it names, else any contact could evict anyone from a shared room.
        if (derivePeerId(msg.fromId) === peerId) {
          await roomService.handleRoomLeave(self, msg);
          await useRoomStore.getState().loadRooms();
        }
        break;
      case "room_call_beacon": {
        const tracker = getRoomCallPresenceTracker();
        // A room going idle → active is the "call started" moment. Beacons
        // repeat for the whole call, so only this transition notifies — and
        // not when we're the ones in it (our own beacons don't route here,
        // but peers' beacons about our call do).
        const wasActive = tracker.activeParticipants(msg.roomId).length > 0;
        tracker.applyBeacon(msg);
        const nowActive = tracker.activeParticipants(msg.roomId).length > 0;
        if (!wasActive && nowActive && useRoomCallStore.getState().roomId !== msg.roomId) {
          const room = useRoomStore.getState().roomsById[msg.roomId];
          if (room) {
            const starter =
              useRosterStore.getState().contactsById[msg.fromId]?.displayName ?? "Someone";
            void notifyIfUnfocused(room.name ?? "Room call", `${starter} started a call`);
          }
        }
        roomCallService.handleRoomCallBeacon(self, msg);
        break;
      }
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
      case "watch_party_start":
        watchPartyService.handleStart(self, msg);
        break;
      case "watch_party_state":
        watchPartyService.handleState(self, msg);
        break;
      case "watch_party_handoff":
        watchPartyService.handleHandoff(self, msg);
        break;
      case "watch_party_subtitle":
        watchPartyService.handleSubtitle(self, msg);
        break;
      case "watch_party_member":
        watchPartyService.handleMember(self, msg);
        break;
      case "watch_party_ping":
        watchPartyService.handlePing(self, msg);
        break;
      case "watch_party_pong":
        watchPartyService.handlePong(self, msg);
        break;
      case "watch_party_end":
        watchPartyService.handleEnd(self, msg);
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
        // Refresh "last seen" at most once a minute while they stay online, so
        // an abrupt quit still leaves a recent timestamp.
        const persistedAt = lastSeenPersist.get(contact.identityId) ?? 0;
        if (Date.now() - persistedAt > 60_000) recordSeen(contact.identityId, peerId);
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
    window.removeEventListener("pagehide", onPageHide);
    registry.stop();
  };
}
