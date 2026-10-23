import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const execute = promisify(execFile);
export const protocolDirectory = fileURLToPath(new URL('../../camp-protocol', import.meta.url));

/** Explicit allowlists keep host dependencies, environments and credentials out. */
export async function packPlugin({ plugin, archive, protocolArchive }) {
  await execute('tar', ['-cf', archive, '-C', resolve(plugin), 'src', 'scripts', 'package.json', 'protocol.json', 'cordis.patch.yml'], { timeout: 10_000 });
  await execute('tar', ['-cf', protocolArchive, '-C', protocolDirectory, 'src', 'package.json'], { timeout: 10_000 });
}
