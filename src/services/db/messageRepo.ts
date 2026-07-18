import { getDb } from "./client";
import type { Message } from "../../types/domain";

type MessageRow = {
  id: string;
  room_id: string;
  author_id: string;
  author_seq: number;
  hlc: string;
  content_type: "text" | "image" | "file" | "system";
  body: string | null;
  attachment_id: string | null;
  attachment_name: string | null;
  attachment_size: number | null;
  attachment_type: string | null;
  reply_to_id: string | null;
  sent_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  sig: string;
  delivery_status: Message["deliveryStatus"];
  read_at: number | null;
};

function fromRow(row: MessageRow): Message {
  return {
    id: row.id,
    roomId: row.room_id,
    authorId: row.author_id,
    authorSeq: row.author_seq,
    hlc: row.hlc,
    contentType: row.content_type,
    body: row.body,
    attachmentId: row.attachment_id ?? undefined,
    attachmentName: row.attachment_name ?? undefined,
    attachmentSize: row.attachment_size ?? undefined,
    attachmentType: row.attachment_type ?? undefined,
    replyToId: row.reply_to_id,
    sentAt: row.sent_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    sig: row.sig,
    deliveryStatus: row.delivery_status,
    readAt: row.read_at,
  };
}

export async function listByRoom(roomId: string): Promise<Message[]> {
  const db = await getDb();
  const rows = await db.select<MessageRow[]>(
    "SELECT * FROM messages WHERE room_id = $1 ORDER BY hlc ASC",
    [roomId],
  );
  return rows.map(fromRow);
}

/** Insert if new; ignore if we already have this (room, author, seq). Makes
 * live delivery and backfill idempotent regardless of arrival order. */
export async function insertIfAbsent(msg: Message): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO messages
       (id, room_id, author_id, author_seq, hlc, content_type, body, attachment_id, attachment_name, attachment_size, attachment_type,
        reply_to_id, sent_at, edited_at, deleted_at, sig, delivery_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT(room_id, author_id, author_seq) DO NOTHING`,
    [
      msg.id,
      msg.roomId,
      msg.authorId,
      msg.authorSeq,
      msg.hlc,
      msg.contentType,
      msg.body,
      msg.attachmentId ?? null,
      msg.attachmentName ?? null,
      msg.attachmentSize ?? null,
      msg.attachmentType ?? null,
      msg.replyToId,
      msg.sentAt,
      msg.editedAt,
      msg.deletedAt,
      msg.sig,
      msg.deliveryStatus,
    ],
  );
  return result.rowsAffected > 0;
}

export async function setDeliveryStatus(
  id: string,
  status: Message["deliveryStatus"],
): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE messages SET delivery_status = $1 WHERE id = $2", [status, id]);
}

/** Marks this author's undelivered messages up to a seq as delivered — used
 * when a peer's sync have-vector proves they already hold them. */
export async function markDeliveredUpTo(
  roomId: string,
  authorId: string,
  maxSeq: number,
): Promise<number> {
  if (maxSeq <= 0) return 0;
  const db = await getDb();
  const result = await db.execute(
    `UPDATE messages SET delivery_status = 'delivered'
     WHERE room_id = $1 AND author_id = $2 AND author_seq <= $3
       AND delivery_status IN ('pending', 'sent')`,
    [roomId, authorId, maxSeq],
  );
  return result.rowsAffected;
}

/** Marks this author's messages up to a seq as read — used when a peer's
 * read receipt (live or ridden on a sync request) covers them. */
export async function markReadUpTo(
  roomId: string,
  authorId: string,
  maxSeq: number,
  at: number,
): Promise<number> {
  if (maxSeq <= 0) return 0;
  const db = await getDb();
  const result = await db.execute(
    `UPDATE messages SET read_at = $1, delivery_status = 'delivered'
     WHERE room_id = $2 AND author_id = $3 AND author_seq <= $4 AND read_at IS NULL`,
    [at, roomId, authorId, maxSeq],
  );
  return result.rowsAffected;
}

/** Per-author highest seq covered by this room's local read cursor — what the
 * user has actually seen, sent to authors as their read receipt. Empty if the
 * room was never opened. */
export async function readVector(roomId: string): Promise<Record<string, number>> {
  const db = await getDb();
  const rows = await db.select<{ author_id: string; max_seq: number }[]>(
    `SELECT m.author_id AS author_id, MAX(m.author_seq) AS max_seq
       FROM messages m
       JOIN room_read_state rs ON rs.room_id = m.room_id
      WHERE m.room_id = $1 AND m.sent_at <= rs.last_read_at
      GROUP BY m.author_id`,
    [roomId],
  );
  return Object.fromEntries(rows.map((r) => [r.author_id, r.max_seq]));
}

/** Highest author_seq this device holds for each author in a room — the
 * `have` vector the backfill protocol sends so peers reply with only the gap. */
export async function highestSeqPerAuthor(roomId: string): Promise<Record<string, number>> {
  const db = await getDb();
  const rows = await db.select<{ author_id: string; max_seq: number }[]>(
    "SELECT author_id, MAX(author_seq) AS max_seq FROM messages WHERE room_id = $1 GROUP BY author_id",
    [roomId],
  );
  return Object.fromEntries(rows.map((r) => [r.author_id, r.max_seq]));
}

/** Messages in a room with author_seq strictly greater than the requester's
 * `have` for that author — i.e. exactly what they're missing. */
export async function messagesSince(
  roomId: string,
  have: Record<string, number>,
): Promise<Message[]> {
  const all = await listByRoom(roomId);
  return all.filter((m) => (have[m.authorId] ?? 0) < m.authorSeq);
}

export async function nextAuthorSeq(roomId: string, authorId: string): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ max_seq: number | null }[]>(
    "SELECT MAX(author_seq) AS max_seq FROM messages WHERE room_id = $1 AND author_id = $2",
    [roomId, authorId],
  );
  return (rows[0]?.max_seq ?? 0) + 1;
}

export async function latestHlc(): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ hlc: string }[]>(
    "SELECT hlc FROM messages ORDER BY hlc DESC LIMIT 1",
  );
  return rows[0]?.hlc ?? null;
}
