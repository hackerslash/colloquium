-- Repair FTS index after 0017 recreated `messages` without rebuilding it.
-- 0017 copied rows to `messages_new` (new rowids) but left `messages_fts` pointing
-- at the old rowids, so the external-content index is desynced from its content.
--
-- The obvious `DELETE FROM messages_fts` does NOT work here: on an external-content
-- FTS5 table that operation reads the content table to reconstruct the terms it
-- must remove, and when the stored index and the content disagree SQLite raises
-- SQLITE_CORRUPT_VTAB ("database disk image is malformed", code 267) — which aborts
-- the whole app at launch. Drop the index outright and recreate it from content;
-- that depends on nothing in the stale index, so it repairs any desynced state.
DROP TABLE IF EXISTS messages_fts;
CREATE VIRTUAL TABLE messages_fts USING fts5(
  body, content='messages', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2');

INSERT INTO messages_fts(rowid, body)
  SELECT rowid, body FROM messages WHERE body IS NOT NULL AND deleted_at IS NULL;
