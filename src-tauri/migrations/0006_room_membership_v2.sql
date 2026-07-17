-- Membership v2: tombstones + LWW clock so leaving a room survives re-announce
-- union semantics, and cached display names so announces can materialize
-- members that aren't in the local roster yet.
ALTER TABLE room_members ADD COLUMN left_at INTEGER;
ALTER TABLE room_members ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE room_members ADD COLUMN display_name TEXT;
