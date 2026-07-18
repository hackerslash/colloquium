CREATE TABLE message_reactions (
  message_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  reacted_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, author_id, emoji)
);
CREATE INDEX idx_reactions_room ON message_reactions(room_id);
