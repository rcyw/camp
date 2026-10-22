import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tag = process.env.CAMP_RUNTIME_IMAGE_TAG ?? 'camp-mvp-runtime:local';
mkdirSync(`${root}/.local`, { recursive: true });
copyFileSync(process.execPath, `${root}/.local/node`);
const base = process.env.CAMP_BASE_IMAGE ?? 'node:24-trixie';
const result = spawnSync('docker', ['build', '--build-arg', `BASE_IMAGE=${base}`, '-t', tag, root], { stdio: 'inherit', timeout: 110_000 });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const image = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], { encoding: 'utf8' });
if (image.status !== 0) process.exit(image.status ?? 1);
mkdirSync(`${root}/.local`, { recursive: true });
writeFileSync(`${root}/.local/image.json`, JSON.stringify({ imageId: image.stdout.trim(), tag, base, node: process.version }, null, 2));
console.log(image.stdout.trim());
