import { getDb } from "./client";

type PendingInviteRow = {
  token: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
  consumed_by: string | null;
};

export async function createPendingInvite(
  token: string,
  createdAt: number,
  expiresAt: number,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT INTO pending_invites (token, created_at, expires_at) VALUES ($1, $2, $3)",
    [token, createdAt, expiresAt],
  );
}

export async function getPendingInvite(token: string): Promise<PendingInviteRow | null> {
  const db = await getDb();
  const rows = await db.select<PendingInviteRow[]>(
    "SELECT * FROM pending_invites WHERE token = $1",
    [token],
  );
  return rows.length > 0 ? rows[0] : null;
}

export async function markConsumed(
  token: string,
  consumedBy: string,
  consumedAt: number,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE pending_invites SET consumed_at = $1, consumed_by = $2 WHERE token = $3",
    [consumedAt, consumedBy, token],
  );
}
