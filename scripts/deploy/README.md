# Control API service

Render a foreground API unit from the reviewed full checkout and its installed
server dependencies (this is separate from the minimal Worker release):

```sh
node scripts/deploy/control-api.mjs render \
  --checkout /opt/camp/control \
  --node-path /opt/node/bin/node \
  --env-file /etc/camp/control-api.env > /tmp/camp-control-api.service
systemd-analyze verify --man=no /tmp/camp-control-api.service
```

The renderer only prints unit text. It does not inspect processes or environment
files, provision credentials, install units, change Docker restart policies, or
start services. Paths must be canonical absolute ASCII paths without whitespace,
quotes, shell syntax or traversal; literal `%` is escaped for systemd. The default
environment file is `/etc/camp/control-api.env`. Rendering validates path syntax,
not filesystem ownership or symlinks: operators must use trusted, root-owned
checkout, Node and configuration paths that other users cannot replace.

Provision `/etc/camp` privately and `control-api.env` as root-owned mode `0600`.
Use systemd EnvironmentFile syntax (plain `NAME=value`, no `export` or shell
substitution). Set `PORT` to the selected local API port and provide the existing
server configuration, including `DATABASE_URL`, authentication/session secrets
and any enabled integration settings. Preserve their existing values during the
service transition; the renderer deliberately does not capture them. Do not put
Worker Room credentials or model provider keys in this file. Keep
`CAMP_LISTEN_HOST=127.0.0.1` or omit it. The final `env` assignment in `ExecStart`
enforces loopback even if an environment file contains a wildcard bind; `env`
executes Node in the same main PID. Avoid `NODE_OPTIONS` or other executable loader
overrides. The server also loads its working-directory `.env` through dotenv;
review that existing file and its permissions before changing the launch method.
`ExecStart` removes `DOTENV_CONFIG_OVERRIDE` so that file cannot replace the
enforced bind address, including when an old environment enables dotenv override.

The unit runs as root to match the current control deployment, with a private
temporary directory, no watch process, a five-second failure restart delay and a
90-second graceful stop window. Docker and network-online are required. Before
installing, the operator must separately ensure the existing dependency
containers have the intended persistent restart policy (`unless-stopped`) and
that the configured database is ready. Do not recreate or reset their data.

Review the rendered unit, then install it as
`/etc/systemd/system/camp-control-api.service` and explicitly run the normal
systemd reload/enable/start steps. Stop the previous API owner before starting
this unit so only one process owns the local port. Check loopback health and the
HTTPS reverse proxy independently. This script supplies neither a reverse proxy
nor a production secret-management mechanism.
