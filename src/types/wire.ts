// Wire formats exchanged between trusted peers. Kept separate from
// types/domain.ts (local persisted shapes) since these cross the network
// and are versioned/signed independently of how we store things locally.

export type InvitePayload = {
  v: 1;
  inviterId: string;
  inviterPubKey: string;
  inviterPeerId: string;
  inviteToken: string;
  createdAt: number;
  expiresAt: number;
};

export type SignedInvitePayload = InvitePayload & { sig: string };

export type RosterEntryWire = {
  identityId: string;
  publicKey: string;
  displayName: string;
  addedBy: string;
  addedAt: number;
  updatedAt: number;
  revoked: boolean;
  revokedAt: number | null;
  revokedBy: string | null;
};

export type InviteConsumeMessage = {
  type: "invite_consume";
  inviteToken: string;
  inviteeId: string;
  inviteePubKey: string;
  inviteeDisplayName: string;
  ts: number;
  sig: string;
};

export type InviteAckMessage = {
  type: "invite_ack";
  inviteToken: string;
  accepted: boolean;
  reason?: string;
  roster: RosterEntryWire[];
  sig: string;
};

export type RosterSyncMessage = {
  type: "roster_sync";
  entries: RosterEntryWire[];
};

export type HavenMessage =
  | InviteConsumeMessage
  | InviteAckMessage
  | RosterSyncMessage;
