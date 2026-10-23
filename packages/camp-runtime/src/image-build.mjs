import { mkdtemp, cp, copyFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from './toolchain-build.mjs';
import { defaultBundle, loadToolchain, toolchainLock, runtimePackage } from './toolchain.mjs';

/** A fixed official toolchain base, never host executables or libraries. */
export function lockedBase(arch = process.arch) {
  const digest = toolchainLock.image.platforms[arch];
  if (!digest) throw new Error('The standard image has no pinned base for this architecture');
  return `${toolchainLock.image.repository}:${toolchainLock.image.tag}@${digest}`;
}
export async function buildStandardImage({ bundle = process.env.CAMP_TOOLCHAIN_BUNDLE ?? defaultBundle, tag = process.env.CAMP_RUNTIME_IMAGE_TAG, receipt = process.env.CAMP_IMAGE_RECEIPT ?? join(runtimePackage, '.local/standard-image.json') } = {}) {
  const toolchain = await loadToolchain(bundle);
  const base = lockedBase();
  tag ??= `camp-runtime:toolchain-${toolchain.digest.slice(0, 12)}`;
  // An existing tag is evidence somebody might already depend on it.
  if (await command('docker', ['image', 'inspect', '--format', '{{.Id}}', tag]).then(() => true, () => false)) throw new Error('Image tag already exists; use a fresh tag instead of replacing a deployed image');
  const context = await mkdtemp(join(tmpdir(), 'camp-image-build-'));
  try {
    await mkdir(join(context, 'bundle'));
    for (const file of ['dsh-runtime.tar', 'dsh-plugin.tar', 'camp-protocol.tar', 'manifest.json']) await copyFile(join(bundle, file), join(context, 'bundle', file));
    await cp(join(bundle, 'licenses'), join(context, 'bundle/licenses'), { recursive: true, dereference: false });
    await copyFile(join(runtimePackage, 'Dockerfile'), join(context, 'Dockerfile'));
    await command('docker', ['build', '--network=none', '--build-arg', `BASE_IMAGE=${base}`, '--build-arg', `TOOLCHAIN_DIGEST=${toolchain.digest}`, '-t', tag, context]);
    const inspected = JSON.parse(await command('docker', ['image', 'inspect', tag]))[0];
    if (!/^sha256:[a-f0-9]{64}$/.test(inspected.Id) || inspected.Config.Labels?.['camp.toolchain.digest'] !== toolchain.digest) throw new Error('Built image does not identify this toolchain');
    const result = { schemaVersion: 1, imageId: inspected.Id, tag, base, toolchainDigest: toolchain.digest, platform: inspected.Os, architecture: inspected.Architecture, node: toolchainLock.image.version, dsh: toolchainLock.dsh.version };
    await writeFile(receipt, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    return result;
  } finally { await rm(context, { recursive: true, force: true }); }
}
