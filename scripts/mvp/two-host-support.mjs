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
export async function settleTwoHostProbe({ stopOwned, restoreSources, revokeCredential, probeRevoked, removeCredential, revokeForeign, archiveFixtures, publish }) {
  await stopOwned(); await restoreSources(); await revokeCredential(); await probeRevoked();
  await removeCredential(); await revokeForeign(); await archiveFixtures();
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
