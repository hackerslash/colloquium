CREATE TABLE avatars (
  identity_id TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  data BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
