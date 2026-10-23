import { buildWorkerRelease } from '../src/worker-release.mjs';

const args = process.argv.slice(2), options = {};
const flags = { '--output': 'output', '--source-commit': 'sourceCommit', '--toolchain-digest': 'toolchainDigest', '--image-id': 'imageId' };
try {
  for (let index = 0; index < args.length; index += 2) {
    const name = flags[args[index]], value = args[index + 1];
    if (!name || options[name] || !value || value.startsWith('--')) throw new Error('Invalid Worker release build option');
    options[name] = value;
  }
  const result = await buildWorkerRelease(options);
  console.log(JSON.stringify({ event: 'worker_release_built', directory: result.directory, manifestSha256: result.digest, sourceCommit: result.manifest.source.commit, external: result.manifest.external, files: result.manifest.files.length }));
} catch (error) {
  console.error(JSON.stringify({ event: 'worker_release_build_failed', code: error.code ?? 'camp_worker_release_invalid', message: error.message })); process.exitCode = 1;
}
