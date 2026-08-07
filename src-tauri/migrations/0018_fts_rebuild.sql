-- Repair FTS index after 0017 recreated `messages` without rebuilding it.
-- 0017 copied rows to `messages_new` (new rowids) but left `messages_fts` pointing
-- at the old rowids, so search would miss or mis-hit until rebuilt.

DELETE FROM messages_fts;
INSERT INTO messages_fts(rowid, body)
  SELECT rowid, body FROM messages WHERE body IS NOT NULL AND deleted_at IS NULL;
