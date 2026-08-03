import { getDb } from "./client";

export async function listDrafts(): Promise<Record<string, string>> {
  const db = await getDb();
  const rows = await db.select<{ room_id: string; body: string }[]>(
    "SELECT room_id, body FROM room_drafts",
  );
  return Object.fromEntries(rows.map((r) => [r.room_id, r.body]));
}

export async function saveDraft(roomId: string, body: string, at: number): Promise<void> {
  const db = await getDb();
  if (!body) {
    await db.execute("DELETE FROM room_drafts WHERE room_id = $1", [roomId]);
    return;
  }
  await db.execute(
    `INSERT INTO room_drafts (room_id, body, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT(room_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
    [roomId, body, at],
  );
}
