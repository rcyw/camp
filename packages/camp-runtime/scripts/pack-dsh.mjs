import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const prefix = resolve(process.env.CAMP_DSH_PREFIX ?? `${root}/../../.camp/dsh`);
const manifest = JSON.parse(readFileSync(`${prefix}/node_modules/@deepseek-ai/dsh/package.json`, 'utf8'));
mkdirSync(`${root}/.local`, { recursive: true });
const archive = `${root}/.local/dsh-runtime.tar`;
// The npm prefix contains only installed runtime packages, never user homes,
// environment files, credentials or the source checkout.
const packed = spawnSync('tar', ['-cf', archive, '-C', prefix, 'node_modules', 'package.json', 'package-lock.json'], { stdio: 'inherit', timeout: 110_000 });
if (packed.error) throw packed.error;
if (packed.status !== 0) process.exit(packed.status ?? 1);
writeFileSync(`${root}/.local/dsh-runtime.json`, JSON.stringify({ prefix, archive, version: manifest.version }, null, 2));
console.log(`DSH ${manifest.version}: ${archive}`);
