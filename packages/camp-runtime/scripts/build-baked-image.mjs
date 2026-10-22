import { spawnSync } from 'node:child_process';
import { cp, mkdir, realpath, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = `${root}/.local/toolchain`;
const command = (name, args) => {
  const result = spawnSync(name, args, { encoding: 'utf8', timeout: 110_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} failed (${result.status}): ${result.stderr}`);
  return result.stdout.trim();
};
const copy = async (source, target = source) => {
  const destination = resolve(output, `.${target}`);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, dereference: true });
};
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const git = command('which', ['git']);
const gitCore = command('git', ['--exec-path']);
await copy(git, '/usr/bin/git');
await copy(gitCore);
await copy('/usr/share/git-core');
const libraries = new Set();
for (const executable of [git, `${gitCore}/git-remote-http`]) {
  for (const match of command('ldd', [executable]).matchAll(/=> (\/\S+) /g)) {
    if (!/\/(?:libc|libm|libpthread|libdl|librt)\.so/.test(match[1])) libraries.add(match[1]);
  }
}
for (const library of libraries) await copy(library, library.startsWith('/lib/') ? `/usr${library}` : library);
await copy('/etc/ssl/certs/ca-certificates.crt');
const npmBin = await realpath(command('which', ['npm']));
await copy(resolve(dirname(npmBin), '..'), '/usr/local/lib/node_modules/npm');
await mkdir(`${output}/usr/local/bin`, { recursive: true });
for (const [name, entry] of [['npm', 'npm-cli.js'], ['npx', 'npx-cli.js']]) {
  const path = `${output}/usr/local/bin/${name}`;
  try { await symlink(`../lib/node_modules/npm/bin/${entry}`, path); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
command('tar', ['-cf', `${root}/.local/dsh-plugin.tar`, '-C', resolve(root, '../dsh-plugin'), 'src', 'scripts', 'package.json', 'cordis.patch.yml']);
const image = JSON.parse(await readFile(`${root}/.local/image.json`, 'utf8'));
if (command('docker', ['image', 'inspect', '--format', '{{.Id}}', image.tag]) !== image.imageId) throw new Error('Runtime base tag no longer matches its recorded image ID');
const tag = process.env.CAMP_BAKED_IMAGE_TAG ?? 'camp-mvp-runtime:dsh-0.2.1-rc.2';
const built = spawnSync('docker', ['build', '-f', `${root}/Dockerfile.dsh`, '--build-arg', `BASE_IMAGE=${image.tag}`, '-t', tag, root], { stdio: 'inherit', timeout: 110_000 });
if (built.error) throw built.error;
if (built.status !== 0) process.exit(built.status ?? 1);
const imageId = command('docker', ['image', 'inspect', '--format', '{{.Id}}', tag]);
await writeFile(`${root}/.local/baked-image.json`, JSON.stringify({ tag, imageId, baseImage: image.imageId, node: process.version, npm: command('npm', ['--version']), git: command('git', ['--version']), dsh: '0.2.1-rc.2' }, null, 2));
console.log(imageId);
