import { getDb } from "./client";
import type { RosterContact } from "../../types/domain";
import type { RosterEntryWire } from "../../types/wire";

type RosterRow = {
  identity_id: string;
  public_key: string;
  display_name: string;
  avatar_path: string | null;
  added_by: string;
  added_at: number;
  last_seen_at: number | null;
  last_known_peer_id: string | null;
  updated_at: number;
  revoked: number;
  revoked_at: number | null;
  revoked_by: string | null;
};

function fromRow(row: RosterRow): RosterContact {
  return {
    identityId: row.identity_id,
    publicKey: row.public_key,
    displayName: row.display_name,
    avatarPath: row.avatar_path,
    addedBy: row.added_by,
    addedAt: row.added_at,
    lastSeenAt: row.last_seen_at,
    lastKnownPeerId: row.last_known_peer_id,
    updatedAt: row.updated_at,
    revoked: row.revoked === 1,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
  };
}

export async function listContacts(): Promise<RosterContact[]> {
  const db = await getDb();
  const rows = await db.select<RosterRow[]>("SELECT * FROM roster");
  return rows.map(fromRow);
}

export async function getContact(identityId: string): Promise<RosterContact | null> {
  const db = await getDb();
  const rows = await db.select<RosterRow[]>(
    "SELECT * FROM roster WHERE identity_id = $1",
    [identityId],
  );
  return rows.length > 0 ? fromRow(rows[0]) : null;
}

/** Grow-only-add + per-field last-writer-wins merge: safe to call repeatedly
 * with the same or stale data — a caller never needs to check first. */
export async function upsertLww(entry: RosterEntryWire): Promise<void> {
  const db = await getDb();
  const existing = await getContact(entry.identityId);

  if (!existing) {
    await db.execute(
      `INSERT INTO roster
         (identity_id, public_key, display_name, added_by, added_at, updated_at, revoked, revoked_at, revoked_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.identityId,
        entry.publicKey,
        entry.displayName,
        entry.addedBy,
        entry.addedAt,
        entry.updatedAt,
        entry.revoked ? 1 : 0,
        entry.revokedAt,
        entry.revokedBy,
      ],
    );
    return;
  }

  if (entry.updatedAt < existing.updatedAt) return;

  await db.execute(
    `UPDATE roster
        SET display_name = $1, updated_at = $2, revoked = $3, revoked_at = $4, revoked_by = $5
      WHERE identity_id = $6`,
    [
      entry.displayName,
      entry.updatedAt,
      entry.revoked ? 1 : 0,
      entry.revokedAt,
      entry.revokedBy,
      entry.identityId,
    ],
  );
}

export async function deleteContact(identityId: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM roster WHERE identity_id = $1", [identityId]);
}

/** Marks a contact revoked with a fresh updatedAt so the change wins the LWW
 * merge and propagates to peers (who then stop dialing/showing it too). */
export async function revokeContact(
  identityId: string,
  revokedBy: string,
  now: number,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE roster
        SET revoked = 1, revoked_at = $1, revoked_by = $2, updated_at = $1
      WHERE identity_id = $3`,
    [now, revokedBy, identityId],
  );
}

export async function markSeen(identityId: string, peerId: string, seenAt: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE roster SET last_seen_at = $1, last_known_peer_id = $2 WHERE identity_id = $3",
    [seenAt, peerId, identityId],
  );
}
