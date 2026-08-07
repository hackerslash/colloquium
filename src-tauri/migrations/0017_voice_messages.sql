-- Voice messages: allow audio type + waveform/duration
-- Recreate messages to widen content_type CHECK; SQLite cannot ALTER CHECK.

PRAGMA foreign_keys=OFF;

DROP TRIGGER IF EXISTS messages_fts_ai;
DROP TRIGGER IF EXISTS messages_fts_ad;
DROP TRIGGER IF EXISTS messages_fts_au;

CREATE TABLE messages_new (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  author_seq INTEGER NOT NULL,
  hlc TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text' CHECK (content_type IN ('text', 'image', 'file', 'audio', 'system')),
  body TEXT,
  attachment_path TEXT,
  reply_to_id TEXT REFERENCES messages_new(id),
  sent_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  sig TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'sent' CHECK (delivery_status IN ('pending', 'sent', 'delivered', 'failed')),
  attachment_id TEXT,
  attachment_name TEXT,
  attachment_size INTEGER,
  attachment_type TEXT,
  read_at INTEGER,
  voice_duration INTEGER,
  voice_waveform TEXT
);

INSERT INTO messages_new (
  id, room_id, author_id, author_seq, hlc, content_type, body, attachment_path,
  reply_to_id, sent_at, edited_at, deleted_at, sig, delivery_status,
  attachment_id, attachment_name, attachment_size, attachment_type, read_at,
  voice_duration, voice_waveform
) SELECT
  id, room_id, author_id, author_seq, hlc, content_type, body, attachment_path,
  reply_to_id, sent_at, edited_at, deleted_at, sig, delivery_status,
  attachment_id, attachment_name, attachment_size, attachment_type, read_at,
  NULL, NULL
FROM messages;

DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;

CREATE UNIQUE INDEX idx_messages_author ON messages(room_id, author_id, author_seq);
CREATE INDEX idx_messages_room_time ON messages(room_id, sent_at);

-- Recreate FTS triggers
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages
WHEN new.body IS NOT NULL AND new.deleted_at IS NULL BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;

CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages
WHEN old.body IS NOT NULL AND old.deleted_at IS NULL BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;

CREATE TRIGGER messages_fts_au AFTER UPDATE OF body, deleted_at ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body)
    SELECT 'delete', old.rowid, old.body
     WHERE old.body IS NOT NULL AND old.deleted_at IS NULL;
  INSERT INTO messages_fts(rowid, body)
    SELECT new.rowid, new.body
     WHERE new.body IS NOT NULL AND new.deleted_at IS NULL;
END;

PRAGMA foreign_keys=ON;
