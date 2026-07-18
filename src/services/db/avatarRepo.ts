import { getDb } from "./client";
import { base64ToBytes, bytesToBase64 } from "../../lib/base64";

export type AvatarRecord = {
  identityId: string;
  hash: string;
  mimeType: string;
  data: Uint8Array;
  updatedAt: number;
};

/** Hash + timestamp without pulling the blob — used to compare against a peer's
 * announced avatar before deciding whether to request the bytes. */
export async function getAvatarMeta(
  identityId: string,
): Promise<{ hash: string; updatedAt: number } | null> {
  const db = await getDb();
  const rows = await db.select<{ hash: string; updated_at: number }[]>(
    "SELECT hash, updated_at FROM avatars WHERE identity_id = $1",
    [identityId],
  );
  return rows.length > 0 ? { hash: rows[0].hash, updatedAt: rows[0].updated_at } : null;
}

export async function getAvatar(identityId: string): Promise<AvatarRecord | null> {
  const db = await getDb();
  const rows = await db.select<any[]>("SELECT * FROM avatars WHERE identity_id = $1", [identityId]);
  if (rows.length === 0) return null;
  const row = rows[0];

  // tauri-plugin-sql may hand back a blob as a base64 string or a raw byte
  // array depending on platform — match fileRepo's tolerant decode.
  const data =
    typeof row.data === "string" ? base64ToBytes(row.data) : new Uint8Array(row.data);

  return {
    identityId: row.identity_id,
    hash: row.hash,
    mimeType: row.mime_type,
    data,
    updatedAt: row.updated_at,
  };
}

export async function upsertAvatar(rec: AvatarRecord): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO avatars (identity_id, hash, mime_type, data, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(identity_id) DO UPDATE SET
       hash = excluded.hash,
       mime_type = excluded.mime_type,
       data = excluded.data,
       updated_at = excluded.updated_at`,
    [rec.identityId, rec.hash, rec.mimeType, bytesToBase64(rec.data), rec.updatedAt],
  );
}

export async function deleteAvatar(identityId: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM avatars WHERE identity_id = $1", [identityId]);
}
