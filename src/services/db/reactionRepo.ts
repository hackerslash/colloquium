import { getDb } from "./client";
import type { Reaction } from "../../types/domain";

type ReactionRow = {
  message_id: string;
  room_id: string;
  author_id: string;
  emoji: string;
  reacted_at: number;
};

function fromRow(row: ReactionRow): Reaction {
  return {
    messageId: row.message_id,
    roomId: row.room_id,
    authorId: row.author_id,
    emoji: row.emoji,
    reactedAt: row.reacted_at,
  };
}

export async function add(r: Reaction): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO message_reactions (message_id, room_id, author_id, emoji, reacted_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT(message_id, author_id, emoji) DO NOTHING`,
    [r.messageId, r.roomId, r.authorId, r.emoji, r.reactedAt],
  );
}

export async function remove(messageId: string, authorId: string, emoji: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM message_reactions WHERE message_id = $1 AND author_id = $2 AND emoji = $3",
    [messageId, authorId, emoji],
  );
}

export async function listByRoom(roomId: string): Promise<Reaction[]> {
  const db = await getDb();
  const rows = await db.select<ReactionRow[]>(
    "SELECT * FROM message_reactions WHERE room_id = $1 ORDER BY reacted_at ASC",
    [roomId],
  );
  return rows.map(fromRow);
}

export async function listByAuthor(roomId: string, authorId: string): Promise<Reaction[]> {
  const db = await getDb();
  const rows = await db.select<ReactionRow[]>(
    "SELECT * FROM message_reactions WHERE room_id = $1 AND author_id = $2 ORDER BY reacted_at ASC",
    [roomId, authorId],
  );
  return rows.map(fromRow);
}

/** Replaces one author's reactions in a room with the given set — sync sends
 * the author's full current state, so this converges adds AND removals. */
export async function replaceForAuthor(
  roomId: string,
  authorId: string,
  reactions: Reaction[],
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM message_reactions WHERE room_id = $1 AND author_id = $2",
    [roomId, authorId],
  );
  for (const r of reactions) await add(r);
}
