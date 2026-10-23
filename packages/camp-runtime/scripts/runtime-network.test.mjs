import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CampRuntime } from '../src/index.mjs';

test('each Worker deployment selects one explicit local Docker authority', () => {
  assert.equal(new CampRuntime({ env: {} }).docker, '/var/run/docker.sock');
  assert.equal(new CampRuntime({ env: { CAMP_DOCKER_SOCKET: '/private/target/docker.sock' } }).docker, '/private/target/docker.sock');
  assert.equal(new CampRuntime({ docker: '/explicit.sock', env: { CAMP_DOCKER_SOCKET: '/ignored.sock' } }).docker, '/explicit.sock');
  for (const value of ['relative.sock', 'tcp://other-host:2375', '/tmp/bad\nsocket']) assert.throws(() => new CampRuntime({ env: { CAMP_DOCKER_SOCKET: value } }), /absolute local Unix socket/);
});

test('remote Camp API identity is independent from the local model proxy bind address', async () => {
  const runtime = new CampRuntime(), calls = [];
  runtime.dockerCall = async args => { calls.push(args); return { stdout: JSON.stringify({ bridge: { Gateway: '172.18.0.1' } }) }; };
  const run = { containerId: 'owned-container' };
  assert.equal(await runtime.sandboxApiUrl(run, 'https://camp.example.invalid:8443'), 'https://camp.example.invalid:8443');
  assert.equal(calls.length, 0, 'A remote API origin must not be rewritten or bound locally');
  assert.equal(await runtime.sandboxHostAddress(run), '172.18.0.1');
  assert.equal(await runtime.sandboxApiUrl(run, 'http://127.0.0.1:13018'), 'http://172.18.0.1:13018');
  assert.ok(calls.every(args => args.at(-1) === run.containerId));
});

test('missing or conflicting sandbox gateways fail closed before starting a model proxy', async () => {
  const runtime = new CampRuntime();
  for (const networks of [{}, { one: { Gateway: '172.18.0.1' }, two: { Gateway: '172.19.0.1' } }]) {
    runtime.dockerCall = async () => ({ stdout: JSON.stringify(networks) });
    await assert.rejects(runtime.sandboxHostAddress({ containerId: 'owned-container' }), /unambiguous host gateway/);
  }
});
