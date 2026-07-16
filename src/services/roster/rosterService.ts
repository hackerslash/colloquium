import type { Identity, RosterContact } from "../../types/domain";
import type {
  HavenMessage,
  InviteAckMessage,
  InviteConsumeMessage,
  InvitePayload,
  RosterEntryWire,
  RosterSyncMessage,
  SignedInvitePayload,
} from "../../types/wire";
import * as identityService from "../identity/identity";
import * as rosterRepo from "../db/rosterRepo";
import * as pendingInvitesRepo from "../db/pendingInvitesRepo";
import { getPeerRegistry } from "../peer/registry";
import { computeIdentityId } from "../../lib/crypto";
import { base64ToUtf8, utf8ToBase64 } from "../../lib/base64";

const INVITE_PREFIX = "haven-invite:";
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const ACK_TIMEOUT_MS = 15_000;

// Fixed field order, not object-key order, so sender and verifier always
// hash/sign the exact same bytes regardless of how each side's code happens
// to construct the object literal.
function canonicalInvitePayload(p: InvitePayload): string {
  return JSON.stringify([
    p.v,
    p.inviterId,
    p.inviterPubKey,
    p.inviterPeerId,
    p.inviteToken,
    p.createdAt,
    p.expiresAt,
  ]);
}

function canonicalInviteConsume(m: Omit<InviteConsumeMessage, "sig">): string {
  return JSON.stringify([
    m.type,
    m.inviteToken,
    m.inviteeId,
    m.inviteePubKey,
    m.inviteeDisplayName,
    m.ts,
  ]);
}

function canonicalInviteAck(m: Omit<InviteAckMessage, "sig">): string {
  return JSON.stringify([m.type, m.inviteToken, m.accepted, m.reason ?? null, m.roster]);
}

async function signCanonical(message: string): Promise<string> {
  return identityService.sign(utf8ToBase64(message));
}

async function verifyCanonical(
  publicKeyBase64: string,
  message: string,
  sig: string,
): Promise<boolean> {
  return identityService.verify(publicKeyBase64, utf8ToBase64(message), sig);
}

function toWire(c: RosterContact): RosterEntryWire {
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

export async function createInvite(self: Identity): Promise<string> {
  const registry = getPeerRegistry();
  const token = crypto.randomUUID();
  const createdAt = Date.now();

  const payload: InvitePayload = {
    v: 1,
    inviterId: self.identityId,
    inviterPubKey: self.publicKey,
    inviterPeerId: registry.id,
    inviteToken: token,
    createdAt,
    expiresAt: createdAt + INVITE_TTL_MS,
  };
  const sig = await signCanonical(canonicalInvitePayload(payload));
  const signed: SignedInvitePayload = { ...payload, sig };

  await pendingInvitesRepo.createPendingInvite(token, createdAt, payload.expiresAt);
  return INVITE_PREFIX + utf8ToBase64(JSON.stringify(signed));
}

type PendingAccept = {
  inviterPubKey: string;
  resolve: () => void;
  reject: (err: unknown) => void;
};

const pendingAccepts = new Map<string, PendingAccept>();

export async function acceptInvite(self: Identity, inviteString: string): Promise<void> {
  const trimmed = inviteString.trim();
  if (!trimmed.startsWith(INVITE_PREFIX)) {
    throw new Error("That doesn't look like a Haven invite.");
  }

  const signed = JSON.parse(base64ToUtf8(trimmed.slice(INVITE_PREFIX.length))) as SignedInvitePayload;
  const { sig, ...payload } = signed;

  if (payload.v !== 1) throw new Error("This invite was made by an incompatible version of Haven.");
  if (Date.now() > payload.expiresAt) throw new Error("This invite has expired.");
  if (payload.inviterId === self.identityId) throw new Error("You can't accept your own invite.");

  const sigValid = await verifyCanonical(payload.inviterPubKey, canonicalInvitePayload(payload), sig);
  if (!sigValid) throw new Error("This invite's signature doesn't check out.");

  const derivedInviterId = await computeIdentityId(payload.inviterPubKey);
  if (derivedInviterId !== payload.inviterId) {
    throw new Error("This invite's identity doesn't match its key.");
  }

  const registry = getPeerRegistry();
  await registry.connect(payload.inviterPeerId);

  const consumeBase = {
    type: "invite_consume" as const,
    inviteToken: payload.inviteToken,
    inviteeId: self.identityId,
    inviteePubKey: self.publicKey,
    inviteeDisplayName: self.displayName,
    ts: Date.now(),
  };
  const consumeSig = await signCanonical(canonicalInviteConsume(consumeBase));
  const consumeMsg: InviteConsumeMessage = { ...consumeBase, sig: consumeSig };

  const ackPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingAccepts.delete(payload.inviteToken);
      reject(new Error("Timed out waiting for the inviter to respond."));
    }, ACK_TIMEOUT_MS);
    pendingAccepts.set(payload.inviteToken, {
      inviterPubKey: payload.inviterPubKey,
      resolve: () => {
        clearTimeout(timeout);
        resolve();
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });
  });

  registry.send(payload.inviterPeerId, consumeMsg);
  await ackPromise;
}

async function sendAck(
  self: Identity,
  toPeerId: string,
  inviteToken: string,
  accepted: boolean,
  reason?: string,
  roster: RosterEntryWire[] = [],
): Promise<void> {
  const base = { type: "invite_ack" as const, inviteToken, accepted, reason, roster };
  const sig = await signCanonical(canonicalInviteAck(base));
  const ack: InviteAckMessage = { ...base, sig };
  getPeerRegistry().send(toPeerId, ack);
  void self; // reserved for future auditing/logging of who we acked
}

async function handleInviteConsume(
  self: Identity,
  fromPeerId: string,
  msg: InviteConsumeMessage,
): Promise<void> {
  const pending = await pendingInvitesRepo.getPendingInvite(msg.inviteToken);
  if (!pending) return sendAck(self, fromPeerId, msg.inviteToken, false, "This invite is unknown.");
  if (pending.consumed_at) {
    return sendAck(self, fromPeerId, msg.inviteToken, false, "This invite was already used.");
  }
  if (Date.now() > pending.expires_at) {
    return sendAck(self, fromPeerId, msg.inviteToken, false, "This invite has expired.");
  }

  const sigValid = await verifyCanonical(
    msg.inviteePubKey,
    canonicalInviteConsume(msg),
    msg.sig,
  );
  if (!sigValid) {
    return sendAck(self, fromPeerId, msg.inviteToken, false, "Signature check failed.");
  }

  const derivedInviteeId = await computeIdentityId(msg.inviteePubKey);
  if (derivedInviteeId !== msg.inviteeId) {
    return sendAck(self, fromPeerId, msg.inviteToken, false, "Identity/key mismatch.");
  }

  const now = Date.now();
  await pendingInvitesRepo.markConsumed(msg.inviteToken, msg.inviteeId, now);

  await rosterRepo.upsertLww({
    identityId: msg.inviteeId,
    publicKey: msg.inviteePubKey,
    displayName: msg.inviteeDisplayName,
    addedBy: self.identityId,
    addedAt: now,
    updatedAt: now,
    revoked: false,
    revokedAt: null,
    revokedBy: null,
  });

  const existing = await rosterRepo.listContacts();
  const roster = [buildSelfEntry(self), ...existing.map(toWire)];
  await sendAck(self, fromPeerId, msg.inviteToken, true, undefined, roster);
}

async function handleInviteAck(msg: InviteAckMessage): Promise<void> {
  const pending = pendingAccepts.get(msg.inviteToken);
  if (!pending) return;

  const sigValid = await verifyCanonical(
    pending.inviterPubKey,
    canonicalInviteAck(msg),
    msg.sig,
  );
  pendingAccepts.delete(msg.inviteToken);

  if (!sigValid) {
    pending.reject(new Error("The inviter's response signature doesn't check out."));
    return;
  }
  if (!msg.accepted) {
    pending.reject(new Error(msg.reason ?? "The invite was rejected."));
    return;
  }

  for (const entry of msg.roster) {
    const derivedId = await computeIdentityId(entry.publicKey);
    if (derivedId !== entry.identityId) continue;
    await rosterRepo.upsertLww(entry);
  }

  pending.resolve();
}

async function handleRosterSync(msg: RosterSyncMessage): Promise<void> {
  for (const entry of msg.entries) {
    const derivedId = await computeIdentityId(entry.publicKey);
    if (derivedId !== entry.identityId) continue;
    await rosterRepo.upsertLww(entry);
  }
}

export async function sendRosterSync(self: Identity, toPeerId: string): Promise<void> {
  const contacts = await rosterRepo.listContacts();
  const entries = [buildSelfEntry(self), ...contacts.map(toWire)];
  const message: RosterSyncMessage = { type: "roster_sync", entries };
  getPeerRegistry().send(toPeerId, message);
}

export async function handleIncomingMessage(
  self: Identity,
  fromPeerId: string,
  data: unknown,
): Promise<void> {
  const msg = data as HavenMessage;
  switch (msg?.type) {
    case "invite_consume":
      await handleInviteConsume(self, fromPeerId, msg);
      break;
    case "invite_ack":
      await handleInviteAck(msg);
      break;
    case "roster_sync":
      await handleRosterSync(msg);
      break;
  }
}
