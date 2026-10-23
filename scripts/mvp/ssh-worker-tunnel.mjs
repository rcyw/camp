import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { superviseOwnedChild } from './owned-child.mjs';

const failure = code => Object.assign(new Error(code), { code });
const port = (value, minimum) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > 65535) throw failure('camp_tunnel_invalid_port');
  return value;
};
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

/** Read the effective sshd policy before creating any reverse listener. Host
 * Match rules with reverse DNS are deliberately unsupported rather than
 * guessed. Operators must use the default sshd config, without command-line
 * policy overrides, on this trusted test host. */
export async function remoteForwardPolicyMain() {
  const { execFileSync } = await import('node:child_process');
  const { isIP: validIp } = await import('node:net');
  const { userInfo } = await import('node:os');
  const fields = (process.env.SSH_CONNECTION ?? '').split(' ');
  if (fields.length !== 4 || !validIp(fields[0]) || !validIp(fields[2]) || ![fields[1], fields[3]].every(value => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535)) throw new Error('ssh_context_unavailable');
  const user = userInfo().username;
  if (!/^[A-Za-z0-9_.-]+$/.test(user)) throw new Error('ssh_context_unavailable');
  const parse = value => Object.fromEntries(value.trim().split('\n').map(line => { const at = line.indexOf(' '); return [line.slice(0, at), line.slice(at + 1)]; }));
  const inspect = args => parse(execFileSync('/usr/sbin/sshd', ['-T', ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  if (inspect([]).usedns !== 'no') throw new Error('ssh_context_unavailable');
  const context = `user=${user},addr=${fields[0]},host=${fields[0]},laddr=${fields[2]},lport=${fields[3]}`;
  const policy = inspect(['-C', context]);
  if (!['no', 'clientspecified'].includes(policy.gatewayports) || !['yes', 'remote'].includes(policy.allowtcpforwarding) || policy.disableforwarding !== 'no' || policy.usedns !== 'no') throw new Error('forward_policy_unsafe');
  process.stdout.write(JSON.stringify({ schemaVersion: 1, type: 'preflight', gatewayPorts: policy.gatewayports, useDns: 'no' }) + '\n');
}

/** Self-contained: serialized into the SSH command, never written remotely. */
export async function remoteRelayMain(config) {
  const { execFileSync } = await import('node:child_process');
  const { createServer, connect, isIP: validIp } = await import('node:net');
  if (!Number.isSafeInteger(config.port) || config.port < 1024 || config.port > 65535 || !Number.isSafeInteger(config.heartbeatTimeoutMs) || config.heartbeatTimeoutMs < 1000 || config.heartbeatTimeoutMs > 60000) throw new Error('invalid_configuration');
  const sockets = new Set();
  let server, closing = false, lastPing = Date.now(), finish;
  const ended = new Promise(resolveEnd => { finish = resolveEnd; });
  const stop = () => {
    if (closing) return;
    closing = true;
    for (const socket of sockets) socket.destroy();
    if (server?.listening) server.close(finish); else finish();
  };
  const onData = () => { lastPing = Date.now(); };
  process.stdin.on('data', onData);
  process.stdin.on('end', stop);
  process.stdin.on('error', stop);
  process.stdin.resume();
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  for (const name of signals) process.on(name, stop);
  const watchdog = setInterval(() => { if (Date.now() - lastPing > config.heartbeatTimeoutMs) stop(); }, Math.min(1000, config.heartbeatTimeoutMs / 2));
  try {
    const ipam = JSON.parse(execFileSync('docker', ['network', 'inspect', 'bridge', '--format', '{{json .IPAM.Config}}'], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] }));
    if (!Array.isArray(ipam)) throw new Error('bridge_unavailable');
    const gateways = [...new Set(ipam.map(item => item.Gateway).filter(value => validIp(value) === 4 && value !== '0.0.0.0' && value !== '127.0.0.1'))];
    if (gateways.length !== 1) throw new Error('bridge_unavailable');
    const gateway = gateways[0];
    // sshd GatewayPorts=yes may override a requested loopback bind. Refuse
    // that configuration rather than expose the API through a wildcard.
    const listening = execFileSync('ss', ['-H', '-ltn'], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').map(line => line.trim().split(/\s+/)[3]).filter(Boolean).filter(address => address.endsWith(`:${config.port}`));
    if (!listening.length || listening.some(address => address !== `127.0.0.1:${config.port}`)) throw new Error('forward_bind_unsafe');
    if (closing) return;
    server = createServer(socket => {
      if (closing || sockets.size >= 256) { socket.destroy(); return; }
      const upstream = connect({ host: '127.0.0.1', port: config.port });
      const destroy = () => { socket.destroy(); upstream.destroy(); };
      for (const stream of [socket, upstream]) {
        sockets.add(stream);
        stream.setTimeout(60000, destroy);
        stream.on('error', destroy);
        stream.on('close', () => { sockets.delete(stream); destroy(); });
      }
      socket.pipe(upstream); upstream.pipe(socket);
    });
    await new Promise((resolveListen, reject) => {
      const onError = error => { server.off('listening', resolveListen); reject(error); };
      server.once('error', onError);
      server.once('listening', () => { server.off('error', onError); resolveListen(); });
      server.listen({ host: gateway, port: config.port, exclusive: true });
    });
    server.on('error', stop);
    if (closing) { server.close(); return; }
    process.stdout.write(JSON.stringify({ schemaVersion: 1, type: 'ready', gateway, port: config.port, remotePid: process.pid }) + '\n');
    await ended;
  } finally {
    clearInterval(watchdog);
    stop();
    for (const socket of sockets) socket.destroy();
    for (const name of signals) process.off(name, stop);
    process.stdin.off('data', onData); process.stdin.off('end', stop); process.stdin.off('error', stop);
    process.stdin.destroy();
  }
}

export function remoteRelaySource({ remotePort, heartbeatTimeoutMs = 20000 }) {
  port(remotePort, 1024);
  if (!Number.isSafeInteger(heartbeatTimeoutMs) || heartbeatTimeoutMs < 1000 || heartbeatTimeoutMs > 60000) throw failure('camp_tunnel_invalid_timeout');
  return `(${remoteRelayMain.toString()})(${JSON.stringify({ port: remotePort, heartbeatTimeoutMs })}).catch(() => { process.stderr.write('camp_tunnel_remote_failed\\n'); process.exitCode = 1; });`;
}

export function sshWorkerTunnelSpec({ hostAlias, localApiPort = 13018, remotePort = 41318, heartbeatTimeoutMs = 20000 } = {}) {
  if (typeof hostAlias !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(hostAlias)) throw failure('camp_tunnel_invalid_alias');
  port(localApiPort, 1); port(remotePort, 1024);
  const source = remoteRelaySource({ remotePort, heartbeatTimeoutMs });
  const remoteCommand = `node -e ${shellQuote(source)}`;
  return {
    command: 'ssh',
    args: ['-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '-o', 'ForwardAgent=no', '-o', 'PermitLocalCommand=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'RemoteCommand=none', '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3', '-o', 'LogLevel=ERROR', '-R', `127.0.0.1:${remotePort}:127.0.0.1:${localApiPort}`, hostAlias, remoteCommand],
    source, hostAlias, remotePort, apiUrl: `http://127.0.0.1:${remotePort}`,
  };
}

export function sshForwardPolicySpec(options) {
  const spec = sshWorkerTunnelSpec(options), args = [...spec.args];
  args.splice(args.indexOf('-R'), 2);
  args[args.length - 1] = `node -e ${shellQuote(`(${remoteForwardPolicyMain.toString()})().catch(() => { process.stderr.write('camp_tunnel_policy_failed\\n'); process.exitCode = 1; });`)}`;
  // Config-file forwards must not run during the read-only policy session.
  args.unshift('-o', 'ClearAllForwardings=yes');
  return { command: spec.command, args };
}

async function inspectForwardPolicy(options, { readyTimeoutMs, stopTimeoutMs }) {
  const spec = sshForwardPolicySpec(options);
  const child = (options.spawnSsh ?? spawn)(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true });
  const owned = superviseOwnedChild(child);
  const signals = options.signals ?? process;
  let output = '', failureCode, stopping, finishStopped;
  const stopped = new Promise(resolveStop => { finishStopped = resolveStop; });
  const closed = new Promise(resolveClose => child.once('close', resolveClose));
  function stop(code) {
    failureCode ??= code;
    stopping ??= owned.stop({ graceMs: stopTimeoutMs, killMs: stopTimeoutMs }).catch(() => { failureCode = 'camp_tunnel_stop_failed'; }).finally(() => { child.stdout.destroy(); child.stderr.destroy(); finishStopped(); });
  }
  const onAbort = () => stop('camp_tunnel_aborted');
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(name => [name, () => stop('camp_tunnel_aborted')]);
  const timer = setTimeout(() => stop('camp_tunnel_policy_timeout'), readyTimeoutMs);
  child.stdout.on('data', bytes => { output += bytes.toString('utf8'); if (Buffer.byteLength(output) > 8192) stop('camp_tunnel_policy_invalid'); });
  child.stderr.resume(); child.stdin.on('error', () => {}); child.stdin.end();
  for (const [name, handler] of handlers) signals.on(name, handler);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  try {
    await Promise.race([closed, stopped]);
    if (stopping) await stopping;
    const result = await owned.exited;
    if (failureCode) throw failure(failureCode);
    if (result.code !== 0 || result.signal || result.error) throw failure('camp_tunnel_policy_failed');
    let policy;
    try { policy = JSON.parse(output); } catch { throw failure('camp_tunnel_policy_invalid'); }
    if (Object.keys(policy).sort().join(',') !== 'gatewayPorts,schemaVersion,type,useDns' || policy.schemaVersion !== 1 || policy.type !== 'preflight' || !['no', 'clientspecified'].includes(policy.gatewayPorts) || policy.useDns !== 'no') throw failure('camp_tunnel_policy_unsafe');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    for (const [name, handler] of handlers) signals.off(name, handler);
    await owned.stop({ graceMs: stopTimeoutMs, killMs: stopTimeoutMs });
  }
}

/** The owner must await .closed or call .close() in finally. No credential is
 * passed to SSH or the relay. Only the authenticated API protocol crosses it. */
export async function createSshWorkerTunnel(options = {}) {
  const spec = sshWorkerTunnelSpec(options);
  const readyTimeoutMs = options.readyTimeoutMs ?? 15000, heartbeatMs = options.heartbeatMs ?? 5000, stopTimeoutMs = options.stopTimeoutMs ?? 2000;
  if (![readyTimeoutMs, heartbeatMs, stopTimeoutMs].every(value => Number.isSafeInteger(value) && value >= 20 && value <= 60000) || heartbeatMs >= (options.heartbeatTimeoutMs ?? 20000)) throw failure('camp_tunnel_invalid_timeout');
  options.signal?.throwIfAborted();
  await inspectForwardPolicy(options, { readyTimeoutMs, stopTimeoutMs });
  options.signal?.throwIfAborted();
  const child = (options.spawnSsh ?? spawn)(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true });
  let result, stopping, heartbeat, timeout, ready, rejectReady, buffer = '', received = false, closeReason = null;
  const readiness = new Promise((resolveReady, reject) => { ready = resolveReady; rejectReady = reject; });
  let resolveClosed;
  const closed = new Promise(resolveExit => { resolveClosed = resolveExit; });
  const signals = options.signals ?? process;
  const signalNames = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const signalHandlers = signalNames.map(name => [name, () => { void close(name).catch(() => {}); }]);
  const onAbort = () => { rejectReady(failure('camp_tunnel_aborted')); void close('aborted').catch(() => {}); };
  function cleanup() {
    clearInterval(heartbeat); clearTimeout(timeout);
    for (const [name, handler] of signalHandlers) signals.off(name, handler);
    options.signal?.removeEventListener('abort', onAbort);
  }
  function exited(code, signal) {
    if (result) return;
    result = { code, signal, reason: closeReason ?? 'ssh_exit' };
    cleanup(); resolveClosed(result);
    if (!received) rejectReady(failure('camp_tunnel_start_failed'));
  }
  child.once('error', () => exited(null, null));
  child.once('exit', exited);
  child.stderr.resume(); // Never retain or print SSH diagnostics/configuration.
  child.stdin.on('error', () => { void close('stdin_error').catch(() => {}); });
  function terminate(name) {
    if (result || !Number.isSafeInteger(child.pid) || child.pid <= 0) return;
    try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw failure('camp_tunnel_stop_failed'); }
  }
  async function waitForExit() {
    let timer;
    try { return await Promise.race([closed.then(() => true), new Promise(resolveWait => { timer = setTimeout(() => resolveWait(false), stopTimeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  async function stop(reason) {
    closeReason = reason; clearInterval(heartbeat);
    if (result) return result;
    child.stdin.end();
    if (await waitForExit()) return result;
    terminate('SIGTERM'); if (await waitForExit()) return result;
    terminate('SIGKILL'); if (await waitForExit()) return result;
    throw failure('camp_tunnel_stop_failed');
  }
  function close(reason = 'closed') { return stopping ??= stop(reason); }
  child.stdout.on('data', bytes => {
    if (received) { rejectReady(failure('camp_tunnel_invalid_ready')); void close('invalid_output').catch(() => {}); return; }
    buffer += bytes.toString('utf8');
    if (Buffer.byteLength(buffer) > 8192) { rejectReady(failure('camp_tunnel_invalid_ready')); void close('invalid_output').catch(() => {}); return; }
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    try {
      if (buffer.slice(newline + 1)) throw new Error('Extra output');
      const value = JSON.parse(buffer.slice(0, newline));
      if (Object.keys(value).sort().join(',') !== 'gateway,port,remotePid,schemaVersion,type' || value.schemaVersion !== 1 || value.type !== 'ready' || isIP(value.gateway) !== 4 || ['0.0.0.0', '127.0.0.1'].includes(value.gateway) || value.port !== spec.remotePort || !Number.isSafeInteger(value.remotePid) || value.remotePid <= 0) throw new Error('Invalid readiness');
      received = true; clearTimeout(timeout); ready(value);
    } catch { rejectReady(failure('camp_tunnel_invalid_ready')); void close('invalid_output').catch(() => {}); }
  });
  for (const [name, handler] of signalHandlers) signals.on(name, handler);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  heartbeat = setInterval(() => { if (!result && !child.stdin.destroyed) child.stdin.write('camp-tunnel-ping\n'); }, heartbeatMs);
  timeout = setTimeout(() => { rejectReady(failure('camp_tunnel_start_timeout')); }, readyTimeoutMs);
  try {
    const value = await readiness;
    return { apiUrl: spec.apiUrl, gatewayRelay: { host: value.gateway, port: value.port }, owner: { hostAlias: spec.hostAlias, localPid: child.pid, remotePid: value.remotePid }, closed, close };
  } catch (error) { await close('startup_failed'); throw error; }
}

export async function sshWorkerTunnelMain(args = process.argv.slice(2)) {
  const options = {}, flags = { '--host': 'hostAlias', '--local-api-port': 'localApiPort', '--remote-port': 'remotePort' };
  for (let index = 0; index < args.length; index += 2) {
    const name = flags[args[index]], value = args[index + 1];
    if (!name || value === undefined || options[name] !== undefined) throw failure('camp_tunnel_invalid_arguments');
    options[name] = name === 'hostAlias' ? value : /^\d+$/.test(value) ? Number(value) : NaN;
  }
  const tunnel = await createSshWorkerTunnel(options);
  const onEnd = () => { void tunnel.close('stdin_eof'); };
  process.stdin.once('end', onEnd); process.stdin.resume();
  try {
    process.stdout.write(JSON.stringify({ schemaVersion: 1, type: 'ready', apiUrl: tunnel.apiUrl, gatewayRelay: tunnel.gatewayRelay, owner: tunnel.owner }) + '\n');
    const result = await tunnel.closed;
    if (!['closed', 'stdin_eof', 'SIGINT', 'SIGTERM', 'SIGHUP'].includes(result.reason)) throw failure('camp_tunnel_connection_lost');
  } finally { process.stdin.off('end', onEnd); process.stdin.pause(); await tunnel.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) sshWorkerTunnelMain().catch(error => { console.error(/^camp_tunnel_[a-z_]+$/.test(error?.code) ? error.code : 'camp_tunnel_failed'); process.exitCode = 1; });
