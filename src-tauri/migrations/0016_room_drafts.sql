-- Unsent composer text, per room. Drafts lived only in the Zustand store
-- before this, so quitting (or the window reloading) silently discarded a
-- half-written message. A row's presence means a non-empty draft; clearing the
-- composer or sending deletes it.
CREATE TABLE room_drafts (
  room_id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
