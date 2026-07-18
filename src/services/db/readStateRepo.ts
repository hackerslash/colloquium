import { getDb } from "./client";

/** Advances the read cursor for a room (never moves it backwards). The cursor
 * is raised to at least the newest message's `sent_at`: unread counts compare
 * against that remote-authored timestamp, so a peer whose clock runs ahead
 * would otherwise leave a phantom unread that the local `at` can't clear. */
export async function markRead(roomId: string, at: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO room_read_state (room_id, last_read_at)
     VALUES ($1, MAX($2, COALESCE((SELECT MAX(sent_at) FROM messages WHERE room_id = $1), 0)))
     ON CONFLICT(room_id) DO UPDATE SET last_read_at = MAX(last_read_at, excluded.last_read_at)`,
    [roomId, at],
  );
}

/** Unread message counts per room: messages from others newer than the read
 * cursor. Rooms with no unread are omitted. */
export async function unreadCounts(selfId: string): Promise<Record<string, number>> {
  const db = await getDb();
  const rows = await db.select<{ room_id: string; n: number }[]>(
    `SELECT m.room_id AS room_id, COUNT(*) AS n
       FROM messages m
       LEFT JOIN room_read_state rs ON rs.room_id = m.room_id
      WHERE m.sent_at > COALESCE(rs.last_read_at, 0)
        AND m.author_id != $1
        AND m.deleted_at IS NULL
      GROUP BY m.room_id`,
    [selfId],
  );
  return Object.fromEntries(rows.map((r) => [r.room_id, r.n]));
}

export async function lastReadTimes(): Promise<Record<string, number>> {
  const db = await getDb();
  const rows = await db.select<{ room_id: string; last_read_at: number }[]>(
    "SELECT room_id, last_read_at FROM room_read_state",
  );
  return Object.fromEntries(rows.map((r) => [r.room_id, r.last_read_at]));
}

/** True if no read cursors exist yet — used to seed all rooms at "now" on the
 * first load after the migration, so history doesn't light up as unread. */
export async function isEmpty(): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM room_read_state");
  return (rows[0]?.n ?? 0) === 0;
}

/** Seeds a read cursor at `at` for every existing room (one-time upgrade). */
export async function seedAll(at: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO room_read_state (room_id, last_read_at)
     SELECT id, $1 FROM rooms
     ON CONFLICT(room_id) DO NOTHING`,
    [at],
  );
}
