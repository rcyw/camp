/** A worker holds a revocable Room capability, not a permanent user session.
 * Renewal keeps the secret stable because pending claim recovery derives its
 * run capability from it. An administrator must replace it after 90 days. */
export const WORKER_CREDENTIAL_LEASE_MS = 7 * 86400_000;
export const WORKER_CREDENTIAL_MAX_AGE_MS = 90 * 86400_000;

export function workerCredentialMetadata(row: { id: string; roomId: string; createdAt: Date; expiresAt: Date }) {
  return {
    schemaVersion: 1 as const,
    tokenId: row.id,
    roomId: row.roomId,
    expiresAt: row.expiresAt.toISOString(),
    renewUntil: new Date(row.createdAt.getTime() + WORKER_CREDENTIAL_MAX_AGE_MS).toISOString(),
  };
}
