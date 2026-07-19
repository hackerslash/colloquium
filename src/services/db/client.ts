import Database from "@tauri-apps/plugin-sql";

const DB_URL = "sqlite:colloquium.db";

let dbPromise: Promise<Database> | null = null;

// Every repo awaits this same connection so migrations only run once and
// queries never race the initial Database.load().
export function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load(DB_URL);
  }
  return dbPromise;
}
