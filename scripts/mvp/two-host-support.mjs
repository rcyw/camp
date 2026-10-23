import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function checkedAlias(value) {
  if (typeof value !== 'string' || !/^(?:[a-z_][a-z0-9_-]*@)?[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new Error('CAMP_REMOTE_SSH must be a plain SSH alias, optionally user@alias');
  return value;
}
export function checkedPath(value) {
  if (typeof value !== 'string' || value.length > 512 || !/^\/[A-Za-z0-9_./-]+$/.test(value) || value.endsWith('/') || posix.normalize(value) !== value || value.split('/').some(part => part === '..')) throw new Error('Remote paths must be canonical absolute paths using letters, digits, /, _, . and -');
  return value;
}
export function checkedLoopback(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('The acceptance API must be an explicit http://127.0.0.1:PORT origin');
  return url.origin;
}
export const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export function sshArguments(alias, argv) {
  checkedAlias(alias);
  if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('Invalid SSH argument vector');
  // OpenSSH forwards a shell command, not an argv vector. Quote every element.
  return ['-T', '-a', '-x', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', alias, argv.map(shellQuote).join(' ')];
}
export async function sshJson(alias, argv, input, { timeoutMs = 240000, spawnProcess = spawn } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawnProcess('ssh', sshArguments(alias, argv), { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}) } });
    let output = '', bad = false;
    const timer = setTimeout(() => { bad = true; child.kill('SIGTERM'); }, timeoutMs);
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 5000); killer.unref();
    child.stdout.on('data', bytes => { output += bytes; if (Buffer.byteLength(output) > 1024 * 1024) { bad = true; child.kill('SIGKILL'); } });
    // Never copy remote stderr into errors: a foreign command could echo env.
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.once('error', () => { clearTimeout(timer); clearTimeout(killer); reject(new Error('SSH transport could not start')); });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(killer);
      if (bad || code !== 0) return reject(new Error('Remote acceptance command failed or timed out; inspect the private operation receipt on the target'));
      try { resolveResult(JSON.parse(output)); } catch { reject(new Error('Remote acceptance command did not return one bounded JSON result')); }
    });
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}
const networkCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);
export function transportFailureCode(error) {
  if (!(error instanceof TypeError)) return null;
  const code = error.cause?.code;
  return networkCodes.has(code) ? code : null;
}
function checkedPhase(frame) {
  const names = ['artifactId', 'manifestDigest', 'partBytes', 'partSha256', 'phase', 'receivedParts', 'schemaVersion', 'totalParts', 'type'];
  if (!frame || Object.keys(frame).sort().join() !== names.sort().join() || frame.schemaVersion !== 1 || frame.type !== 'phase' || frame.phase !== 'first_part_persisted' || !/^[a-f0-9-]{36}$/.test(frame.artifactId) || !/^[a-f0-9]{64}$/.test(frame.manifestDigest) || !/^[a-f0-9]{64}$/.test(frame.partSha256) || frame.receivedParts !== 1 || !Number.isSafeInteger(frame.totalParts) || frame.totalParts < 2 || frame.totalParts > 100000 || !Number.isSafeInteger(frame.partBytes) || frame.partBytes < 1 || frame.partBytes > 8 * 1024 ** 2) throw new Error('Invalid bounded network-fault phase');
  return frame;
}
function checkedNetworkResult(frame, phase) {
  const names = ['artifactId', 'partialRetained', 'partSha256', 'realNetworkInterrupted', 'requestHookInterrupted', 'transferManifestDigest', 'transportCode'];
  const result = frame?.result;
  if (!frame || Object.keys(frame).sort().join() !== 'result,schemaVersion,type' || frame.schemaVersion !== 1 || frame.type !== 'result' || !result || Object.keys(result).sort().join() !== names.sort().join() || result.realNetworkInterrupted !== true || result.requestHookInterrupted !== false || result.partialRetained !== true || !networkCodes.has(result.transportCode) || result.artifactId !== phase.artifactId || result.transferManifestDigest !== phase.manifestDigest || result.partSha256 !== phase.partSha256) throw new Error('Invalid bounded network-fault result');
  return result;
}
/** A second, non-multiplexed SSH session stays alive while the API forwarding
 * connection is deliberately closed. Its stdin is a one-command gate. */
export async function sshGatedJson(alias, argv, { onPhase, timeoutMs = 240000, stopMs = 5000, spawnProcess = spawn, signal } = {}) {
  if (typeof onPhase !== 'function') throw new Error('A network-fault phase handler is required');
  signal?.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const args = sshArguments(alias, argv);
    args.unshift('-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ClearAllForwardings=yes', '-o', 'RemoteCommand=none');
    const child = spawnProcess('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}) } });
    let buffer = '', total = 0, phase, result, gateSent = false, failure, finished = false, killTimer, rejectTimer;
    const clean = () => { clearTimeout(timer); clearTimeout(killTimer); clearTimeout(rejectTimer); signal?.removeEventListener('abort', fail); };
    const fail = () => {
      failure ??= new Error('Independent SSH network-fault control failed; preserve the private target journal');
      if (finished || killTimer) return;
      child.stdin.destroy(); child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), stopMs);
      rejectTimer = setTimeout(() => { if (!finished) { finished = true; clean(); reject(failure); } }, stopMs * 2);
    };
    const timer = setTimeout(fail, timeoutMs);
    child.stderr.resume(); child.stdin.on('error', fail);
    child.stdout.on('data', chunk => {
      if (finished || failure) return;
      total += chunk.length; buffer += chunk.toString('utf8');
      if (total > 16384 || Buffer.byteLength(buffer) > 8192) { fail(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const frame = JSON.parse(line);
          if (!phase) {
            phase = checkedPhase(frame);
            Promise.resolve().then(() => onPhase(phase)).then(() => {
              if (finished || failure) return;
              gateSent = true;
              child.stdin.end(JSON.stringify({ schemaVersion: 1, command: 'continue' }) + '\n');
            }, fail);
          } else {
            if (!gateSent || result) throw new Error('Out-of-order network-fault control frame');
            result = checkedNetworkResult(frame, phase);
          }
        } catch { fail(); return; }
      }
    });
    child.once('error', fail);
    child.once('close', code => {
      if (finished) return;
      finished = true; clean();
      if (failure || code !== 0 || !phase || !gateSent || !result || buffer) reject(failure ?? new Error('Independent SSH network-fault control ended without verified evidence'));
      else resolveResult(result);
    });
    signal?.addEventListener('abort', fail, { once: true }); if (signal?.aborted) fail();
  });
}
export async function readNetworkGate(stream, phaseSent, { timeoutMs = 60000, signal } = {}) {
  return new Promise((resolveGate, reject) => {
    let input = '', finished = false;
    const done = error => { if (finished) return; finished = true; clearTimeout(timer); stream.off('data', data); stream.off('end', ended); stream.off('error', failed); signal?.removeEventListener('abort', failed); if (error) reject(error); else resolveGate(); };
    const failed = () => done(new Error('Network-fault control stream failed'));
    const ended = () => { if (!finished) done(new Error('Network-fault gate ended before release')); };
    const data = bytes => {
      input += bytes.toString('utf8');
      if (Buffer.byteLength(input) > 256 || !phaseSent()) { failed(); return; }
      const newline = input.indexOf('\n'); if (newline < 0) return;
      try { const value = JSON.parse(input.slice(0, newline)); if (input.slice(newline + 1) || Object.keys(value).sort().join() !== 'command,schemaVersion' || value.schemaVersion !== 1 || value.command !== 'continue') throw new Error('Invalid gate'); done(); }
      catch { failed(); }
    };
    const timer = setTimeout(failed, timeoutMs);
    stream.on('data', data); stream.once('end', ended); stream.once('error', failed);
    signal?.addEventListener('abort', failed, { once: true }); if (signal?.aborted) failed();
  });
}
/** Factory injection keeps ownership/reconnect decisions testable without SSH. */
export function managedTunnelOwner({ enabled, factory, options, apiUrl }) {
  let current;
  return {
    async start() { if (!enabled) return; if (current) throw new Error('Owned tunnel already exists'); current = await factory(options); if (current.apiUrl !== apiUrl) { await current.close(); current = null; throw new Error('Owned tunnel returned a different API origin'); } },
    async close() { if (!current) return; await current.close(); current = null; },
  };
}
export function checkedChildInput(input) {
  if (input.notePrefix !== undefined && !/^[a-z][a-z0-9-]{0,63}$/.test(input.notePrefix)) throw new Error('Invalid infrastructure note prefix');
  if (input.probeSandbox !== undefined && typeof input.probeSandbox !== 'boolean') throw new Error('Invalid sandbox probe flag');
  if (input.expectedParentPid !== undefined && (!Number.isSafeInteger(input.expectedParentPid) || input.expectedParentPid <= 1)) throw new Error('Invalid probe parent identity');
  return input;
}
export function noteName(input, key) {
  if (!['left', 'right'].includes(key)) throw new Error('Unexpected infrastructure item key');
  return `${input.notePrefix ? input.notePrefix + '-' : ''}${key}-note.txt`;
}
/** A success receipt is published only after every ownership/credential/source
 * cleanup acknowledgement. The failure compensator below never short-circuits. */
export async function settleTwoHostProbe({ stopOwned, restoreSources, revokeCredential, probeRevoked, removeCredential, revokeForeign, archiveFixtures, closeTunnel = async () => {}, publish }) {
  await stopOwned(); await restoreSources(); await revokeCredential(); await probeRevoked();
  await removeCredential(); await revokeForeign(); await archiveFixtures(); await closeTunnel();
  return publish();
}
export async function compensateProbe(steps) {
  const failed = [];
  for (const [name, perform] of steps) { try { await perform(); } catch { failed.push(name); } }
  return failed;
}

// This bootstrap executes before importing the release. Payload goes only over
// SSH stdin. The pristine release is never written; the test overlay has the
// same relative package layout through one explicit, external packages link.
export const bootstrapSource = String.raw`
import {mkdir,lstat,realpath,writeFile,symlink} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
let raw='';for await(const b of process.stdin){raw+=b;if(Buffer.byteLength(raw)>512*1024)throw Error('bootstrap bound');}
const p=JSON.parse(raw),[release,operation]=process.argv.slice(1);
const safe=v=>typeof v==='string'&&/^\/[A-Za-z0-9_./-]+$/.test(v)&&resolve(v)===v&&v!=='/'&&!v.split('/').includes('..');
if(!safe(release)||!safe(operation)||operation===release||operation.startsWith(release+'/'))throw Error('unsafe destination');
if(await realpath(release)!==release||!(await lstat(join(release,'packages'))).isDirectory())throw Error('release path');
const parent=dirname(operation);await mkdir(parent,{recursive:true,mode:0o700});
const st=await lstat(parent);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||st.mode&0o077||await realpath(parent)!==parent)throw Error('private operation parent');
await mkdir(operation,{mode:0o700});
const probe=join(operation,'probe');await mkdir(join(probe,'scripts','mvp'),{recursive:true,mode:0o700});
await symlink(join(release,'packages'),join(probe,'packages'),'dir');
const names=['two-host-target.mjs','two-host-support.mjs','parallel-real-smoke.mjs','owned-child.mjs'];
if(!p.files||Object.keys(p.files).sort().join()!==names.sort().join())throw Error('overlay inventory');
for(const name of names)await writeFile(join(probe,'scripts','mvp',name),Buffer.from(p.files[name],'base64'),{flag:'wx',mode:0o600});
const env=p.env;if(!env||!env.CAMP_WORKER_TOKEN||Object.keys(env).some(k=>!['PATH','LANG','CAMP_API_URL','CAMP_WORKER_TOKEN','CAMP_RUNTIME_HOME','CAMP_RUNTIME_IMAGE','CAMP_TOOLCHAIN_BUNDLE','CAMP_STORAGE_BUNDLE','CAMP_WORKER_ID','CAMP_VERIFICATION_HARNESSES'].includes(k)))throw Error('environment inventory');
await writeFile(join(operation,'worker-env.json'),JSON.stringify(env),{flag:'wx',mode:0o600});
await writeFile(join(operation,'input.json'),JSON.stringify(p.input),{flag:'wx',mode:0o600});
await writeFile(join(operation,'contract.mjs'),p.harness,{flag:'wx',mode:0o400});
await writeFile(join(operation,'harnesses.json'),JSON.stringify([{id:'pair-contract',path:join(operation,'contract.mjs')}]),{flag:'wx',mode:0o600});
console.log(JSON.stringify({bootstrapped:true}));
`;
