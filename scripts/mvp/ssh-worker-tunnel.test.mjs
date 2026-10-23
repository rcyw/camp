import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSshWorkerTunnel, sshWorkerTunnelSpec, sshForwardPolicySpec, remoteRelaySource, shellQuote } from './ssh-worker-tunnel.mjs';

async function listen(host, handler = socket => socket.pipe(socket), port = 0) {
  const server = createServer(handler);
  server.listen({ host, port }); await once(server, 'listening');
  return server;
}
const closeServer = server => new Promise(resolveClose => server.close(resolveClose));
async function fixture({ wildcard = false, payload = null, policyPayload = null } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'camp-tunnel-test-'));
  const upstreamSockets = new Set();
  const upstream = await listen('127.0.0.1', socket => {
    upstreamSockets.add(socket); socket.once('close', () => upstreamSockets.delete(socket)); socket.pipe(socket);
  });
  const remotePort = upstream.address().port;
  await writeFile(join(folder, 'docker'), '#!/bin/sh\nprintf \'%s\\n\' \'[{"Gateway":"127.0.0.2"}]\'\n', { mode: 0o700 });
  await writeFile(join(folder, 'ss'), `#!/bin/sh\nprintf '%s\\n' 'LISTEN 0 128 ${wildcard ? '0.0.0.0' : '127.0.0.1'}:${remotePort} 0.0.0.0:*'\n`, { mode: 0o700 });
  const children = [], policyChildren = [], calls = [], signals = new EventEmitter();
  const options = {
    hostAlias: 'fixture-host', localApiPort: 13018, remotePort, heartbeatMs: 50, heartbeatTimeoutMs: 1000, readyTimeoutMs: 3000, stopTimeoutMs: 500, signals,
    spawnSsh(command, args, spawnOptions) {
      calls.push({ command, args, spawnOptions });
      const policy = !args.includes('-R');
      const source = policy ? policyPayload ?? `process.stdout.write(JSON.stringify({schemaVersion:1,type:'preflight',gatewayPorts:'no',useDns:'no'})+'\\n')` : payload ?? remoteRelaySource({ remotePort, heartbeatTimeoutMs: 1000 });
      const child = spawn(process.execPath, ['-e', source], { ...spawnOptions, env: { ...process.env, PATH: `${folder}:${process.env.PATH}` } });
      (policy ? policyChildren : children).push(child); return child;
    },
  };
  return { options, remotePort, children, policyChildren, calls, signals, upstreamSockets, async close() {
    for (const child of [...children, ...policyChildren]) {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    }
    for (const socket of upstreamSockets) socket.destroy();
    await closeServer(upstream); await rm(folder, { recursive: true, force: true });
  } };
}

test('strict aliases and numeric ports reject shell/option injection before spawning', async () => {
  let spawned = 0;
  for (const hostAlias of ['-oProxyCommand=evil', 'user@host', 'host;id', '$(id)', "host'", 'host\nvalue', 'host with-space', '', '../host']) {
    await assert.rejects(createSshWorkerTunnel({ hostAlias, spawnSsh: () => { spawned++; } }), { code: 'camp_tunnel_invalid_alias' });
  }
  for (const remotePort of [0, 22, 1023, 65536, '41318', 1.5, NaN]) assert.throws(() => sshWorkerTunnelSpec({ hostAlias: 'known-host', remotePort }), { code: 'camp_tunnel_invalid_port' });
  for (const localApiPort of [0, 65536, '13018', -1]) assert.throws(() => sshWorkerTunnelSpec({ hostAlias: 'known-host', localApiPort }), { code: 'camp_tunnel_invalid_port' });
  assert.equal(spawned, 0);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(createSshWorkerTunnel({ hostAlias: 'known-host', signal: aborted.signal, spawnSsh: () => { spawned++; } }), { name: 'AbortError' });
  assert.equal(spawned, 0);
});

test('remote code and shell literals survive quoting without executing substitutions', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-tunnel-quote-'));
  try {
    const marker = join(folder, 'unexpected');
    const value = `quotes' \" and $(touch ${marker}) \`touch ${marker}\`\nUnicode中文`;
    assert.equal(execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' }), value);
    await assert.rejects(access(marker), { code: 'ENOENT' });
    const spec = sshWorkerTunnelSpec({ hostAlias: 'known-alias' });
    assert.equal(spec.command, 'ssh'); assert.equal(spec.args.at(-2), 'known-alias');
    assert.equal(spec.args[spec.args.indexOf('-R') + 1], '127.0.0.1:41318:127.0.0.1:13018');
    for (const option of ['ExitOnForwardFailure=yes', 'StrictHostKeyChecking=yes', 'ForwardAgent=no', 'PermitLocalCommand=no', 'ControlPath=none']) assert(spec.args.includes(option));
    assert(!spec.args.includes('-A')); assert(!spec.args.includes('-N'));
    // A fake node only returns its -e argv, proving the complete serialized
    // program (including quotes/newlines) is one literal shell argument.
    const script = `node() { printf '%s' \"$2\"; }; ${spec.args.at(-1)}`;
    assert.equal(execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' }), spec.source);
    const policy = sshForwardPolicySpec({ hostAlias: 'known-alias' });
    assert(!policy.args.includes('-R')); assert(policy.args.includes('ClearAllForwardings=yes'));
    assert.equal(policy.args.at(-2), 'known-alias');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('one owned relay forwards bidirectionally on the bridge-only address and EOF drains every socket', async () => {
  const f = await fixture(); let tunnel, client;
  try {
    tunnel = await createSshWorkerTunnel(f.options);
    assert.equal(tunnel.apiUrl, `http://127.0.0.1:${f.remotePort}`);
    assert.deepEqual(tunnel.gatewayRelay, { host: '127.0.0.2', port: f.remotePort });
    assert.equal(tunnel.owner.localPid, f.children[0].pid); assert.equal(tunnel.owner.remotePid, f.children[0].pid);
    client = createConnection({ host: tunnel.gatewayRelay.host, port: f.remotePort }); await once(client, 'connect');
    client.write('an authenticated request would travel here');
    const [data] = await once(client, 'data'); assert.equal(String(data), 'an authenticated request would travel here');
    const clientClosed = once(client, 'close');
    const result = await tunnel.close(); await clientClosed;
    assert.equal(result.code, 0); assert.equal(result.reason, 'closed');
    assert.deepEqual(await tunnel.close(), result); assert.deepEqual(await tunnel.closed, result);
    assert.equal(f.signals.listenerCount('SIGTERM'), 0);
    const replacement = await listen('127.0.0.2', undefined, f.remotePort); await closeServer(replacement);
    assert.throws(() => process.kill(tunnel.owner.localPid, 0), { code: 'ESRCH' });
  } finally { client?.destroy(); await tunnel?.close(); await f.close(); }
});

for (const trigger of ['signal', 'abort', 'ssh_loss']) test(`${trigger} closes the exact owned process and preserves unrelated listeners`, async () => {
  const f = await fixture(), controller = new AbortController(); let tunnel;
  try {
    tunnel = await createSshWorkerTunnel({ ...f.options, signal: controller.signal });
    if (trigger === 'signal') f.signals.emit('SIGTERM');
    else if (trigger === 'abort') controller.abort();
    else f.children[0].kill('SIGKILL');
    const result = await tunnel.closed;
    assert.equal(result.reason, trigger === 'signal' ? 'SIGTERM' : trigger === 'abort' ? 'aborted' : 'ssh_exit');
    assert.throws(() => process.kill(tunnel.owner.localPid, 0), { code: 'ESRCH' });
    const unrelated = createConnection({ host: '127.0.0.1', port: f.remotePort }); await once(unrelated, 'connect'); unrelated.destroy();
    const replacement = await listen('127.0.0.2', undefined, f.remotePort); await closeServer(replacement);
    assert.equal(f.signals.listenerCount('SIGTERM'), 0);
  } finally { await tunnel?.close(); await f.close(); }
});

test('sshd wildcard forwarding is rejected before a relay is created', async () => {
  const f = await fixture({ wildcard: true });
  try {
    await assert.rejects(createSshWorkerTunnel(f.options), { code: 'camp_tunnel_start_failed' });
    assert.equal(f.children[0].exitCode, 1);
    const replacement = await listen('127.0.0.2', undefined, f.remotePort); await closeServer(replacement);
  } finally { await f.close(); }
});

test('unsafe or unreadable sshd policy is rejected before creating any reverse forward', async () => {
  for (const policyPayload of [
    `process.stdout.write(JSON.stringify({schemaVersion:1,type:'preflight',gatewayPorts:'yes',useDns:'no'})+'\\n')`,
    `process.stdout.write(JSON.stringify({schemaVersion:1,type:'preflight',gatewayPorts:'no',useDns:'yes'})+'\\n')`,
    `process.stderr.write('private_daemon_configuration');process.exitCode=1`,
  ]) {
    const f = await fixture({ policyPayload });
    try {
      await assert.rejects(createSshWorkerTunnel(f.options), error => ['camp_tunnel_policy_unsafe', 'camp_tunnel_policy_failed'].includes(error.code) && !error.message.includes('private_'));
      assert.equal(f.calls.length, 1); assert(!f.calls[0].args.includes('-R')); assert.equal(f.children.length, 0);
      assert.equal(f.signals.listenerCount('SIGTERM'), 0);
    } finally { await f.close(); }
  }
});

for (const trigger of ['timeout', 'signal', 'abort']) test(`policy preflight ${trigger} stops its owned SSH before any forwarding session`, async () => {
  const f = await fixture({ policyPayload: "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)" });
  const controller = new AbortController();
  let timer;
  try {
    const opening = createSshWorkerTunnel({ ...f.options, signal: controller.signal, readyTimeoutMs: 150, stopTimeoutMs: 40 });
    if (trigger !== 'timeout') timer = setTimeout(() => trigger === 'signal' ? f.signals.emit('SIGTERM') : controller.abort(), 80);
    await assert.rejects(opening, { code: trigger === 'timeout' ? 'camp_tunnel_policy_timeout' : 'camp_tunnel_aborted' });
    assert.equal(f.calls.length, 1); assert.equal(f.children.length, 0);
    assert.throws(() => process.kill(f.policyChildren[0].pid, 0), { code: 'ESRCH' });
    assert.equal(f.signals.listenerCount('SIGTERM'), 0);
  } finally { clearTimeout(timer); await f.close(); }
});

test('a relay port conflict fails without removing the existing listener', async () => {
  const f = await fixture();
  const occupied = await listen('127.0.0.2', undefined, f.remotePort);
  try {
    await assert.rejects(createSshWorkerTunnel(f.options), { code: 'camp_tunnel_start_failed' });
    assert.equal(occupied.listening, true); assert.equal(f.children[0].exitCode, 1);
  } finally { await closeServer(occupied); await f.close(); }
});

test('startup timeout escalates only its unresponsive child, with fixed errors and no SSH stderr', async () => {
  const f = await fixture({ payload: "process.stderr.write('private_credential_must_not_escape');process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000)" });
  try {
    await assert.rejects(createSshWorkerTunnel({ ...f.options, readyTimeoutMs: 100, stopTimeoutMs: 40 }), error => error.code === 'camp_tunnel_start_timeout' && !error.message.includes('private_credential'));
    assert.equal(f.children[0].signalCode, 'SIGKILL');
    assert.throws(() => process.kill(f.children[0].pid, 0), { code: 'ESRCH' });
  } finally { await f.close(); }
});

test('malformed readiness never exposes output or SSH diagnostics and leaves no child', async () => {
  const f = await fixture({ payload: "process.stdout.write('private_secret_not_json\\n');process.stderr.write('private_ssh_diagnostic');process.stdin.resume();" });
  try {
    await assert.rejects(createSshWorkerTunnel(f.options), error => error.code === 'camp_tunnel_invalid_ready' && !error.message.includes('private_'));
    assert.throws(() => process.kill(f.children[0].pid, 0), { code: 'ESRCH' });
  } finally { await f.close(); }
});

test('remote watchdog exits when SSH stdin remains open without heartbeat data', async () => {
  const f = await fixture(); let child;
  try {
    child = f.options.spawnSsh('ssh', ['-R'], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const [ready] = await once(child.stdout, 'data'); assert.equal(JSON.parse(String(ready)).type, 'ready');
    const [code, signal] = await once(child, 'exit'); assert.equal(code, 0); assert.equal(signal, null);
    const replacement = await listen('127.0.0.2', undefined, f.remotePort); await closeServer(replacement);
  } finally { if (child && child.exitCode === null) child.kill('SIGKILL'); await f.close(); }
});
