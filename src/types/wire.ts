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
  attachmentId?: string;
  attachmentName?: string;
  attachmentSize?: number;
  attachmentType?: string;
};

export type ChatMessageMessage = {
  type: "chat_message";
  message: ChatMessageWire;
};

/** Emoji reaction toggle on a message. Attributed to the authenticated peer
 * connection (like typing), never a wire-carried sender id. */
export type ReactionMessage = {
  type: "reaction";
  roomId: string;
  messageId: string;
  emoji: string;
  op: "add" | "remove";
  reactedAt: number;
};

/** A reaction carried in a room sync response. The author is implicitly the
 * responding peer — each peer only ever syncs its OWN reactions, so a relayer
 * can't forge someone else's. */
export type ReactionWire = {
  messageId: string;
  emoji: string;
  reactedAt: number;
};

// --- Transport-level liveness. Consumed inside PeerRegistry (never routed to
// the app-level message switch): any traffic bumps a per-peer lastSeenAt, and
// a peer silent past the liveness timeout is closed and marked offline. ---

/** Ephemeral typing signal — never persisted, acked, or synced. `typing`
 * flips true on keystrokes (throttled) and false on send / idle timeout. */
export type TypingMessage = {
  type: "typing";
  roomId: string;
  fromId: string;
  typing: boolean;
};

export type PingMessage = { type: "ping"; ts: number };
export type PongMessage = { type: "pong"; ts: number };

/** Receipt sent to a chat message's author once the message is verified and
 * stored (live delivery or sync backfill). Flips the author's local
 * deliveryStatus to "delivered". */
export type MsgAckMessage = {
  type: "msg_ack";
  roomId: string;
  messageId: string;
};

/** Sent to a room's message authors when the local user actually views the
 * room (read cursor advances). `upTo` is the highest author_seq per author
 * covered by the reader's cursor; each author flips their own messages at or
 * below their seq to "read". Attributed to the authenticated peer. */
export type ReadReceiptMessage = {
  type: "read_receipt";
  roomId: string;
  upTo: Record<string, number>;
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
  /** The requester's read cursor as a per-author seq vector — doubles as a
   * read receipt for messages read while their authors were offline. */
  read?: Record<string, number>;
};

export type RoomSyncResponseMessage = {
  type: "room_sync_response";
  roomId: string;
  messages: ChatMessageWire[];
  /** The responder's own current reactions in this room — a full replacement
   * set, so removals made while the requester was offline converge too.
   * Absent (older peer) means "no information", not "no reactions". */
  reactions?: ReactionWire[];
};

// --- Call control (a layer above raw negotiation). inviteId ties the whole
// ring handshake together so a late ack from an abandoned attempt can't
// confuse a newer one. ---

export type CallInviteMessage = {
  type: "call_invite";
  roomId: string;
  fromId: string;
  inviteId: string;
  /** Whether the caller wants this to start as a video call — the callee
   * only opens the camera when true. */
  withVideo: boolean;
};

/** Callee received the invite and is showing the ring UI. Until this arrives
 * the caller shows "reaching…" rather than a false "ringing". */
export type CallRingingMessage = {
  type: "call_ringing";
  roomId: string;
  fromId: string;
  inviteId: string;
};

export type CallAcceptMessage = {
  type: "call_accept";
  roomId: string;
  fromId: string;
  inviteId?: string;
};

export type CallDeclineMessage = {
  type: "call_decline";
  roomId: string;
  fromId: string;
  inviteId?: string;
  reason?: "busy" | "timeout" | "declined";
};

export type CallHangupMessage = {
  type: "call_hangup";
  roomId: string;
  fromId: string;
  reason?: "hangup" | "timeout";
};

/** Explicit camera/screen on-off state. WebKit receivers don't reliably fire
 * `mute` on a remote track when the sender replaceTrack(null)s it, so without
 * this the far side keeps rendering the frozen last frame. */
export type CallMediaStateMessage = {
  type: "call_media_state";
  roomId: string;
  fromId: string;
  camOn: boolean;
  screenOn: boolean;
};

export type RoomCallMediaStateMessage = {
  type: "room_call_media_state";
  roomId: string;
  fromId: string;
  camOn: boolean;
};

/** Discord-style opt-in screen viewing: a share is announced (slot claim /
 * call_media_state) but video flows only to peers who asked to watch. Saves
 * uplink for uninterested viewers and makes every attach a fresh, deliberate
 * negotiation (re-watching doubles as a black-tile retry). */
export type CallScreenWatchMessage = {
  type: "call_screen_watch";
  roomId: string;
  fromId: string;
  watching: boolean;
};

export type RoomScreenWatchMessage = {
  type: "room_screen_watch";
  roomId: string;
  fromId: string;
  /** Whose share this refers to. */
  presenterId: string;
  watching: boolean;
};

// --- Perfect-negotiation signaling (SDP + ICE), relayed over the PeerJS
// data connection. `channel` says which session the message belongs to so a
// 1:1 ring call and a group room mesh never cross-talk: "dm" routes to the
// 1:1 callService, a roomId string routes to that room's mesh session. ---

export type SignalChannel = "dm" | string;

export type RtcDescriptionMessage = {
  type: "rtc_description";
  channel: SignalChannel;
  fromId: string;
  description: RTCSessionDescriptionInit;
};

export type RtcCandidateMessage = {
  type: "rtc_candidate";
  channel: SignalChannel;
  fromId: string;
  candidate: RTCIceCandidateInit;
};

// --- Group room calls: join/leave a room's mesh session, plus the 2-slot
// presenter coordination (epoch + absolute-time lease, no central arbiter). ---

export type RoomCallJoinMessage = {
  type: "room_call_join";
  roomId: string;
  fromId: string;
};

export type RoomCallLeaveMessage = {
  type: "room_call_leave";
  roomId: string;
  fromId: string;
};

/** Reply to a join, telling the newcomer who is already present (and current
 * slot state) so they can build the right mesh links immediately. */
export type RoomCallPresenceMessage = {
  type: "room_call_presence";
  roomId: string;
  fromId: string;
  participants: string[];
  slots: PresenterSlotWire[];
};

/** Slots coordinate SCREEN shares only (cameras are full-mesh and slot-free).
 * streamId is the sharer's screen MediaStream id — msid survives SDP, so
 * receivers use it to tell screen tracks apart from camera tracks. */
export type PresenterSlotWire = {
  slotIndex: 0 | 1;
  holderId: string | null;
  epoch: number;
  leaseExpiresAt: number;
  mediaKind: "camera" | "screen" | null;
  streamId: string | null;
};

export type SlotClaimMessage = {
  type: "slot_claim";
  roomId: string;
  slotIndex: 0 | 1;
  claimantId: string;
  epoch: number;
  leaseExpiresAt: number;
  mediaKind: "camera" | "screen";
  streamId: string | null;
};

export type SlotHeartbeatMessage = {
  type: "slot_heartbeat";
  roomId: string;
  slotIndex: 0 | 1;
  holderId: string;
  epoch: number;
  leaseExpiresAt: number;
  mediaKind: "camera" | "screen";
  streamId: string | null;
};

export type SlotReleaseMessage = {
  type: "slot_release";
  roomId: string;
  slotIndex: 0 | 1;
  holderId: string;
  epoch: number;
};

// --- Group room membership announcement (v2: LWW + tombstones) ---

/** Membership entry with a tombstone (leftAt) and an LWW clock (updatedAt) so
 * merges are order-independent and a leave can't be resurrected by a stale
 * re-announce. displayName is embedded so receivers can materialize members
 * they haven't learned through roster gossip yet. */
export type RoomMemberWire = {
  id: string;
  displayName: string | null;
  role: "owner" | "member";
  joinedAt: number;
  leftAt: number | null;
  updatedAt: number;
};

export type RoomAnnounceMessage = {
  type: "room_announce";
  room: {
    id: string;
    name: string | null;
    topic: string | null;
    createdBy: string;
    createdAt: number;
  };
  members: RoomMemberWire[];
};

export type RoomLeaveMessage = {
  type: "room_leave";
  roomId: string;
  fromId: string;
  ts: number;
};

/** Room-call occupancy beacon, broadcast to ALL room members (not just call
 * participants) so a room can show as active to people who haven't joined.
 * Same absolute-expiry lease model as presenter slots: entries expire on
 * their own if the sender vanishes, and `leaving` removes immediately. */
export type RoomCallBeaconMessage = {
  type: "room_call_beacon";
  roomId: string;
  fromId: string;
  participants: string[];
  leaseExpiresAt: number;
  leaving: boolean;
};



export type FileChunkMessage = {
  type: "file_chunk";
  fileId: string;
  fileName: string;
  mimeType: string;
  chunkIndex: number;
  totalChunks: number;
  data: string;
};

/** Sent to a trusted peer on connect and after a local avatar change, so they
 * can tell whether the copy they hold is current without transferring bytes. */
export type ProfileAnnounceMessage = {
  type: "profile_announce";
  avatarHash: string | null;
  updatedAt: number;
};

export type AvatarRequestMessage = { type: "avatar_request" };

export type AvatarDataMessage = {
  type: "avatar_data";
  hash: string;
  mimeType: string;
  updatedAt: number;
  data: string;
};

export type HavenMessage =
  | ProfileAnnounceMessage
  | AvatarRequestMessage
  | AvatarDataMessage
  | FileChunkMessage
  | InviteConsumeMessage
  | InviteAckMessage
  | RosterSyncMessage
  | ChatMessageMessage
  | ReactionMessage
  | TypingMessage
  | PingMessage
  | PongMessage
  | MsgAckMessage
  | ReadReceiptMessage
  | RoomSyncRequestMessage
  | RoomSyncResponseMessage
  | CallInviteMessage
  | CallRingingMessage
  | CallAcceptMessage
  | CallDeclineMessage
  | CallHangupMessage
  | CallMediaStateMessage
  | RoomCallMediaStateMessage
  | CallScreenWatchMessage
  | RoomScreenWatchMessage
  | RtcDescriptionMessage
  | RtcCandidateMessage
  | RoomCallJoinMessage
  | RoomCallLeaveMessage
  | RoomCallPresenceMessage
  | SlotClaimMessage
  | SlotHeartbeatMessage
  | SlotReleaseMessage
  | RoomAnnounceMessage
  | RoomLeaveMessage
  | RoomCallBeaconMessage;
