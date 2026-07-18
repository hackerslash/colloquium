import type { Identity } from "../../types/domain";
import type { RoomAnnounceMessage, RoomLeaveMessage } from "../../types/wire";
import * as roomRepo from "../db/roomRepo";
import * as roomMembersRepo from "../db/roomMembersRepo";
import * as rosterRepo from "../db/rosterRepo";
import { getOutbox, getPeerRegistry } from "../peer/registry";
import { derivePeerId } from "../peer/derivePeerId";

/** Announces/leaves queue in the Outbox for offline members; a day is plenty
 * since reconnect-time re-announces and periodic gossip also converge. */
const ANNOUNCE_TTL_MS = 24 * 60 * 60 * 1_000;

/** Group room id: random uuid (unlike DM rooms, membership is explicit and
 * not derivable from a pair of identities). */
export async function createGroupRoom(
  self: Identity,
  name: string,
  memberIds: string[],
): Promise<string> {
  const now = Date.now();
  const roomId = `grp_${crypto.randomUUID().replace(/-/g, "")}`;

  await roomRepo.upsertGroupRoom({
    id: roomId,
    name,
    topic: null,
    createdBy: self.identityId,
    createdAt: now,
  });
  await roomMembersRepo.addMember(roomId, self.identityId, "owner", now, self.displayName);
  for (const m of memberIds) {
    const contact = await rosterRepo.getContact(m);
    await roomMembersRepo.addMember(roomId, m, "member", now, contact?.displayName ?? null);
  }

  await announceRoom(self, roomId);
  return roomId;
}

export async function renameGroupRoom(
  self: Identity,
  roomId: string,
  name: string,
): Promise<void> {
  await roomRepo.updateRoomName(roomId, name);
  await announceRoom(self, roomId);
}

export async function addMembersToGroupRoom(
  self: Identity,
  roomId: string,
  memberIds: string[],
): Promise<void> {
  const now = Date.now();
  for (const m of memberIds) {
    const contact = await rosterRepo.getContact(m);
    await roomMembersRepo.addMember(roomId, m, "member", now, contact?.displayName ?? null);
  }
  await announceRoom(self, roomId);
}

async function buildAnnounce(
  self: Identity,
  roomId: string,
): Promise<{ message: RoomAnnounceMessage; activeMemberIds: string[] } | null> {
  const room = await roomRepo.getRoom(roomId);
  if (!room || room.type !== "group") return null;

  const members = await roomMembersRepo.listMembersFull(roomId);
  // Refresh display names from the roster where we know better; cached names
  // from earlier announces cover members we haven't met via roster gossip.
  for (const member of members) {
    if (member.id === self.identityId) {
      member.displayName = self.displayName;
    } else {
      const contact = await rosterRepo.getContact(member.id);
      if (contact) member.displayName = contact.displayName;
    }
  }

  return {
    activeMemberIds: members.filter((m) => m.leftAt === null).map((m) => m.id),
    message: {
      type: "room_announce",
      room: {
        id: room.id,
        name: room.name,
        topic: room.topic,
        createdBy: room.createdBy ?? self.identityId,
        createdAt: room.createdAt,
      },
      members,
    },
  };
}

/** Broadcasts room metadata + full membership (tombstones included) to every
 * active member. Offline members get it from the Outbox on reconnect. */
export async function announceRoom(self: Identity, roomId: string): Promise<void> {
  const built = await buildAnnounce(self, roomId);
  if (!built) return;
  const outbox = getOutbox();
  for (const memberId of built.activeMemberIds) {
    if (memberId === self.identityId) continue;
    outbox.send(derivePeerId(memberId), built.message, ANNOUNCE_TTL_MS);
  }
}

/** Sends announcements for every group room we share with a specific peer —
 * used on (re)connect so rooms created while they were offline still arrive. */
export async function announceRoomsToPeer(
  self: Identity,
  contactId: string,
  peerId: string,
): Promise<void> {
  const roomIds = await roomMembersRepo.sharedGroupRoomIds(contactId);
  const registry = getPeerRegistry();
  for (const roomId of roomIds) {
    const built = await buildAnnounce(self, roomId);
    if (built) registry.send(peerId, built.message);
  }
}

/** Slow gossip pass: re-announce every group room we're active in to its
 * members. LWW merging makes repeats free, and it converges member sets that
 * diverged while someone was offline past the Outbox TTL. */
export async function reannounceAllGroupRooms(self: Identity): Promise<void> {
  const rooms = await roomRepo.listRooms(self.identityId);
  for (const room of rooms) {
    if (room.type !== "group") continue;
    await announceRoom(self, room.id);
  }
}

export async function handleRoomAnnounce(self: Identity, msg: RoomAnnounceMessage): Promise<void> {
  // Only materialize rooms we're actually listed in (active or tombstoned —
  // a tombstone for us must be recorded so the room stays hidden).
  const selfEntry = msg.members.find((m) => m.id === self.identityId);
  if (!selfEntry) return;

  await roomRepo.upsertGroupRoom(msg.room);
  for (const member of msg.members) {
    await roomMembersRepo.mergeMember(msg.room.id, member);
  }
}

/** Leaves a group room: tombstones our own membership, tells active members
 * directly, and re-announces so peers that miss the leave still converge. */
export async function leaveRoom(self: Identity, roomId: string): Promise<void> {
  const now = Date.now();
  const activeMembers = await roomMembersRepo.listMembers(roomId);
  await roomMembersRepo.applyLeave(roomId, self.identityId, now);

  const message: RoomLeaveMessage = {
    type: "room_leave",
    roomId,
    fromId: self.identityId,
    ts: now,
  };
  const outbox = getOutbox();
  for (const memberId of activeMembers) {
    if (memberId === self.identityId) continue;
    outbox.send(derivePeerId(memberId), message, ANNOUNCE_TTL_MS);
  }
  await announceRoom(self, roomId);
}

export async function handleRoomLeave(_self: Identity, msg: RoomLeaveMessage): Promise<void> {
  await roomMembersRepo.applyLeave(msg.roomId, msg.fromId, msg.ts);
}
