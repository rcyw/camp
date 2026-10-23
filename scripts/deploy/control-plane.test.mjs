import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request } from 'node:https';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { X509Certificate, createPrivateKey, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile, readdir, chmod, link, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeControlPki, renewControlCertificate, renderControlDeployment, parseControlArguments } from './control-plane.mjs';
import { installSandboxTrust } from '../../packages/camp-runtime/src/sandbox-trust.mjs';

test('private CA verifies real HTTPS, exact IP SAN and repeatable renewal without changing serving key', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-tls-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const config = { publicIp: '127.0.0.1', pkiDir: join(folder, 'pki'), scriptPath: '/opt/camp/control-plane.mjs', nodePath: '/usr/bin/node', configPath: '/etc/camp/control.json' };
  const initial = await initializeControlPki(config, join(folder, 'offline'));
  assert.equal(initial.renewed, true);
  const key = await readFile(join(config.pkiDir, 'server.key')), ca = await readFile(join(config.pkiDir, 'root.crt'));
  assert.equal((await stat(join(config.pkiDir, 'server.key'))).mode & 0o777, 0o600);
  const server = createServer({ key, cert: await readFile(join(config.pkiDir, 'server-chain.pem')) }, (_req, res) => res.end('camp'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const get = extra => new Promise((resolve, reject) => { const req = request({ hostname: '127.0.0.1', port: server.address().port, ca, ...extra }, res => { let body = ''; res.on('data', part => { body += part; }); res.on('end', () => resolve(body)); }); req.on('error', reject); req.end(); });
  assert.equal(await get({}), 'camp');
  await assert.rejects(get({ ca: undefined }), /unable to get local issuer certificate|self-signed/);
  await assert.rejects(get({ servername: 'wrong.example' }), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  assert.equal((await renewControlCertificate(config)).renewed, false);
  assert.equal((await renewControlCertificate(config, { force: true })).renewed, true);
  assert.equal(digest(await readFile(join(config.pkiDir, 'server.key'))), digest(key));
  await assert.rejects(initializeControlPki(config, join(folder, 'offline')), /never replaces/);
  const run = { folder, containerId: 'a'.repeat(64) }, calls = [];
  const trust = await installSandboxTrust({ runtime: { dockerCall: async args => calls.push(args) }, run, caFile: join(config.pkiDir, 'root.crt') });
  assert.equal(trust.NODE_EXTRA_CA_CERTS, '/usr/local/share/ca-certificates/camp-control.crt');
  assert.equal(calls[0][0], 'cp'); assert.ok(calls.some(args => args.includes('update-ca-certificates')));
  assert.deepEqual(await readFile(join(folder, 'control-ca.crt')), ca);
  await symlink(join(config.pkiDir, 'root.crt'), join(folder, 'linked.crt'));
  await assert.rejects(installSandboxTrust({ runtime: {}, run, caFile: join(folder, 'linked.crt') }), { code: 'camp_control_ca_invalid' });
  await writeFile(join(folder, 'private.key'), key, { mode: 0o600 });
  await assert.rejects(installSandboxTrust({ runtime: {}, run, caFile: join(folder, 'private.key') }), { code: 'camp_control_ca_invalid' });
  await writeFile(join(folder, 'mixed.pem'), Buffer.concat([ca, key]));
  await assert.rejects(installSandboxTrust({ runtime: {}, run, caFile: join(folder, 'mixed.pem') }), { code: 'camp_control_ca_invalid' });
  await chmod(join(config.pkiDir, 'root.crt'), 0o666);
  await assert.rejects(installSandboxTrust({ runtime: {}, run, caFile: join(config.pkiDir, 'root.crt') }), { code: 'camp_control_ca_invalid' });
  await chmod(join(config.pkiDir, 'root.crt'), 0o644);
  await link(join(config.pkiDir, 'root.crt'), join(folder, 'alias.crt'));
  await assert.rejects(installSandboxTrust({ runtime: {}, run, caFile: join(config.pkiDir, 'root.crt') }), { code: 'camp_control_ca_invalid' }); await unlink(join(folder, 'alias.crt'));
  await assert.rejects(installSandboxTrust({ runtime: {}, run, caFile: join(config.pkiDir, 'root.crt'), now: Date.now() + 11 * 365 * 86400_000 }), { code: 'camp_control_ca_invalid' });
});

test('deployment rejects configuration injection and preserves streaming artifact and socket routes', () => {
  const config = { publicIp: '8.217.75.234', pkiDir: '/etc/camp/pki', scriptPath: '/opt/camp/control-plane.mjs', nodePath: '/usr/bin/node', configPath: '/etc/camp/control.json' };
  const files = renderControlDeployment(config), nginx = files['camp-control.conf'];
  assert.match(nginx, /client_max_body_size 10m/); assert.match(nginx, /proxy_request_buffering off/); assert.match(nginx, /proxy_buffering off/); assert.match(nginx, /location \/socket.io\//); assert.match(nginx, /X-Forwarded-For \$remote_addr/);
  for (const input of [{ ...config, publicIp: 'example.com' }, { ...config, pkiDir: '/etc/camp;bad' }, { ...config, apiPort: 443 }, { ...config, apiPort: 15190 }, { ...config, configPath: '/etc/../tmp/config' }, { ...config, webRoot: '/' }, { ...config, nodePath: '/' }, { ...config, unexpected: true }]) assert.throws(() => renderControlDeployment(input));
  const managed = renderControlDeployment({ ...config, webRoot: '/srv/camp/web', rootCaDir: '/offline/camp-root' });
  assert.match(managed['camp-control.conf'], /try_files \$uri \$uri\/ \/index.html/); assert.match(managed['camp-control.conf'], /location ~ \/\\\. \{ deny all; \}/);
  assert.match(managed['camp-control-certificate.service'], /InaccessiblePaths=-\/offline\/camp-root/);
  for (const rootCaDir of ['/etc/camp', '/etc/camp/pki/offline', '/opt/camp']) assert.throws(() => renderControlDeployment({ ...config, rootCaDir }));
});

const execute = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtureConfig = folder => ({ publicIp: '127.0.0.1', pkiDir: join(folder, 'pki'), scriptPath: '/opt/camp/control-plane.mjs', nodePath: '/usr/bin/node', configPath: '/etc/camp/control.json' });

test('initialization protects all private keys under umask 000 and concurrent initialization cannot replace a root', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-tls-init-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const config = fixtureConfig(folder), offline = join(folder, 'offline');
  const oldMask = process.umask(0);
  let outcomes;
  try { outcomes = await Promise.allSettled([initializeControlPki(config, offline), initializeControlPki(config, offline)]); }
  finally { process.umask(oldMask); }
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  for (const file of [join(offline, 'root.key'), join(config.pkiDir, 'issuer.key'), join(config.pkiDir, 'server.key')]) assert.equal((await stat(file)).mode & 0o777, 0o600);
  const root = new X509Certificate(await readFile(join(offline, 'root.crt')));
  assert.equal(root.checkPrivateKey(createPrivateKey(await readFile(join(offline, 'root.key')))), true);
  assert.deepEqual(await readFile(join(config.pkiDir, 'root.crt')), await readFile(join(offline, 'root.crt')));
  assert.equal((await readdir(config.pkiDir)).some(name => name.startsWith('.initialize-') || name.startsWith('.renew-')), false);
  const concurrent = await Promise.allSettled([renewControlCertificate(config, { force: true }), renewControlCertificate(config, { force: true })]);
  assert.equal(concurrent.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal((await renewControlCertificate(config)).renewed, false, 'The kernel lock releases without deleting an inode or retaining a stale PID');
  await assert.rejects(initializeControlPki({ ...config, pkiDir: join(offline, 'nested') }, offline), /separate directory trees/);
});

test('renewal checks signer key and repairs a mismatched serving key or chain before skipping', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-tls-chain-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const config = fixtureConfig(join(folder, 'first')), other = fixtureConfig(join(folder, 'second'));
  await initializeControlPki(config, join(folder, 'offline-first')); await initializeControlPki(other, join(folder, 'offline-second'));
  const keyPath = join(config.pkiDir, 'server.key'), chainPath = join(config.pkiDir, 'server-chain.pem'), issuerKeyPath = join(config.pkiDir, 'issuer.key');
  await writeFile(keyPath, await readFile(join(other.pkiDir, 'server.key')));
  assert.equal((await renewControlCertificate(config)).renewed, true, 'A long-lived leaf with the wrong private key must not be skipped');
  assert.equal(new X509Certificate(await readFile(chainPath)).checkPrivateKey(createPrivateKey(await readFile(keyPath))), true);
  await writeFile(chainPath, await readFile(join(other.pkiDir, 'server-chain.pem')));
  assert.equal((await renewControlCertificate(config)).renewed, true, 'A matching SAN and expiry do not establish the configured issuer');
  const chain = await readFile(chainPath), issuerKey = await readFile(issuerKeyPath);
  await writeFile(issuerKeyPath, await readFile(join(other.pkiDir, 'issuer.key')));
  await assert.rejects(renewControlCertificate(config), /signing key is invalid/);
  assert.deepEqual(await readFile(chainPath), chain, 'A broken signing key never publishes a replacement chain');
  await writeFile(issuerKeyPath, issuerKey);
  await rm(keyPath); await assert.rejects(renewControlCertificate(config), /lost its private key/);
});

test('root expiry and insufficient root validity bound the online issuer even when its leaf looks current', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-tls-validity-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const config = fixtureConfig(folder), offline = join(folder, 'offline');
  await initializeControlPki(config, offline);
  const chain = await readFile(join(config.pkiDir, 'server-chain.pem'));
  await execute('openssl', ['req', '-x509', '-new', '-key', join(offline, 'root.key'), '-days', '1', '-sha256', '-subj', '/CN=Camp Control Root CA', '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:1', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-out', join(config.pkiDir, 'root.crt')]);
  await assert.rejects(renewControlCertificate(config), /requires operator renewal/);
  await assert.rejects(renewControlCertificate(config, { now: Date.now() + 2 * 86400_000 }), /root, issuer or signing key is invalid/);
  assert.deepEqual(await readFile(join(config.pkiDir, 'server-chain.pem')), chain);
});

test('a short or expired online issuer cannot be hidden by a healthy-looking serving leaf', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-tls-issuer-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const config = fixtureConfig(folder), offline = join(folder, 'offline'); await initializeControlPki(config, offline);
  const chain = await readFile(join(config.pkiDir, 'server-chain.pem')), csr = join(folder, 'issuer.csr'), ext = join(folder, 'issuer.ext');
  await execute('openssl', ['req', '-new', '-key', join(config.pkiDir, 'issuer.key'), '-subj', '/CN=Camp Control Online Issuer', '-out', csr]);
  await writeFile(ext, 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n', { mode: 0o600 });
  await execute('openssl', ['x509', '-req', '-in', csr, '-CA', join(offline, 'root.crt'), '-CAkey', join(offline, 'root.key'), '-set_serial', '0x123456', '-days', '1', '-sha256', '-extfile', ext, '-out', join(config.pkiDir, 'issuer.crt')]);
  await assert.rejects(renewControlCertificate(config), /requires operator renewal/);
  await assert.rejects(renewControlCertificate(config, { now: Date.now() + 2 * 86400_000 }), /root, issuer or signing key is invalid/);
  assert.deepEqual(await readFile(join(config.pkiDir, 'server-chain.pem')), chain);
});

test('strict CLI parsing and a real init/renew invocation use the same validation', async t => {
  for (const argv of [[], ['other', '--config', '/tmp/config.json'], ['renew', '--config', 'relative'], ['renew', '--config', '/tmp/config.json', '--force'], ['init', '--config', '/tmp/config.json'], ['init', '--config', '/tmp/config.json', '--root-ca-dir', '/tmp/offline', 'extra']]) assert.throws(() => parseControlArguments(argv));
  assert.deepEqual(parseControlArguments(['init', '--config', '/tmp/config.json', '--root-ca-dir', '/tmp/offline']), { action: 'init', configFile: '/tmp/config.json', rootDirectory: '/tmp/offline' });
  const folder = await mkdtemp(join(tmpdir(), 'camp-tls-cli-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const config = fixtureConfig(folder), file = join(folder, 'config.json'); await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const script = fileURLToPath(new URL('./control-plane.mjs', import.meta.url));
  const initial = await execute(process.execPath, [script, 'init', '--config', file, '--root-ca-dir', join(folder, 'offline')]); assert.equal(JSON.parse(initial.stdout).renewed, true);
  const next = await execute(process.execPath, [script, 'renew', '--config', file]); assert.equal(JSON.parse(next.stdout).renewed, false);
});

test('a current leaf cannot hide an invalid full-chain root path length policy', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-tls-constraints-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const config = fixtureConfig(folder), offline = join(folder, 'offline'); await initializeControlPki(config, offline);
  const chain = await readFile(join(config.pkiDir, 'server-chain.pem'));
  // Same root key and subject, valid signatures and dates, but the root now
  // forbids the online intermediate. Adjacent X509 checks still pass.
  await execute('openssl', ['req', '-x509', '-new', '-key', join(offline, 'root.key'), '-days', '3650', '-sha256', '-subj', '/CN=Camp Control Root CA', '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-out', join(config.pkiDir, 'root.crt')]);
  const root = new X509Certificate(await readFile(join(config.pkiDir, 'root.crt'))), issuer = new X509Certificate(await readFile(join(config.pkiDir, 'issuer.crt')));
  assert.equal(issuer.checkIssued(root) && issuer.verify(root.publicKey), true);
  await assert.rejects(execute('openssl', ['verify', '-CAfile', join(config.pkiDir, 'root.crt'), '-untrusted', join(config.pkiDir, 'issuer.crt'), join(config.pkiDir, 'server-chain.pem')]), error => /path length constraint exceeded/.test(error.stderr));
  await assert.rejects(renewControlCertificate(config), { code: 'camp_control_deployment' });
  assert.deepEqual(await readFile(join(config.pkiDir, 'server-chain.pem')), chain);
});

test('non-ASCII PEM bytes and invalid inspection clocks fail before any sandbox trust mutation', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-tls-ascii-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const config = fixtureConfig(folder); await initializeControlPki(config, join(folder, 'offline'));
  const ca = await readFile(join(config.pkiDir, 'root.crt')), malformed = Buffer.from(ca); malformed[0] |= 0x80;
  const file = join(folder, 'malformed.crt'); await writeFile(file, malformed, { mode: 0o644 });
  const run = { folder: join(folder, 'run'), containerId: 'a'.repeat(64) }; await mkdir(run.folder, { mode: 0o700 });
  let calls = 0; const runtime = { dockerCall: async () => { calls++; } };
  await assert.rejects(installSandboxTrust({ runtime, run, caFile: file }), { code: 'camp_control_ca_invalid' });
  for (const now of [NaN, Infinity, -Infinity]) await assert.rejects(installSandboxTrust({ runtime, run, caFile: join(config.pkiDir, 'root.crt'), now }), { code: 'camp_control_ca_invalid' });
  assert.equal(calls, 0); await assert.rejects(stat(join(run.folder, 'control-ca.crt')), { code: 'ENOENT' });
  await writeFile(join(config.pkiDir, 'root.crt'), malformed);
  await assert.rejects(renewControlCertificate(config), /only ASCII PEM/);
});

test('moving the offline root out of service custody retains a valid isolated renewal unit', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-tls-offline-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const rootCaDir = join(folder, 'offline'), config = { ...fixtureConfig(folder), rootCaDir, scriptPath: fileURLToPath(new URL('control-plane.mjs', import.meta.url)), nodePath: process.execPath };
  await initializeControlPki(config, rootCaDir); await rm(rootCaDir, { recursive: true });
  assert.equal((await renewControlCertificate(config, { force: true })).renewed, true, 'Renewal never needs the removed offline key');
  const rendered = renderControlDeployment(config), unit = rendered['camp-control-certificate.service'];
  assert.ok(unit.includes('InaccessiblePaths=-' + rootCaDir));
  const service = join(folder, 'camp-control-certificate.service'); await writeFile(service, unit);
  await execute('systemd-analyze', ['verify', '--man=no', service], { timeout: 15000 });
});

test('SIGKILL at either side of publication leaves a complete old or new chain and releases the issuer lock', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-tls-crash-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const config = fixtureConfig(folder); await initializeControlPki(config, join(folder, 'offline'));
  const configFile = join(folder, 'config.json'), chainFile = join(config.pkiDir, 'server-chain.pem'); await writeFile(configFile, JSON.stringify(config));
  const keyDigest = digest(await readFile(join(config.pkiDir, 'server.key')));
  const script = String.raw`import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';
const[moduleUrl,configFile,marker,phase]=process.argv.slice(1),config=JSON.parse(fs.readFileSync(configFile,'utf8')),original=fs.promises.rename;
fs.promises.rename=async(source,target)=>{if(target!==config.pkiDir+'/server-chain.pem')return original(source,target);if(phase==='after')await original(source,target);fs.writeFileSync(marker,'ready',{flag:'wx',mode:0o600});setInterval(()=>{},1000);await new Promise(()=>{});};syncBuiltinESMExports();
await(await import(moduleUrl)).renewControlCertificate(config,{force:true});`;
  for (const phase of ['before', 'after']) {
    const previous = await readFile(chainFile), marker = join(folder, phase + '.marker');
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, new URL('control-plane.mjs', import.meta.url).href, configFile, marker, phase], { stdio: 'ignore' });
    const closed = once(child, 'close');
    try {
      const deadline = Date.now() + 10000;
      for (;;) {
        try { await stat(marker); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        assert.equal(child.exitCode, null, 'Publication fault child exited before its owned gate'); assert.ok(Date.now() < deadline); await delay(10);
      }
      assert.equal(child.kill('SIGKILL'), true); const [, signal] = await closed; assert.equal(signal, 'SIGKILL');
      if (phase === 'before') assert.deepEqual(await readFile(chainFile), previous);
      else assert.notEqual(digest(await readFile(chainFile)), digest(previous));
      await execute('openssl', ['verify', '-CAfile', join(config.pkiDir, 'root.crt'), '-untrusted', join(config.pkiDir, 'issuer.crt'), '-verify_ip', config.publicIp, '-purpose', 'sslserver', chainFile]);
      assert.equal((await renewControlCertificate(config)).renewed, false, 'Another invocation can acquire the crashed owner kernel lock');
      assert.equal(digest(await readFile(join(config.pkiDir, 'server.key'))), keyDigest);
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; } }
  }
});

test('PKI output and public CA inputs reject replaceable parent directories before writing or trusting anything', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-tls-parent-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const unsafe = join(folder, 'unsafe'); await mkdir(unsafe); await chmod(unsafe, 0o777);
  const bad = fixtureConfig(unsafe);
  await assert.rejects(initializeControlPki(bad, join(folder, 'offline')), /writable or foreign-owned ancestors/);
  await assert.rejects(stat(bad.pkiDir), { code: 'ENOENT' });
  const good = fixtureConfig(join(folder, 'safe')); await initializeControlPki(good, join(folder, 'offline'));
  const file = join(unsafe, 'public-root.crt'); await writeFile(file, await readFile(join(good.pkiDir, 'root.crt')), { mode: 0o644 });
  let calls = 0;
  await assert.rejects(installSandboxTrust({ runtime: { dockerCall: async () => { calls++; } }, run: { folder, containerId: 'a'.repeat(64) }, caFile: file }), { code: 'camp_control_ca_invalid' });
  assert.equal(calls, 0); await assert.rejects(stat(join(folder, 'control-ca.crt')), { code: 'ENOENT' });
});
