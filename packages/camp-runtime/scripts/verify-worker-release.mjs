import { verifyWorkerRelease } from '../src/worker-release.mjs';

const args = process.argv.slice(2), options = {};
try {
  const flags = { '--release': 'directory', '--manifest-sha256': 'expectedDigest' };
  for (let index = 0; index < args.length; index += 2) {
    const name = flags[args[index]], value = args[index + 1];
    if (!name || options[name] || !value || value.startsWith('--')) throw new Error('Invalid Worker release verification option');
    options[name] = value;
  }
  if (!options.directory || !options.expectedDigest) throw new Error('Use --release <directory> --manifest-sha256 <reviewed SHA-256>');
  const result = await verifyWorkerRelease(options.directory, { expectedDigest: options.expectedDigest });
  console.log(JSON.stringify({ event: 'worker_release_verified', manifestSha256: result.digest, sourceCommit: result.manifest.source.commit, external: result.manifest.external, files: result.manifest.files.length }));
} catch (error) {
  console.error(JSON.stringify({ event: 'worker_release_verify_failed', code: error.code ?? 'camp_worker_release_invalid', message: error.message })); process.exitCode = 1;
}
