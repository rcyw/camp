// Creates an isolated, dependency-free demo in the existing local dev service.
// Credentials stay in ignored .camp files; no existing channels are changed.
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const api = process.env.CAMP_API_URL ?? 'http://127.0.0.1:13018';
const web = process.env.CAMP_WEB_URL ?? 'http://localhost:15190';
const seed = JSON.parse(await readFile(resolve(root, '.dev-env-camp.json'), 'utf8'));
let accessToken;
async function request(path, body) {
  const response = await fetch(`${api}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}`, 'x-server-id': seed.server.id } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Demo setup failed at ${path}: HTTP ${response.status} (${data.code ?? data.error ?? 'request failed'})`);
  return data;
}
accessToken = (await request('/auth/login', { email: seed.user.email, password: seed.user.password })).accessToken;
if (!accessToken) throw new Error('Login did not return an access token');
const stamp = Date.now().toString(36);
const name = `camp-mvp-${stamp}`;
const sourcePath = resolve(root, '.camp/examples', name);
await mkdir(resolve(sourcePath, 'src'), { recursive: true });
await mkdir(resolve(sourcePath, 'test'), { recursive: true });
await writeFile(resolve(sourcePath, 'package.json'), JSON.stringify({ name, private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
await writeFile(resolve(sourcePath, 'src/math.mjs'), 'export function add(a, b) { return a - b; }\n');
await writeFile(resolve(sourcePath, 'test/math.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.mjs';\ntest('add handles positive, negative and zero operands', () => {\n  assert.equal(add(2, 3), 5);\n  assert.equal(add(-2, 3), 1);\n  assert.equal(add(0, 4), 4);\n});\n");
const createdChannel = await request('/channels/', { name, description: 'Camp real DSH + LayerFS MVP verification', visibility: 'public' });
const channel = createdChannel.channel ?? createdChannel;
if (!channel.id) throw new Error('Channel create did not return an ID');
const room = await request('/camp/rooms', { channelId: channel.id, name, project: { name, repoPath: sourcePath, baseRef: 'main' } });
const worker = await request(`/camp/rooms/${room.id}/worker-token`, {});
await mkdir(resolve(root, '.camp'), { recursive: true });
const workerEnvPath = resolve(root, '.camp/mvp-worker.env');
await writeFile(workerEnvPath, `CAMP_API_URL=${api}\nCAMP_WORKER_TOKEN=${worker.token}\nCAMP_WORKER_ID=${name}\nCAMP_WORKER_ONCE=1\n`, { mode: 0o600 });
await chmod(workerEnvPath, 0o600);
const goal = 'Fix add(a, b) in src/math.mjs to return the sum of both operands, preserving its exported API and the existing tests. Use node --test to verify the result. The planner should inspect the repository and describe a concrete plan without implementing it. The builder should implement and test the change. The reviewer should independently inspect the builder candidate and run the tests; report an evidence-based review verdict. Do not publish or change the main branch.';
const state = process.argv.includes('--skip-submit') ? { tasks: [] } : await request(`/camp/rooms/${room.id}/tasks`, { title: 'Fix addition and verify the candidate independently', description: goal });
const receipt = { createdAt: new Date().toISOString(), apiUrl: api, webUrl: `${web}/s/${seed.server.slug}/channel/${channel.id}`, channelId: channel.id, roomId: room.id, projectName: name, sourcePath, workerId: name, workerTokenId: worker.tokenId, taskIds: state.tasks.map(task => task.id), goal };
await writeFile(resolve(root, '.camp/mvp-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ event: 'demo_prepared', ...receipt, workerEnvPath }, null, 2));
