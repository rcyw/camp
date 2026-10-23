import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { controlApiMain, renderControlApiUnit } from './control-api.mjs';

const execute = promisify(execFile);
const config = () => ({ checkout: '/opt/camp/control', nodePath: '/usr/bin/node', envFile: '/etc/camp/control-api.env' });

test('renderer is pure and emits the foreground API lifecycle and loopback contract', () => {
  const unit = renderControlApiUnit(config());
  assert.match(unit, /^WorkingDirectory=\/opt\/camp\/control\/packages\/server$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/env -u DOTENV_CONFIG_OVERRIDE CAMP_LISTEN_HOST=127\.0\.0\.1 "\/usr\/bin\/node" --import @oxc-node\/core\/register src\/server.ts$/m);
  for (const directive of ['Requires=docker.service network-online.target', 'After=docker.service network-online.target', 'User=root', 'EnvironmentFile=/etc/camp/control-api.env', 'Environment="CAMP_LISTEN_HOST=127.0.0.1"', 'Restart=on-failure', 'RestartSec=5s', 'TimeoutStopSec=90s', 'KillMode=mixed', 'UMask=0077', 'NoNewPrivileges=yes', 'PrivateTmp=yes']) assert.ok(unit.split('\n').includes(directive), directive);
  assert.doesNotMatch(unit, /--watch|ExecStartPre|ExecStop=|systemctl|docker update|DEEPSEEK_API_KEY|DATABASE_URL/);
  assert.equal(renderControlApiUnit({ checkout: '/does-not-exist/control', nodePath: '/does-not-exist/node' }).includes('EnvironmentFile=/etc/camp/control-api.env'), true);
});

test('canonical paths and exact configuration reject directive, argv and secret injection', () => {
  for (const value of [null, '', '/', 'relative', '//opt/camp', '/opt/../camp', '/opt/./camp', '/opt/camp/', '/opt/a b', '/opt/a\nExecStart=/bad', '/opt/a\rX', '/opt/a\0', '/opt/$HOME', '/opt/${X}', '/opt/a;bad', '/opt/"bad', '/opt/\\bad', '/opt/é']) {
    for (const field of ['checkout', 'nodePath', 'envFile']) assert.throws(() => renderControlApiUnit({ ...config(), [field]: value }), { code: 'camp_control_api_invalid' });
  }
  for (const value of [null, [], 'secret', { ...config(), token: 'must-not-leak' }, { ...config(), captureEnvironment: true }]) assert.throws(() => renderControlApiUnit(value), { code: 'camp_control_api_invalid' });
});

test('literal systemd specifiers are escaped independently in every path', () => {
  const unit = renderControlApiUnit({ checkout: '/opt/%H/control', nodePath: '/opt/node%u/bin/node', envFile: '/etc/camp/%n.env' });
  assert.match(unit, /^WorkingDirectory=\/opt\/%%H\/control\/packages\/server$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/env -u DOTENV_CONFIG_OVERRIDE CAMP_LISTEN_HOST=127\.0\.0\.1 "\/opt\/node%%u\/bin\/node" /m);
  assert.match(unit, /^EnvironmentFile=\/etc\/camp\/%%n.env$/m);
});

test('CLI accepts only render with unique known arguments and never echoes rejected values', async () => {
  const args = ['render', '--checkout', config().checkout, '--node-path', config().nodePath, '--env-file', config().envFile];
  assert.equal(controlApiMain(args), renderControlApiUnit(config()));
  for (const value of [[], ['install', ...args.slice(1)], ['render', '--checkout'], [...args, '--secret', 'must-not-leak'], [...args, '--checkout', '/other'], ['render', '--checkout', '/ok']]) assert.throws(() => controlApiMain(value), { code: 'camp_control_api_invalid' });
  const result = await execute(process.execPath, ['scripts/deploy/control-api.mjs', ...args], { cwd: new URL('../../', import.meta.url), timeout: 5000 });
  assert.equal(result.stdout, renderControlApiUnit(config())); assert.equal(result.stderr, '');
  await assert.rejects(execute(process.execPath, ['scripts/deploy/control-api.mjs', 'render', '--secret', 'must-not-leak'], { cwd: new URL('../../', import.meta.url), timeout: 5000 }), error => error.code === 1 && error.stdout === '' && !error.stderr.includes('must-not-leak'));
});

test('generated unit passes the installed systemd parser without starting anything', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'camp-control-api-unit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'camp-control-api.service');
  await writeFile(file, renderControlApiUnit({ ...config(), nodePath: process.execPath }));
  const result = await execute('systemd-analyze', ['verify', '--man=no', file], { timeout: 15000 });
  assert.doesNotMatch(result.stderr, /camp-control-api\.service:.*(?:fatal|bad unit|not absolute)/i);
});

test('actual ExecStart overrides a wildcard EnvironmentFile bind before the application listens', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'camp-control-bind-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, 'packages/server'); await mkdir(join(cwd, 'src'), { recursive: true });
  await symlink(new URL('../../node_modules', import.meta.url), join(directory, 'node_modules'));
  await symlink(new URL('../../packages/server/node_modules', import.meta.url), join(cwd, 'node_modules'));
  await writeFile(join(cwd, '.env'), 'CAMP_LISTEN_HOST=0.0.0.0\n');
  await writeFile(join(cwd, 'src/server.ts'), "import 'dotenv/config';import {createServer} from 'node:http';const server=createServer();server.listen(0,process.env.CAMP_LISTEN_HOST,()=>{console.log(JSON.stringify({address:server.address().address,pid:process.pid}));server.close();});\n");
  const unit = renderControlApiUnit({ checkout: directory, nodePath: process.execPath });
  const argv = unit.match(/^ExecStart=(.+)$/m)[1].match(/"[^"]*"|\S+/g).map(value => value.replace(/^"|"$/g, ''));
  const result = await execute(argv[0], argv.slice(1), { cwd, env: { PATH: process.env.PATH, CAMP_LISTEN_HOST: '0.0.0.0', DOTENV_CONFIG_OVERRIDE: 'true' }, timeout: 15000 });
  assert.equal(JSON.parse(result.stdout).address, '127.0.0.1');
});
