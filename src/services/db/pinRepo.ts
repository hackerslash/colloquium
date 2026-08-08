import { getDb } from "./client";
import type { Pin } from "../../types/domain";

type PinRow = {
  message_id: string;
  room_id: string;
  author_id: string;
  pinned_at: number;
};

function fromRow(row: PinRow): Pin {
  return {
    messageId: row.message_id,
    roomId: row.room_id,
    authorId: row.author_id,
    pinnedAt: row.pinned_at,
  };
}

export async function add(p: Pin): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO message_pins (message_id, room_id, author_id, pinned_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT(message_id, author_id) DO NOTHING`,
    [p.messageId, p.roomId, p.authorId, p.pinnedAt],
  );
}

export async function remove(messageId: string, authorId: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM message_pins WHERE message_id = $1 AND author_id = $2",
    [messageId, authorId],
  );
}

export async function listByRoom(roomId: string): Promise<Pin[]> {
  const db = await getDb();
  const rows = await db.select<PinRow[]>(
    "SELECT * FROM message_pins WHERE room_id = $1 ORDER BY pinned_at ASC",
    [roomId],
  );
  return rows.map(fromRow);
}

export async function listByAuthor(roomId: string, authorId: string): Promise<Pin[]> {
  const db = await getDb();
  const rows = await db.select<PinRow[]>(
    "SELECT * FROM message_pins WHERE room_id = $1 AND author_id = $2 ORDER BY pinned_at ASC",
    [roomId, authorId],
  );
  return rows.map(fromRow);
}

/** Replaces one author's pins in a room with the given set — sync sends the
 * author's full current state, so this converges pins AND unpins. */
export async function replaceForAuthor(
  roomId: string,
  authorId: string,
  pins: Pin[],
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM message_pins WHERE room_id = $1 AND author_id = $2",
    [roomId, authorId],
  );
  for (const p of pins) await add(p);
}
