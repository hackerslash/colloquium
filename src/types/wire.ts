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

export type ChatMessageWire = {
  id: string;
  roomId: string;
  authorId: string;
  authorSeq: number;
  hlc: string;
  contentType: "text" | "image" | "file" | "system";
  body: string | null;
  replyToId: string | null;
  sentAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  sig: string;
};

export type ChatMessageMessage = {
  type: "chat_message";
  message: ChatMessageWire;
};

/** DM rooms have deterministic IDs derived from the two member identityIds
 * (see roomService.dmRoomId), so both sides independently agree on the room a
 * message belongs to without exchanging room metadata. This carries the
 * highest author_seq the requester already has per author, so the responder
 * sends only the gap. */
export type RoomSyncRequestMessage = {
  type: "room_sync_request";
  roomId: string;
  have: Record<string, number>;
};

export type RoomSyncResponseMessage = {
  type: "room_sync_response";
  roomId: string;
  messages: ChatMessageWire[];
};

// --- Call control (a layer above raw negotiation) ---

export type CallInviteMessage = {
  type: "call_invite";
  roomId: string;
  fromId: string;
};

export type CallAcceptMessage = {
  type: "call_accept";
  roomId: string;
  fromId: string;
};

export type CallDeclineMessage = {
  type: "call_decline";
  roomId: string;
  fromId: string;
};

export type CallHangupMessage = {
  type: "call_hangup";
  roomId: string;
  fromId: string;
};

// --- Perfect-negotiation signaling (SDP + ICE), relayed over the PeerJS
// data connection. `sdp` carries an RTCSessionDescriptionInit (offer/answer). ---

export type RtcDescriptionMessage = {
  type: "rtc_description";
  fromId: string;
  description: RTCSessionDescriptionInit;
};

export type RtcCandidateMessage = {
  type: "rtc_candidate";
  fromId: string;
  candidate: RTCIceCandidateInit;
};

export type HavenMessage =
  | InviteConsumeMessage
  | InviteAckMessage
  | RosterSyncMessage
  | ChatMessageMessage
  | RoomSyncRequestMessage
  | RoomSyncResponseMessage
  | CallInviteMessage
  | CallAcceptMessage
  | CallDeclineMessage
  | CallHangupMessage
  | RtcDescriptionMessage
  | RtcCandidateMessage;
