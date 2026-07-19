import type { Identity, Message, Reaction } from "../../types/domain";
import type {
  ChatMessageMessage,
  ChatMessageWire,
  ReactionMessage,
  ReadReceiptMessage,
  RoomSyncRequestMessage,
  RoomSyncResponseMessage,
  FileChunkMessage,
} from "../../types/wire";
import * as identityService from "../identity/identity";
import * as messageRepo from "../db/messageRepo";
import * as reactionRepo from "../db/reactionRepo";
import * as roomRepo from "../db/roomRepo";
import * as rosterRepo from "../db/rosterRepo";
import { getPeerRegistry } from "../peer/registry";
import { derivePeerId } from "../peer/derivePeerId";
import { bytesToBase64, base64ToBytes, utf8ToBase64 } from "../../lib/base64";
import * as fileRepo from "../db/fileRepo";
import { tickLocal, tickReceive, type Hlc } from "../../lib/hlc";

/** Hard cap on attachment size. base64 inflates ~33% and whole files are held
 * in memory during transfer + stored in SQLite, so keep this modest. Enforced
 * on both the send side (Composer) and the receive side (handleFileChunk). */
export const MAX_FILE_SIZE = 25 * 1024 * 1024;

const CHUNK_SIZE = 16 * 1024;
/** Drop a partially-received file if no new chunk arrives within this window,
 * so an interrupted transfer doesn't pin its chunks in memory forever. */
const FILE_ASSEMBLY_TTL_MS = 60_000;

// In-memory HLC, seeded from the DB on init. Only this module mutates it.
let clock: Hlc | null = null;
let clockReady: Promise<void> | null = null;

// Serializes the seq-allocate -> sign -> insert sequence in sendMessage. Two
// overlapping sends would otherwise both read the same next author_seq
// before either insert lands, and the second insert would be silently
// dropped by the UNIQUE(room_id, author_id, author_seq) constraint — the
// signature binds author_seq, so the seq must be known before signing and
// can't just be assigned atomically by the DB at insert time.
let sendLock: Promise<unknown> = Promise.resolve();
function withSendLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = sendLock.then(fn, fn);
  sendLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function ensureClock(): Promise<void> {
  if (!clockReady) clockReady = messageRepo.latestHlc().then((h) => void (clock = h));
  return clockReady;
}

function nodeShort(identityId: string): string {
  return identityId.slice(0, 8);
}

/** Deterministic DM room id from the two member identityIds — both peers
 * compute the same id independently, so neither needs to send room metadata. */
export async function dmRoomId(a: string, b: string): Promise<string> {
  const [lo, hi] = [a, b].sort();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${lo}|${hi}`),
  );
  const hex = [...new Uint8Array(digest)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  return `dm_${hex.slice(0, 32)}`;
}

function canonicalMessage(m: Omit<ChatMessageWire, "sig">): string {
  return JSON.stringify([
    m.id,
    m.roomId,
    m.authorId,
    m.authorSeq,
    m.hlc,
    m.contentType,
    m.body,
    m.attachmentId ?? null,
    m.attachmentName ?? null,
    m.attachmentSize ?? null,
    m.attachmentType ?? null,
    m.replyToId,
    m.sentAt,
    m.editedAt,
    m.deletedAt,
  ]);
}

function wireToMessage(w: ChatMessageWire, deliveryStatus: Message["deliveryStatus"]): Message {
  return { ...w, deliveryStatus, readAt: null };
}

function messageToWire(m: Message): ChatMessageWire {
  return {
    id: m.id,
    roomId: m.roomId,
    authorId: m.authorId,
    authorSeq: m.authorSeq,
    hlc: m.hlc,
    contentType: m.contentType,
    body: m.body,
    attachmentId: m.attachmentId,
    attachmentName: m.attachmentName,
    attachmentSize: m.attachmentSize,
    attachmentType: m.attachmentType,
    replyToId: m.replyToId,
    sentAt: m.sentAt,
    editedAt: m.editedAt,
    deletedAt: m.deletedAt,
    sig: m.sig,
  };
}

/** Broadcasts to the room's currently-connected members and returns how many
 * actually received the send (offline members converge later via room sync). */
function broadcastToRoomMembers(roomMemberIds: string[], data: unknown): number {
  const registry = getPeerRegistry();
  let delivered = 0;
  for (const memberId of roomMemberIds) {
    if (registry.send(derivePeerId(memberId), data)) delivered++;
  }
  return delivered;
}

export async function sendMessage(
  self: Identity,
  roomId: string,
  memberIds: string[],
  body: string,
  physicalNow: number,
  attachment?: { id: string; name: string; size: number; type: string },
  fileBuffer?: Uint8Array,
  replyToId?: string | null,
): Promise<Message> {
  await ensureClock();
  clock = tickLocal(clock, physicalNow, nodeShort(self.identityId));
  const hlc = clock;

  const message = await withSendLock(async () => {
    const authorSeq = await messageRepo.nextAuthorSeq(roomId, self.identityId);
    const wireBase: Omit<ChatMessageWire, "sig"> = {
      id: crypto.randomUUID(),
      roomId,
      authorId: self.identityId,
      authorSeq,
      hlc,
      contentType: attachment ? (attachment.type.startsWith("image/") ? "image" : "file") : "text",
      body,
      attachmentId: attachment?.id ?? undefined,
      attachmentName: attachment?.name ?? undefined,
      attachmentSize: attachment?.size ?? undefined,
      attachmentType: attachment?.type ?? undefined,
      replyToId: replyToId ?? null,
      sentAt: physicalNow,
      editedAt: null,
      deletedAt: null,
    };
    const sig = await identityService.sign(utf8ToBase64(canonicalMessage(wireBase)));
    const wire: ChatMessageWire = { ...wireBase, sig };

    const built = wireToMessage(wire, "pending");
    const inserted = await messageRepo.insertIfAbsent(built);
    if (!inserted) {
      // Should be unreachable now that allocation+insert is serialized, but
      // never silently broadcast a message we don't actually hold locally.
      throw new Error("failed to allocate a unique message sequence");
    }
    await roomRepo.touchLastMessage(roomId, built.sentAt);
    return built;
  });

  const payload: ChatMessageMessage = { type: "chat_message", message: messageToWire(message) };
  const recipients = memberIds.filter((id) => id !== self.identityId);

  // If there's a file, chunk and send it BEFORE the message so it's ready when the message arrives
  if (attachment && fileBuffer) {
    const base64Data = bytesToBase64(fileBuffer);
    // max(1): a 0-byte file still needs one (empty) terminal chunk, otherwise
    // the receiver never learns the transfer is complete and stores no blob.
    const totalChunks = Math.max(1, Math.ceil(base64Data.length / CHUNK_SIZE));

    for (let i = 0; i < totalChunks; i++) {
      const chunkData = base64Data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const chunkMsg: FileChunkMessage = {
        type: "file_chunk",
        fileId: attachment.id,
        fileName: attachment.name,
        mimeType: attachment.type,
        chunkIndex: i,
        totalChunks,
        data: chunkData
      };
      broadcastToRoomMembers(recipients, chunkMsg);
      
      // Yield to the event loop every 10 chunks to allow WebRTC buffers to drain
      // and prevent the UI thread from freezing.
      if (i % 10 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  }

  const delivered = broadcastToRoomMembers(recipients, payload);
  if (delivered > 0) {
    message.deliveryStatus = "sent";
    await messageRepo.setDeliveryStatus(message.id, "sent");
  }
  return message;
}

async function verifyAndStore(wire: ChatMessageWire, physicalNow: number, selfId: string): Promise<Message | null> {
  const contact = await rosterRepo.getContact(wire.authorId);
  if (!contact) return null; // never store messages from untrusted identities

  // A DM room only ever holds `self` and one contact, and its id is a pure
  // function of both. Reject any message whose author isn't a party to the DM
  // it claims — otherwise a trusted contact could forge a message into our
  // private DM with a third party (its id is publicly derivable).
  if (wire.roomId.startsWith("dm_")) {
    const expected = await dmRoomId(selfId, wire.authorId);
    if (wire.roomId !== expected) return null;
  }

  const valid = await identityService.verify(
    contact.publicKey,
    utf8ToBase64(canonicalMessage(wire)),
    wire.sig,
  );
  if (!valid) return null;

  await ensureClock();
  clock = tickReceive(clock, wire.hlc, physicalNow, nodeShort(selfId));

  const message = wireToMessage(wire, "delivered");
  const inserted = await messageRepo.insertIfAbsent(message);
  if (inserted) await roomRepo.touchLastMessage(message.roomId, message.sentAt);
  return inserted ? message : null;
}

export async function handleChatMessage(
  self: Identity,
  msg: ChatMessageMessage,
  physicalNow: number,
): Promise<Message | null> {
  return verifyAndStore(msg.message, physicalNow, self.identityId);
}

/** Tells each author whose messages our read cursor covers that we've seen
 * them. Sent when the local user actually views a room; authors who are
 * offline converge via the read vector on the next sync request instead. */
export async function sendReadReceipt(selfId: string, roomId: string): Promise<void> {
  const upTo = await messageRepo.readVector(roomId);
  delete upTo[selfId];
  if (Object.keys(upTo).length === 0) return;
  const payload: ReadReceiptMessage = { type: "read_receipt", roomId, upTo };
  const registry = getPeerRegistry();
  for (const authorId of Object.keys(upTo)) {
    registry.send(derivePeerId(authorId), payload);
  }
}

/** Flips our own messages covered by a peer's read receipt to read. Returns
 * true if anything changed. Same DM guard as messages. */
export async function handleReadReceipt(
  selfId: string,
  senderId: string,
  msg: ReadReceiptMessage,
): Promise<boolean> {
  if (msg.roomId.startsWith("dm_")) {
    const expected = await dmRoomId(selfId, senderId);
    if (msg.roomId !== expected) return false;
  }
  const upTo = msg.upTo[selfId];
  if (!upTo) return false;
  return (await messageRepo.markReadUpTo(msg.roomId, selfId, upTo, Date.now())) > 0;
}

/** Longest ZWJ emoji sequences are ~15 UTF-16 units; anything past this is a
 * peer trying to stuff arbitrary text into a reaction. */
const MAX_REACTION_EMOJI_LEN = 32;

/** Persists a local reaction toggle and broadcasts it to connected room
 * members. Offline members converge via room sync on reconnect. */
export async function sendReaction(
  self: Identity,
  roomId: string,
  memberIds: string[],
  messageId: string,
  emoji: string,
  op: "add" | "remove",
  physicalNow: number,
): Promise<Reaction> {
  const reaction: Reaction = {
    messageId,
    roomId,
    authorId: self.identityId,
    emoji,
    reactedAt: physicalNow,
  };
  if (op === "add") await reactionRepo.add(reaction);
  else await reactionRepo.remove(messageId, self.identityId, emoji);

  const payload: ReactionMessage = {
    type: "reaction",
    roomId,
    messageId,
    emoji,
    op,
    reactedAt: physicalNow,
  };
  broadcastToRoomMembers(memberIds.filter((id) => id !== self.identityId), payload);
  return reaction;
}

/** Applies a live reaction toggle, attributed to the authenticated sender.
 * Same DM guard as messages: a trusted contact can't inject reactions into
 * our DM with a third party. */
export async function handleReaction(
  selfId: string,
  senderId: string,
  msg: ReactionMessage,
): Promise<Reaction | null> {
  if (!msg.emoji || msg.emoji.length > MAX_REACTION_EMOJI_LEN) return null;
  if (msg.roomId.startsWith("dm_")) {
    const expected = await dmRoomId(selfId, senderId);
    if (msg.roomId !== expected) return null;
  }
  const reaction: Reaction = {
    messageId: msg.messageId,
    roomId: msg.roomId,
    authorId: senderId,
    emoji: msg.emoji,
    reactedAt: msg.reactedAt,
  };
  if (msg.op === "add") await reactionRepo.add(reaction);
  else await reactionRepo.remove(msg.messageId, senderId, msg.emoji);
  return reaction;
}

// In-memory store for incoming file chunks
const incomingFiles = new Map<string, {
  chunks: string[];
  receivedCount: number;
  expected: number;
  fileName: string;
  mimeType: string;
  updatedAt: number;
}>();

/** Drops partial transfers that have gone quiet, so interrupted sends (or a
 * lone late duplicate chunk that reopened a deleted entry) don't leak their
 * base64 chunks in memory. */
function sweepStalePartials(now: number): void {
  for (const [fileId, state] of incomingFiles) {
    if (now - state.updatedAt > FILE_ASSEMBLY_TTL_MS) incomingFiles.delete(fileId);
  }
}

export async function handleFileChunk(msg: FileChunkMessage): Promise<void> {
  const now = Date.now();
  sweepStalePartials(now);

  // Reject oversize transfers up front (base64 length ≈ 4/3 × bytes), before
  // buffering any chunks — a malicious/buggy sender can't exhaust memory.
  if (msg.totalChunks * CHUNK_SIZE * 0.75 > MAX_FILE_SIZE) return;
  // The cap above bounds the declared chunk count, but a single chunk can still
  // carry an arbitrarily large payload; bound each chunk to CHUNK_SIZE and
  // reject out-of-range indices (which would otherwise allocate a huge sparse
  // array and assemble a corrupt file).
  if (msg.data.length > CHUNK_SIZE) return;
  if (msg.chunkIndex < 0 || msg.chunkIndex >= msg.totalChunks) return;

  let state = incomingFiles.get(msg.fileId);
  if (!state) {
    state = {
      chunks: [],
      receivedCount: 0,
      expected: msg.totalChunks,
      fileName: msg.fileName,
      mimeType: msg.mimeType,
      updatedAt: now,
    };
    incomingFiles.set(msg.fileId, state);
  }
  state.updatedAt = now;

  // `=== undefined` (not falsy): chunk data can legitimately be "" for a 0-byte
  // file, and this also makes duplicate chunks idempotent instead of
  // double-counting toward the expected total.
  if (state.chunks[msg.chunkIndex] === undefined) {
    state.chunks[msg.chunkIndex] = msg.data;
    state.receivedCount++;

    if (state.receivedCount === state.expected) {
      const fullBase64 = state.chunks.join("");
      const bytes = base64ToBytes(fullBase64);

      // Only drop the in-memory chunks once they're durably stored — if the
      // insert throws (disk full, DB locked), the assembled bytes stay
      // buffered so a retry (or the TTL sweep) doesn't lose them outright.
      await fileRepo.insertFile({
        id: msg.fileId,
        name: state.fileName,
        size: bytes.length,
        mimeType: state.mimeType,
        data: bytes,
      });
      incomingFiles.delete(msg.fileId);

      // Dispatch an event so MessageList/MessageAttachment can re-render to load the file
      window.dispatchEvent(new CustomEvent("colloquium_file_downloaded", { detail: msg.fileId }));
    }
  }
}

/** Responds with the messages the requester is missing. Also treats their
 * have-vector as an implicit receipt for our own messages — anything of ours
 * at or below their seq is on their device, so pending/sent flips to
 * delivered. Returns true if any of our statuses changed. */
export async function handleRoomSyncRequest(
  selfId: string,
  fromPeerId: string,
  requesterId: string,
  msg: RoomSyncRequestMessage,
): Promise<boolean> {
  // Don't serve DM history to anyone but the other party to that DM — the room
  // id is publicly derivable, so without this any trusted contact could pull
  // our private conversation with a third party.
  if (msg.roomId.startsWith("dm_")) {
    const expected = await dmRoomId(selfId, requesterId);
    if (msg.roomId !== expected) return false;
  }

  const flipped = await messageRepo.markDeliveredUpTo(
    msg.roomId,
    selfId,
    msg.have[selfId] ?? 0,
  );
  // Their read cursor doubles as a receipt for anything of ours it covers —
  // reads that happened while we were offline converge here.
  const readFlipped = msg.read?.[selfId]
    ? await messageRepo.markReadUpTo(msg.roomId, selfId, msg.read[selfId], Date.now())
    : 0;

  const missing = await messageRepo.messagesSince(msg.roomId, msg.have);
  // Reactions always ride along as our full current set — an empty set still
  // needs to be sent so a reaction we removed while they were offline clears.
  const ownReactions = await reactionRepo.listByAuthor(msg.roomId, selfId);
  const response: RoomSyncResponseMessage = {
    type: "room_sync_response",
    roomId: msg.roomId,
    messages: missing.map(messageToWire),
    reactions: ownReactions.map((r) => ({
      messageId: r.messageId,
      emoji: r.emoji,
      reactedAt: r.reactedAt,
    })),
  };
  getPeerRegistry().send(fromPeerId, response);
  return flipped + readFlipped > 0;
}

export async function handleRoomSyncResponse(
  self: Identity,
  senderId: string,
  msg: RoomSyncResponseMessage,
  physicalNow: number,
): Promise<Message[]> {
  const stored: Message[] = [];
  for (const wire of msg.messages) {
    const m = await verifyAndStore(wire, physicalNow, self.identityId);
    if (m) stored.push(m);
  }

  // The reaction set is attributed to the responder — same DM guard as
  // messages so a contact can't plant reactions in our DM with someone else.
  if (msg.reactions) {
    let allowed = true;
    if (msg.roomId.startsWith("dm_")) {
      allowed = msg.roomId === (await dmRoomId(self.identityId, senderId));
    }
    if (allowed) {
      const sane = msg.reactions
        .filter((r) => r.emoji && r.emoji.length <= MAX_REACTION_EMOJI_LEN)
        .map((r) => ({
          messageId: r.messageId,
          roomId: msg.roomId,
          authorId: senderId,
          emoji: r.emoji,
          reactedAt: r.reactedAt,
        }));
      await reactionRepo.replaceForAuthor(msg.roomId, senderId, sane);
    }
  }
  return stored;
}

/** Sends our `have` vector for a room so the peer backfills anything we're
 * missing. Called when a room's peer (re)connects. */
export async function requestRoomSync(roomId: string, toPeerId: string): Promise<void> {
  const have = await messageRepo.highestSeqPerAuthor(roomId);
  const read = await messageRepo.readVector(roomId);
  const request: RoomSyncRequestMessage = { type: "room_sync_request", roomId, have, read };
  getPeerRegistry().send(toPeerId, request);
}
