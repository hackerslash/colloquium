-- No FK to messages: a pin can arrive before the message it points at, same
-- as message_reactions.
CREATE TABLE message_pins (
  message_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  pinned_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, author_id)
);
CREATE INDEX idx_pins_room ON message_pins(room_id);
