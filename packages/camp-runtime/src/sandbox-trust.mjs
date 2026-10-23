import { constants } from 'node:fs';
import { open, writeFile, realpath, lstat } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const destination = '/usr/local/share/ca-certificates/camp-control.crt';
const invalid = () => Object.assign(new Error('Control CA must be a bounded, current self-signed CA certificate'), { code: 'camp_control_ca_invalid' });
async function trustedAncestors(directory) {
  for (;;) {
    const stat = await lstat(directory);
    const trustedTemporary = directory === '/tmp' && stat.uid === 0 && !!(stat.mode & 0o1000);
    if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, process.getuid()].includes(stat.uid) || !trustedTemporary && stat.mode & 0o022) throw invalid();
    const parent = dirname(directory); if (parent === directory) return;
    directory = parent;
  }
}

/** Only the public trust anchor crosses into the role container. Keep the
 * original image identity: deployment trust is not project/candidate content. */
export async function installSandboxTrust({ runtime, run, caFile, now = Date.now() }) {
  if (!caFile) return {};
  let file, pem;
  try {
    if (!Number.isFinite(now) || typeof caFile !== 'string' || !isAbsolute(caFile) || resolve(caFile) !== caFile || await realpath(caFile) !== caFile) throw invalid();
    await trustedAncestors(dirname(caFile));
    file = await open(caFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || ![0, process.getuid()].includes(stat.uid) || stat.size > 16384 || stat.size < 100 || stat.mode & 0o022) throw invalid();
    const bytes = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < bytes.length) { const part = await file.read(bytes, length, bytes.length - length); if (!part.bytesRead) break; length += part.bytesRead; }
    if (length !== stat.size) throw invalid();
    if (bytes.subarray(0, length).some(byte => byte > 0x7f)) throw invalid();
    pem = bytes.subarray(0, length).toString('ascii');
    if (!/^\s*-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(pem)) throw invalid();
    const certificate = new X509Certificate(pem);
    if (!certificate.ca || !certificate.checkIssued(certificate) || !certificate.verify(certificate.publicKey) || Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) throw invalid();
  } catch (error) { if (error.code === 'camp_control_ca_invalid') throw error; throw invalid(); }
  finally { await file?.close(); }
  const snapshot = join(run.folder, 'control-ca.crt');
  await writeFile(snapshot, pem, { mode: 0o600, flag: 'wx' });
  await runtime.dockerCall(['cp', snapshot, `${run.containerId}:${destination}`]);
  await runtime.dockerCall(['exec', '--user', '0:0', run.containerId, 'chmod', '0444', destination]);
  await runtime.dockerCall(['exec', '--user', '0:0', run.containerId, 'update-ca-certificates']);
  return { NODE_EXTRA_CA_CERTS: destination };
}
