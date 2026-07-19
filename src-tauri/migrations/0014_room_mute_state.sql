-- Per-room notification mute. Keyed by room_id (covers both DM and group
-- rooms, unlike room_members.notifications_muted which only exists for
-- groups). A row's presence means muted; muted_at records when it was set.
-- Muted rooms suppress OS notifications, sounds, and dock-badge contribution
-- unless a message @-mentions the local user.
CREATE TABLE room_mute_state (
  room_id TEXT PRIMARY KEY,
  muted_at INTEGER NOT NULL
);
