import type { Identity } from "../../types/domain";
import type { FriendRequestMessage, FriendRequestResponseMessage, RosterEntryWire } from "../../types/wire";
import * as identityService from "../identity/identity";
import * as friendRequestsRepo from "../db/friendRequestsRepo";
import * as rosterRepo from "../db/rosterRepo";
import { getPeerRegistry } from "../peer/registry";
import { derivePeerId } from "../peer/derivePeerId";
import { computeIdentityId } from "../../lib/crypto";
import { utf8ToBase64 } from "../../lib/base64";
import { notifyIfUnfocused } from "../notify";
import { useFriendRequestStore } from "../../stores/useFriendRequestStore";

function canonicalFriendRequest(m: Omit<FriendRequestMessage, "sig">): string {
  return JSON.stringify([m.type, m.fromId, m.fromPubKey, m.fromDisplayName, m.ts]);
}

function canonicalFriendRequestResponse(m: Omit<FriendRequestResponseMessage, "sig">): string {
  return JSON.stringify([m.type, m.fromId, m.fromPubKey, m.fromDisplayName, m.accepted, JSON.stringify(m.roster)]);
}

async function signCanonical(message: string): Promise<string> {
  return identityService.sign(utf8ToBase64(message));
}

async function verifyCanonical(publicKeyBase64: string, message: string, sig: string): Promise<boolean> {
  return identityService.verify(publicKeyBase64, utf8ToBase64(message), sig);
}

function buildSelfEntry(self: Identity): RosterEntryWire {
  return {
    identityId: self.identityId,
    publicKey: self.publicKey,
    displayName: self.displayName,
    addedBy: self.identityId,
    addedAt: self.createdAt,
    updatedAt: Date.now(),
    revoked: false,
    revokedAt: null,
    revokedBy: null,
  };
}

function toWire(c: any): RosterEntryWire {
  return {
    identityId: c.identityId,
    publicKey: c.publicKey,
    displayName: c.displayName,
    addedBy: c.addedBy,
    addedAt: c.addedAt,
    updatedAt: c.updatedAt,
    revoked: c.revoked,
    revokedAt: c.revokedAt,
    revokedBy: c.revokedBy,
  };
}

export async function sendFriendRequest(self: Identity, targetIdentityId: string): Promise<void> {
  const ts = Date.now();
  const base = {
    type: "friend_request" as const,
    fromId: self.identityId,
    fromPubKey: self.publicKey,
    fromDisplayName: self.displayName,
    ts,
  };
  const sig = await signCanonical(canonicalFriendRequest(base));
  const msg: FriendRequestMessage = { ...base, sig };

  const registry = getPeerRegistry();
  const peerId = derivePeerId(targetIdentityId);
  try {
    await registry.connect(peerId);
    registry.send(peerId, msg);
    await friendRequestsRepo.upsert({
      id: crypto.randomUUID(),
      fromId: targetIdentityId,
      fromPubKey: "", // Target's pubkey we might not know yet
      displayName: "Unknown", // They haven't responded yet
      direction: "outgoing",
      status: "pending",
      createdAt: ts,
    });
  } catch (err) {
    throw new Error("Failed to connect to the peer. They might be offline.");
  }
}

async function mergeRosterEntries(self: Identity, entries: RosterEntryWire[]): Promise<void> {
  for (const entry of entries) {
    if (entry.identityId === self.identityId) continue;
    const derivedId = await computeIdentityId(entry.publicKey);
    if (derivedId !== entry.identityId) continue;
    await rosterRepo.upsertLww(entry);
  }
}

async function broadcastRosterSync(self: Identity): Promise<void> {
  const contacts = await rosterRepo.listContacts();
  const entries = [buildSelfEntry(self), ...contacts.map(toWire)];
  const message = { type: "roster_sync", entries };
  const registry = getPeerRegistry();
  for (const contact of contacts) {
    if (!contact.revoked) registry.send(derivePeerId(contact.identityId), message);
  }
}

export async function handleFriendRequest(self: Identity, msg: FriendRequestMessage): Promise<void> {
  void self;
  const sigValid = await verifyCanonical(msg.fromPubKey, canonicalFriendRequest(msg), msg.sig);
  if (!sigValid) return;

  const derivedId = await computeIdentityId(msg.fromPubKey);
  if (derivedId !== msg.fromId) return;

  const contact = await rosterRepo.getContact(msg.fromId);
  if (contact && !contact.revoked) return;

  const existing = await friendRequestsRepo.findByFromId(msg.fromId);
  if (existing && existing.status === "pending" && existing.direction === "incoming") return;

  await friendRequestsRepo.upsert({
    id: crypto.randomUUID(),
    fromId: msg.fromId,
    fromPubKey: msg.fromPubKey,
    displayName: msg.fromDisplayName,
    direction: "incoming",
    status: "pending",
    createdAt: msg.ts,
  });

  // Reflect the new request in the Inbox / sidebar badge immediately, even if
  // the Inbox is already open when it arrives.
  await useFriendRequestStore.getState().refresh();

  notifyIfUnfocused(msg.fromDisplayName, "sent you a friend request");
}

export async function acceptFriendRequest(self: Identity, req: friendRequestsRepo.FriendRequest): Promise<void> {
  const now = Date.now();
  await rosterRepo.upsertLww({
    identityId: req.fromId,
    publicKey: req.fromPubKey,
    displayName: req.displayName,
    addedBy: self.identityId,
    addedAt: now,
    updatedAt: now,
    revoked: false,
    revokedAt: null,
    revokedBy: null,
  });

  const contacts = await rosterRepo.listContacts();
  const roster = [buildSelfEntry(self), ...contacts.map(toWire)];

  const base = {
    type: "friend_request_response" as const,
    fromId: self.identityId,
    fromPubKey: self.publicKey,
    fromDisplayName: self.displayName,
    accepted: true,
    roster,
  };
  const sig = await signCanonical(canonicalFriendRequestResponse(base));
  const msg: FriendRequestResponseMessage = { ...base, sig };

  getPeerRegistry().send(derivePeerId(req.fromId), msg);
  await friendRequestsRepo.setStatus(req.id, "accepted");
  await broadcastRosterSync(self);
}

export async function declineFriendRequest(self: Identity, req: friendRequestsRepo.FriendRequest): Promise<void> {
  const base = {
    type: "friend_request_response" as const,
    fromId: self.identityId,
    fromPubKey: self.publicKey,
    fromDisplayName: self.displayName,
    accepted: false,
    roster: [],
  };
  const sig = await signCanonical(canonicalFriendRequestResponse(base));
  const msg: FriendRequestResponseMessage = { ...base, sig };

  getPeerRegistry().send(derivePeerId(req.fromId), msg);
  await friendRequestsRepo.setStatus(req.id, "declined");
}

/** Handles a response to one of our outgoing requests. Returns the newly-added
 * contact id when the peer accepted (so the caller can reflect it in the local
 * UI without waiting for the peer's roster_sync echo), or null otherwise. */
export async function handleFriendRequestResponse(
  self: Identity,
  msg: FriendRequestResponseMessage,
): Promise<string | null> {
  const sigValid = await verifyCanonical(msg.fromPubKey, canonicalFriendRequestResponse(msg), msg.sig);
  if (!sigValid) return null;

  const derivedId = await computeIdentityId(msg.fromPubKey);
  if (derivedId !== msg.fromId) return null;

  const existing = await friendRequestsRepo.findByFromId(msg.fromId);
  if (!existing || existing.direction !== "outgoing") return null;

  if (msg.accepted) {
    const now = Date.now();
    await rosterRepo.upsertLww({
      identityId: msg.fromId,
      publicKey: msg.fromPubKey,
      displayName: msg.fromDisplayName,
      addedBy: self.identityId,
      addedAt: now,
      updatedAt: now,
      revoked: false,
      revokedAt: null,
      revokedBy: null,
    });
    await mergeRosterEntries(self, msg.roster);
    await friendRequestsRepo.setStatus(existing.id, "accepted");
    await broadcastRosterSync(self);
    return msg.fromId;
  } else {
    await friendRequestsRepo.setStatus(existing.id, "declined");
    return null;
  }
}
