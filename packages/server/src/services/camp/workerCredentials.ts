import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb } from "../../db/index";
import { campWorkerTokens } from "../../db/schema";
import { lockRoom } from "./rooms";
import { requireWorker } from "./runs";
import { CampError } from "./types";
import type { CampPrincipal } from "./types";
import { WORKER_CREDENTIAL_LEASE_MS, WORKER_CREDENTIAL_MAX_AGE_MS, workerCredentialMetadata } from "./workerCredentialPolicy";

/** Recheck under Room -> credential locks, matching administrative revocation.
 * Authentication before this transaction does not authorize resurrecting an
 * expired or revoked token. Retrying a lost response simply renews the same
 * capability; no alternate secret or successor can escape its revocation ID. */
export async function renewWorkerCredential(principal: CampPrincipal) {
  requireWorker(principal);
  if (principal.kind !== "worker") throw new CampError(403, "worker_scope_required", "This operation requires the trusted worker credential");
  return getDb().transaction(async tx => {
    await lockRoom(tx, principal.roomId);
    const [row] = await tx.update(campWorkerTokens).set({
      expiresAt: sql`least(clock_timestamp() + ${WORKER_CREDENTIAL_LEASE_MS} * interval '1 millisecond', ${campWorkerTokens.createdAt} + ${WORKER_CREDENTIAL_MAX_AGE_MS} * interval '1 millisecond')`,
    }).where(and(
      eq(campWorkerTokens.id, principal.tokenId), eq(campWorkerTokens.roomId, principal.roomId),
      isNull(campWorkerTokens.revokedAt), gt(campWorkerTokens.expiresAt, sql`clock_timestamp()`),
      gt(sql`${campWorkerTokens.createdAt} + ${WORKER_CREDENTIAL_MAX_AGE_MS} * interval '1 millisecond'`, sql`clock_timestamp()`),
    )).returning();
    if (!row) throw new CampError(401, "camp_auth_required", "The worker credential was revoked, expired or reached its renewal limit");
    return workerCredentialMetadata(row);
  });
}
