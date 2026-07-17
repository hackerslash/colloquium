import { getDb } from "./client";
import { base64ToBytes, bytesToBase64 } from "../../lib/base64";

export type FileRecord = {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  data: Uint8Array;
};

export async function insertFile(file: FileRecord): Promise<void> {
  const db = await getDb();
  // OR IGNORE: a late duplicate chunk can re-complete an already-stored file
  // (its map entry was deleted on first completion), and re-inserting the same
  // id would otherwise throw on the UNIQUE constraint.
  await db.execute(
    "INSERT OR IGNORE INTO files (id, name, size, mime_type, data) VALUES (?1, ?2, ?3, ?4, ?5)",
    [file.id, file.name, file.size, file.mimeType, bytesToBase64(file.data)]
  );
}

/** Cheap existence check that doesn't load the blob — used to decide whether to
 * offer a download for an attachment without pulling the whole file into memory. */
export async function fileExists(id: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<{ id: string }[]>("SELECT id FROM files WHERE id = ?1 LIMIT 1", [id]);
  return rows.length > 0;
}

export async function getFile(id: string): Promise<FileRecord | null> {
  const db = await getDb();
  const rows = await db.select<any[]>("SELECT * FROM files WHERE id = ?1", [id]);
  if (rows.length === 0) return null;
  const row = rows[0];
  
  let parsedData: Uint8Array;
  if (typeof row.data === "string") {
    if (row.data.startsWith("[")) {
      // Legacy JSON array format
      parsedData = new Uint8Array(JSON.parse(row.data));
    } else {
      // Base64 format
      parsedData = base64ToBytes(row.data);
    }
  } else {
    // Array format directly from tauri-plugin-sql
    parsedData = new Uint8Array(row.data);
  }

  return {
    id: row.id,
    name: row.name,
    size: row.size,
    mimeType: row.mime_type,
    data: parsedData,
  };
}
