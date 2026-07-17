-- Per-room read cursor for unread counts. Keyed by room_id (covers both DM
-- and group rooms). last_read_at is a physical timestamp compared against
-- messages.sent_at.
CREATE TABLE room_read_state (
  room_id TEXT PRIMARY KEY,
  last_read_at INTEGER NOT NULL DEFAULT 0
);
