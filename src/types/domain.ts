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

// "unreachable" = registered on the broker (so, online) but no direct
// connection could open — a NAT/firewall/VPN issue, not the contact being away.
export type Presence = "online" | "offline" | "connecting" | "unreachable";

export type Room = {
  id: string;
  type: "dm" | "group";
  name: string | null;
  topic: string | null;
  createdBy: string | null;
  createdAt: number;
  isArchived: boolean;
  lastMessageAt: number | null;
};

export type DeliveryStatus = "pending" | "sent" | "delivered" | "failed";

export type Reaction = {
  messageId: string;
  roomId: string;
  authorId: string;
  emoji: string;
  reactedAt: number;
};

export type Message = {
  id: string;
  roomId: string;
  authorId: string;
  authorSeq: number;
  hlc: string;
  contentType: "text" | "image" | "file" | "audio" | "system";
  body: string | null;
  attachmentId?: string;
  attachmentName?: string;
  attachmentSize?: number;
  attachmentType?: string;
  /** Voice-memo duration in milliseconds — set when contentType === "audio". */
  voiceDurationMs?: number;
  /** Normalized waveform peaks 0..1 for the voice bubble. ~40 floats. */
  voiceWaveform?: number[];
  replyToId: string | null;
  sentAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  sig: string;
  deliveryStatus: DeliveryStatus;
  /** When a peer's read receipt confirmed this (own-authored) message was
   * seen. Local-only state — never crosses the wire inside the message. */
  readAt: number | null;
};
