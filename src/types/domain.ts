export type Identity = {
  identityId: string;
  publicKey: string;
  displayName: string;
  avatarPath: string | null;
  statusMessage: string | null;
  createdAt: number;
};

export type RosterContact = {
  identityId: string;
  publicKey: string;
  displayName: string;
  avatarPath: string | null;
  addedBy: string;
  addedAt: number;
  lastSeenAt: number | null;
  lastKnownPeerId: string | null;
  updatedAt: number;
  revoked: boolean;
  revokedAt: number | null;
  revokedBy: string | null;
};

export type Presence = "online" | "offline" | "connecting";
