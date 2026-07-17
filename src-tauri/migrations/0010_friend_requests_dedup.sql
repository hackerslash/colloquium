-- Two near-simultaneous friend-request messages (or a double-clicked "Add
-- friend") could each pass an app-level check-then-insert race and create two
-- pending rows for the same (from_id, direction). Collapse any that already
-- exist before adding the constraint that prevents new ones.
DELETE FROM friend_requests
WHERE status = 'pending'
  AND id NOT IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY from_id, direction
        ORDER BY created_at DESC, id DESC
      ) AS rn
      FROM friend_requests
      WHERE status = 'pending'
    )
    WHERE rn = 1
  );

CREATE UNIQUE INDEX idx_friend_requests_pending_unique
  ON friend_requests(from_id, direction)
  WHERE status = 'pending';
