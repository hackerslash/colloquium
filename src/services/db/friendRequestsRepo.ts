import { getDb } from "./client";

export type FriendRequest = {
  id: string;
  fromId: string;
  fromPubKey: string;
  displayName: string;
  direction: "incoming" | "outgoing";
  status: "pending" | "accepted" | "declined";
  createdAt: number;
};

type FriendRequestRow = {
  id: string;
  from_id: string;
  from_pubkey: string;
  display_name: string;
  direction: "incoming" | "outgoing";
  status: "pending" | "accepted" | "declined";
  created_at: number;
};

function fromRow(row: FriendRequestRow): FriendRequest {
  return {
    id: row.id,
    fromId: row.from_id,
    fromPubKey: row.from_pubkey,
    displayName: row.display_name,
    direction: row.direction,
    status: row.status,
    createdAt: row.created_at,
  };
}

export async function listPendingIncoming(): Promise<FriendRequest[]> {
  const db = await getDb();
  const rows = await db.select<FriendRequestRow[]>(
    "SELECT * FROM friend_requests WHERE direction = 'incoming' AND status = 'pending' ORDER BY created_at DESC"
  );
  return rows.map(fromRow);
}

/** Every caller passes a freshly-generated id for a brand new pending
 * request, so the conflict target that matters is the dedup one: a second
 * near-simultaneous request from/to the same party (network race or a
 * double-clicked "Add friend") folds into the existing pending row instead
 * of creating a duplicate — see idx_friend_requests_pending_unique. */
export async function upsert(req: FriendRequest): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO friend_requests (id, from_id, from_pubkey, display_name, direction, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(from_id, direction) WHERE status = 'pending' DO UPDATE SET
       status = excluded.status,
       display_name = excluded.display_name,
       from_pubkey = excluded.from_pubkey`,
    [req.id, req.fromId, req.fromPubKey, req.displayName, req.direction, req.status, req.createdAt]
  );
}

export async function setStatus(id: string, status: "accepted" | "declined"): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE friend_requests SET status = ?1 WHERE id = ?2", [status, id]);
}

export async function findByFromId(fromId: string): Promise<FriendRequest | null> {
  const db = await getDb();
  const rows = await db.select<FriendRequestRow[]>(
    "SELECT * FROM friend_requests WHERE from_id = ?1 ORDER BY created_at DESC LIMIT 1",
    [fromId]
  );
  return rows.length > 0 ? fromRow(rows[0]) : null;
}
