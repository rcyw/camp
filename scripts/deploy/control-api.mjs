import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const invalid = () => Object.assign(new Error('Invalid control API unit configuration; use canonical absolute paths and the documented render arguments'), { code: 'camp_control_api_invalid' });

// Lexical validation only: rendering neither reads nor changes the checkout,
// executable, private environment file or systemd installation.
function canonicalPath(value) {
  if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value) || value === '/' || !/^\/[A-Za-z0-9_./%-]+$/.test(value) || resolve(value) !== value) throw invalid();
  return value;
}

// A literal percent must survive systemd's specifier expansion. Other syntax
// characters (quotes, whitespace, dollars, backslashes and controls) are rejected.
const escapePath = value => value.replaceAll('%', '%%');
const quotePath = value => `"${escapePath(value)}"`;

/** Return only the unit text. Installation and private environment provisioning
 * remain explicit operator actions. No filesystem or process inspection occurs. */
export function renderControlApiUnit(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['checkout', 'nodePath', 'envFile'].includes(key))) throw invalid();
  const checkout = canonicalPath(input.checkout);
  const nodePath = canonicalPath(input.nodePath);
  const envFile = canonicalPath(input.envFile === undefined ? '/etc/camp/control-api.env' : input.envFile);
  return `[Unit]
Description=Camp control API
Requires=docker.service network-online.target
After=docker.service network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${escapePath(checkout + '/packages/server')}
EnvironmentFile=${escapePath(envFile)}
Environment="CAMP_LISTEN_HOST=127.0.0.1"
ExecStart=${quotePath(nodePath)} --import @oxc-node/core/register src/server.ts
Restart=on-failure
RestartSec=5s
KillSignal=SIGTERM
TimeoutStopSec=90s
KillMode=mixed
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
StandardOutput=journal
StandardError=journal
SyslogIdentifier=camp-control-api

[Install]
WantedBy=multi-user.target
`;
}

export function controlApiMain(argv) {
  if (!Array.isArray(argv) || argv[0] !== 'render') throw invalid();
  const keys = { '--checkout': 'checkout', '--node-path': 'nodePath', '--env-file': 'envFile' };
  const input = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = keys[argv[index]];
    if (!key || input[key] !== undefined || argv[index + 1] === undefined) throw invalid();
    input[key] = argv[index + 1];
  }
  return renderControlApiUnit(input);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(controlApiMain(process.argv.slice(2))); }
  catch { process.stderr.write('camp_control_api_invalid: invalid render arguments\n'); process.exitCode = 1; }
}
