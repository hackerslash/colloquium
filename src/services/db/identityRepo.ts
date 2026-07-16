import { getDb } from "./client";
import type { Identity } from "../../types/domain";

type IdentityRow = {
  identity_id: string;
  public_key: string;
  display_name: string;
  avatar_path: string | null;
  status_message: string | null;
  created_at: number;
};

function fromRow(row: IdentityRow): Identity {
  return {
    identityId: row.identity_id,
    publicKey: row.public_key,
    displayName: row.display_name,
    avatarPath: row.avatar_path,
    statusMessage: row.status_message,
    createdAt: row.created_at,
  };
}

export async function getIdentity(): Promise<Identity | null> {
  const db = await getDb();
  const rows = await db.select<IdentityRow[]>(
    "SELECT identity_id, public_key, display_name, avatar_path, status_message, created_at FROM identity WHERE id = 1",
  );
  return rows.length > 0 ? fromRow(rows[0]) : null;
}

export async function createIdentity(identity: Identity): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO identity (id, identity_id, public_key, display_name, avatar_path, status_message, created_at)
     VALUES (1, $1, $2, $3, $4, $5, $6)`,
    [
      identity.identityId,
      identity.publicKey,
      identity.displayName,
      identity.avatarPath,
      identity.statusMessage,
      identity.createdAt,
    ],
  );
}

export async function updateDisplayName(displayName: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE identity SET display_name = $1 WHERE id = 1", [
    displayName,
  ]);
}

/** Clears the local profile row. Only valid once the matching private key is
 * confirmed gone from the keychain — this device can no longer act as that
 * identity, so the stale row would otherwise block re-onboarding. */
export async function deleteIdentity(): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM identity WHERE id = 1");
}
