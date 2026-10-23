import assert from "node:assert/strict";
import { apiTest } from "../test/integration/apiTest";

apiTest("Camp worker credential renewal keeps Room scope and rejects model credentials and extra authority", async ({ seed, http, app }) => {
  const owner = await seed.human(), server = await seed.server({ owner }), channel = await seed.channel({ server, members: [owner] });
  const user = http.as(owner, server);
  const create = await user.request("/api/camp/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelId: channel.id, name: "Credential room", project: { name: "demo" } }) });
  assert.equal(create.status, 201, await create.clone().text()); const room = await create.json() as { id: string };
  const issued = await user.request(`/api/camp/rooms/${room.id}/worker-token`, { method: "POST" });
  assert.equal(issued.status, 201); const token = await issued.json() as { token: string; tokenId: string; renewUntil: string };
  const request = (credential: string, body: unknown = {}) => fetch(`${app.baseUrl}/api/camp/worker/credential/renew`, { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const renewed = await request(token.token); assert.equal(renewed.status, 200, await renewed.clone().text());
  const metadata = await renewed.json() as { roomId: string; tokenId: string; renewUntil: string; token?: string };
  assert.equal(metadata.roomId, room.id); assert.equal(metadata.tokenId, token.tokenId); assert.equal(metadata.renewUntil, token.renewUntil); assert.equal(metadata.token, undefined);
  assert.equal((await request(token.token, { roomId: "other-room" })).status, 400);
  const pipeline = await user.request(`/api/camp/rooms/${room.id}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Credential scope", workflow: "legacy" }) }); assert.equal(pipeline.status, 201);
  const claim = await fetch(`${app.baseUrl}/api/camp/worker/claim`, { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" }, body: JSON.stringify({ workerId: "credential-test" }) });
  assert.equal(claim.status, 200); const value = await claim.json() as { run: { runToken: string } };
  assert.equal((await request(value.run.runToken)).status, 403);
  const revoked = await user.request(`/api/camp/rooms/${room.id}/worker-tokens/${token.tokenId}/revoke`, { method: "POST" }); assert.equal(revoked.status, 200);
  assert.equal((await request(token.token)).status, 401);
});
