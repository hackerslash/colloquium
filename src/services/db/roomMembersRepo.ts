import { getDb } from "./client";
import type { RoomMemberWire } from "../../types/wire";

type RoomMemberRow = {
  room_id: string;
  contact_id: string;
  role: "owner" | "member";
  joined_at: number;
  last_read_seq: number;
  notifications_muted: number;
  left_at: number | null;
  updated_at: number;
  display_name: string | null;
};

/** Active (non-tombstoned) member ids. */
export async function listMembers(roomId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<RoomMemberRow[]>(
    "SELECT contact_id FROM room_members WHERE room_id = $1 AND left_at IS NULL",
    [roomId],
  );
  return rows.map((r) => r.contact_id);
}

/** Every membership row including tombstones — announces must carry these so
 * a leave propagates instead of being silently resurrected. */
export async function listMembersFull(roomId: string): Promise<RoomMemberWire[]> {
  const db = await getDb();
  const rows = await db.select<RoomMemberRow[]>(
    "SELECT * FROM room_members WHERE room_id = $1",
    [roomId],
  );
  return rows.map((r) => ({
    id: r.contact_id,
    displayName: r.display_name,
    role: r.role,
    joinedAt: r.joined_at,
    leftAt: r.left_at,
    updatedAt: r.updated_at,
  }));
}

/** Group room ids we share with a given contact — used to backfill each
 * shared room's chat when that peer reconnects. */
export async function sharedGroupRoomIds(contactId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{ room_id: string }[]>(
    `SELECT rm.room_id FROM room_members rm
       JOIN rooms r ON r.id = rm.room_id
      WHERE rm.contact_id = $1 AND rm.left_at IS NULL AND r.type = 'group'`,
    [contactId],
  );
  return rows.map((r) => r.room_id);
}

export async function addMember(
  roomId: string,
  contactId: string,
  role: "owner" | "member",
  joinedAt: number,
  displayName: string | null = null,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO room_members (room_id, contact_id, role, joined_at, updated_at, display_name)
     VALUES ($1, $2, $3, $4, $4, $5)
     ON CONFLICT(room_id, contact_id) DO NOTHING`,
    [roomId, contactId, role, joinedAt, displayName],
  );
}

/** Order-independent LWW merge: the entry with the newer updatedAt wins,
 * whether it marks the member active or left. joined_at is preserved and
 * display_name only ever improves (never nulled by a sparse entry). */
export async function mergeMember(roomId: string, member: RoomMemberWire): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO room_members (room_id, contact_id, role, joined_at, left_at, updated_at, display_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT(room_id, contact_id) DO UPDATE SET
       role = excluded.role,
       left_at = excluded.left_at,
       updated_at = excluded.updated_at,
       display_name = COALESCE(excluded.display_name, room_members.display_name)
     WHERE excluded.updated_at > room_members.updated_at`,
    [
      roomId,
      member.id,
      member.role,
      member.joinedAt,
      member.leftAt,
      member.updatedAt,
      member.displayName,
    ],
  );
}

/** Tombstones a membership with the LWW guard, inserting a bare tombstone row
 * if the member was never materialized locally. Preserves role/joined_at/
 * display_name on existing rows. */
export async function applyLeave(roomId: string, contactId: string, at: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO room_members (room_id, contact_id, role, joined_at, left_at, updated_at)
     VALUES ($1, $2, 'member', 0, $3, $3)
     ON CONFLICT(room_id, contact_id) DO UPDATE SET
       left_at = excluded.left_at,
       updated_at = excluded.updated_at
     WHERE excluded.updated_at > room_members.updated_at`,
    [roomId, contactId, at],
  );
}

export async function isActiveMember(roomId: string, contactId: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM room_members
      WHERE room_id = $1 AND contact_id = $2 AND left_at IS NULL`,
    [roomId, contactId],
  );
  return (rows[0]?.n ?? 0) > 0;
}
