import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq, sql } from "drizzle-orm";
import { test } from "vitest";
import * as schema from "../../db/schema";
import { closeDatabase, getDb, initDatabase } from "../../db/index";
import { createServer } from "../serverService";
import { addHuman, createChannel } from "../channelService";
import { createRoom, mintWorkerToken, revokeWorkerToken } from "./rooms";
import { authenticateCampToken } from "./runs";
import { renewWorkerCredential } from "./workerCredentials";
import { WORKER_CREDENTIAL_LEASE_MS, WORKER_CREDENTIAL_MAX_AGE_MS } from "./workerCredentialPolicy";

const url = process.env.CAMP_REAL_PG_URL, required = process.env.CAMP_REAL_PG_REQUIRED === "1";
test("real PostgreSQL bounds credential renewal and serializes concurrent renewal with permanent administrative revocation", { skip: !(url || required), timeout: 120000 }, async () => {
  assert.ok(url, "CAMP_REAL_PG_URL required");
  const name = `camp_credentials_${randomUUID().replaceAll("-", "")}`, admin = new pg.Client({ connectionString: url });
  await admin.connect(); let initialized = false;
  const connection = new URL(url); connection.pathname = `/${name}`;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    const pool = new pg.Pool({ connectionString: connection.toString() });
    try { await migrate(drizzle(pool, { schema }), { migrationsFolder: fileURLToPath(new URL("../../../drizzle", import.meta.url)) }); } finally { await pool.end(); }
    await initDatabase(connection.toString()); initialized = true; const db = getDb();
    const [owner] = await db.insert(schema.users).values({ name: "credential-owner", email: `${name}@test.invalid`, passwordHash: "test-only", emailVerified: true }).returning();
    const server = await createServer("Credential fixture", name, owner.id), channel = await createChannel(server.id, "credential-test"); await addHuman(channel.id, owner.id);
    const room = await createRoom(server.id, owner.id, { channelId: channel.id, name: "Credentials", project: { name: "fixture" } });
    const token = await mintWorkerToken(room.id, owner.id), principal = await authenticateCampToken(token.token);
    const [original] = await db.select().from(schema.campWorkerTokens).where(eq(schema.campWorkerTokens.id, token.tokenId));
    assert.equal(token.schemaVersion, 1);
    assert.ok(Math.abs(original.expiresAt.getTime() - original.createdAt.getTime() - WORKER_CREDENTIAL_LEASE_MS) < 1000);
    assert.equal(Date.parse(token.renewUntil) - original.createdAt.getTime(), WORKER_CREDENTIAL_MAX_AGE_MS);
    await db.update(schema.campWorkerTokens).set({ expiresAt: sql`clock_timestamp() + interval '1 day'` }).where(eq(schema.campWorkerTokens.id, token.tokenId));
    const renewals = await Promise.all([renewWorkerCredential(principal), renewWorkerCredential(principal)]);
    assert.ok(renewals.every(value => value.tokenId === token.tokenId && value.roomId === room.id && !Object.hasOwn(value, "token")));
    const [renewed] = await db.select().from(schema.campWorkerTokens).where(eq(schema.campWorkerTokens.id, token.tokenId));
    assert.ok(renewed.expiresAt.getTime() - Date.now() > WORKER_CREDENTIAL_LEASE_MS - 1000);
    assert.equal(renewed.tokenHash, original.tokenHash, "A retry and concurrent lanes keep exact Run recovery credentials");
    await assert.rejects(renewWorkerCredential({ kind: "run", roomId: room.id, runId: randomUUID(), epoch: 1 }), { status: 403 });
    await assert.rejects(renewWorkerCredential({ kind: "worker", roomId: room.id, tokenId: randomUUID() }), { status: 401 });

    await db.update(schema.campWorkerTokens).set({ createdAt: sql`clock_timestamp() - interval '89 days'`, expiresAt: sql`clock_timestamp() + interval '2 days'` }).where(eq(schema.campWorkerTokens.id, token.tokenId));
    const capped = await renewWorkerCredential(principal);
    assert.equal(capped.expiresAt, capped.renewUntil, "The final lease never exceeds the original issuance's absolute deadline");
    await db.update(schema.campWorkerTokens).set({ createdAt: sql`clock_timestamp() - interval '91 days'` }).where(eq(schema.campWorkerTokens.id, token.tokenId));
    await assert.rejects(renewWorkerCredential(principal), { status: 401 });

    const expired = await mintWorkerToken(room.id, owner.id), expiredPrincipal = await authenticateCampToken(expired.token);
    await db.update(schema.campWorkerTokens).set({ expiresAt: sql`clock_timestamp() - interval '1 millisecond'` }).where(eq(schema.campWorkerTokens.id, expired.tokenId));
    await assert.rejects(renewWorkerCredential(expiredPrincipal), { status: 401 });
    await assert.rejects(authenticateCampToken(expired.token), { status: 401 });

    const raced = await mintWorkerToken(room.id, owner.id), racedPrincipal = await authenticateCampToken(raced.token);
    const locker = new pg.Client({ connectionString: connection.toString() }); await locker.connect();
    let racedOutcomes;
    try {
      await locker.query("BEGIN"); await locker.query("SELECT id FROM camp_rooms WHERE id=$1 FOR UPDATE", [room.id]);
      racedOutcomes = Promise.allSettled([renewWorkerCredential(racedPrincipal), revokeWorkerToken(room.id, raced.tokenId, owner.id), renewWorkerCredential(racedPrincipal)]);
      let blocked = false;
      for (let poll = 0; poll < 100; poll++) {
        const rows = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'", [name]);
        if (rows.rows[0].count >= 3) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(blocked, true, "All three transactions must be in flight at the shared Room fence");
    } finally { await locker.query("COMMIT"); await locker.end(); }
    const outcomes = await racedOutcomes;
    assert.ok(outcomes);
    assert.equal(outcomes[1].status, "fulfilled");
    await assert.rejects(authenticateCampToken(raced.token), { status: 401 });
    await assert.rejects(renewWorkerCredential(racedPrincipal), { status: 401 }, "A principal authenticated before revocation cannot resurrect the credential");
    const [revoked] = await db.select().from(schema.campWorkerTokens).where(eq(schema.campWorkerTokens.id, raced.tokenId));
    assert.ok(revoked.revokedAt);
    assert.equal((await db.select().from(schema.campWorkerTokens)).length, 3, "Renewal never creates an unrevokable successor token");
  } finally { if (initialized) await closeDatabase(); await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end(); }
});
