-- Local-only: whether the user has compared safety numbers with this contact
-- out of band. Deliberately absent from RosterEntryWire — a peer gossiping
-- "verified" at you is exactly the attack safety numbers exist to stop.
ALTER TABLE roster ADD COLUMN verified_at INTEGER;
