import { getDb } from "./client";

/** Marks a room muted (idempotent). Muted rooms suppress notifications,
 * sounds, and dock-badge contribution unless a message mentions the user. */
export async function mute(roomId: string, at: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO room_mute_state (room_id, muted_at)
     VALUES ($1, $2)
     ON CONFLICT(room_id) DO UPDATE SET muted_at = excluded.muted_at`,
    [roomId, at],
  );
}

export async function unmute(roomId: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM room_mute_state WHERE room_id = $1", [roomId]);
}

/** The set of currently-muted room ids. */
export async function listMuted(): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.select<{ room_id: string }[]>(
    "SELECT room_id FROM room_mute_state",
  );
  return new Set(rows.map((r) => r.room_id));
}
