import { getDb } from "./client";
import type { Room } from "../../types/domain";

type RoomRow = {
  id: string;
  type: "dm" | "group";
  name: string | null;
  topic: string | null;
  created_by: string | null;
  created_at: number;
  is_archived: number;
  last_message_at: number | null;
};

function fromRow(row: RoomRow): Room {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    topic: row.topic,
    createdBy: row.created_by,
    createdAt: row.created_at,
    isArchived: row.is_archived === 1,
    lastMessageAt: row.last_message_at,
  };
}

/** Rooms visible to this identity: DMs always, group rooms only while our own
 * membership isn't tombstoned (a left room stays in the DB so its tombstone
 * keeps blocking re-announces, but disappears from lists). */
export async function listRooms(selfId: string): Promise<Room[]> {
  const db = await getDb();
  const rows = await db.select<RoomRow[]>(
    `SELECT r.* FROM rooms r
     LEFT JOIN room_members rm ON rm.room_id = r.id AND rm.contact_id = $1
     WHERE r.is_archived = 0
       AND (r.type = 'dm' OR (rm.contact_id IS NOT NULL AND rm.left_at IS NULL))
     ORDER BY r.last_message_at DESC NULLS LAST, r.created_at DESC`,
    [selfId],
  );
  return rows.map(fromRow);
}

export async function getRoom(id: string): Promise<Room | null> {
  const db = await getDb();
  const rows = await db.select<RoomRow[]>("SELECT * FROM rooms WHERE id = $1", [id]);
  return rows.length > 0 ? fromRow(rows[0]) : null;
}

/** Idempotent — safe to call whenever a contact is (re)discovered. */
export async function ensureDmRoom(
  roomId: string,
  createdBy: string,
  createdAt: number,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO rooms (id, type, created_by, created_at) VALUES ($1, 'dm', $2, $3)
     ON CONFLICT(id) DO NOTHING`,
    [roomId, createdBy, createdAt],
  );
}

export async function upsertGroupRoom(room: {
  id: string;
  name: string | null;
  topic: string | null;
  createdBy: string;
  createdAt: number;
}): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO rooms (id, type, name, topic, created_by, created_at)
     VALUES ($1, 'group', $2, $3, $4, $5)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, topic = excluded.topic`,
    [room.id, room.name, room.topic, room.createdBy, room.createdAt],
  );
}

export async function touchLastMessage(roomId: string, at: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE rooms SET last_message_at = $1 WHERE id = $2 AND (last_message_at IS NULL OR last_message_at < $1)",
    [at, roomId],
  );
}
