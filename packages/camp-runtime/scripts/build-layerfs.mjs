import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const source = resolve(process.env.LAYERFS_SOURCE ?? '/data/github-projects/Ephemeral-AI-Lab/layerfs');
const target = resolve(pkg, '.local/layerfs-target');
const output = resolve(pkg, '.local/layerfs');
mkdirSync(output, { recursive: true });
const cargo = process.env.CAMP_RUST_TOOLCHAIN ? [`+${process.env.CAMP_RUST_TOOLCHAIN}`] : [];
const build = spawnSync('cargo', [...cargo, 'build', '--manifest-path', `${source}/core/Cargo.toml`, '--offline', '--locked', '-p', 'layerfs-node', '--lib', '-p', 'layerfs-daemon', '--bins', '--target-dir', target, '-j', process.env.CAMP_BUILD_JOBS ?? '6'], {
  cwd: source, stdio: 'inherit', timeout: 110_000,
});
if (build.error?.code === 'ETIMEDOUT') {
  console.error('Build reached its 110 second bound; retained Cargo artifacts may be reused by a later explicit invocation.');
  process.exit(124);
}
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
copyFileSync(`${target}/debug/liblayerfs_node.so`, `${output}/layerfs.node`);
copyFileSync(`${target}/debug/layerfs-daemon`, `${output}/layerfs-daemon`);
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).stdout.trim();
const rust = spawnSync('rustc', [...cargo, '--version'], { encoding: 'utf8' });
writeFileSync(`${output}/build.json`, JSON.stringify({ source, revision, profile: 'Disposable', target, rust: rust.stdout?.trim() }, null, 2));
console.log(`LayerFS artifacts: ${output}`);
