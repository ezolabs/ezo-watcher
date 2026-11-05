# Hosting

Run the Watcher beside the project it watches. Pick the first rung that meets the user's requirement; each rung keeps the same `watcher run` process, the same `.watcher/config.json` and the same data directory. The one rule that never changes: **the Watcher watches a project; it is not a multi-tenant service.** One `.watcher/` per project.

| # | Rung | Pick when | Needs | Cost |
| --- | --- | --- | --- | --- |
| 1 | Local process | The default; the user develops on this machine | Node 24 | $0 |
| 2 | Service (launchd / systemd --user) | It must survive reboot and logout | Nothing more | $0 |
| 3 | Docker / a VPS | It must run on a server, or beside other containers | Docker, or a Linux host | host cost |
| 4 | Cloudflare Tunnel | "Host it with my Cloudflare key" — the default hosted answer | A domain on Cloudflare, `cloudflared` | $0 |
| 5 | Cloudflare Containers (beta) | No host at all, and a domain on Cloudflare | A Cloudflare account | ~$9.57/mo kept awake |
| 6 | Workers edge port | Not yet — a later port (the SQL layer is sync today) | — | — |

## 1. Local

```bash
watcher run --detach          # background: writes .watcher/data/watcher.pid and a log file
watcher stop                  # end it
watcher run                   # or foreground, for a first look at the logs
```

Default bind is `127.0.0.1` on `WATCHER_PORT` (7717 unless `watcher init` picked the next free port). On loopback, `WATCHER_ADMIN_TOKEN` is optional. Open `http://127.0.0.1:7717` to see the wall.

The Watcher does not build anything at runtime: `watcher run` uses the built web assets in the package, or builds them once on demand if you run from a checkout. A first run may spend a few seconds on that build and says so.

## 2. Service: survive a reboot

```bash
watcher service install       # launchd LaunchAgent (macOS) or systemd --user unit (Linux)
watcher service uninstall
```

The unit runs `watcher run` in the project directory, so the project path must exist at login. On Linux, `systemctl --user` needs lingering enabled to run without a login session (`loginctl enable-linger "$USER"`). On Windows, use `watcher run --detach` and Task Scheduler; `watcher service install` covers launchd and systemd only.

## 3. Docker or a VPS

A `Dockerfile` and `compose.yaml` are in the repository. The image is Node 24 slim with the built web assets and the one-file server; the compose file mounts the project's `.watcher/config.json` read-only and `.watcher/data/` writable, and loads `.watcher/.env` with `env_file`:

```yaml
services:
  watcher:
    build: .
    restart: unless-stopped
    env_file: .watcher/.env          # WATCHER_ACK_SECRET, WATCHER_ADMIN_TOKEN, WATCHER_MCP_TOKEN
    environment:
      WATCHER_CONFIG: /app/.watcher/config.json
      WATCHER_DATA_DIR: /app/.watcher/data
      WATCHER_HOST: 0.0.0.0
      WATCHER_PORT: "7717"
    ports: ["7717:7717"]
    volumes:
      - ./.watcher/data:/app/.watcher/data
      - ./.watcher/config.json:/app/.watcher/config.json:ro
```

```bash
docker compose up -d
```

Because the container binds `0.0.0.0`, the server requires `WATCHER_ADMIN_TOKEN`; `watcher init` writes one into `.watcher/.env`, which `env_file` supplies. A publicly reachable wall with no auth is the failure this rule exists to prevent. To keep it off the network entirely, change `ports` to `"127.0.0.1:7717:7717"` and put a tunnel or reverse proxy in front. `/healthz`, `/ingest/*` (each source's own token) and `/mcp` (its own token) keep their own auth.

If the Watcher is behind nginx/Caddy, terminate TLS there and keep the app on `127.0.0.1:7717`; the app needs nothing special (streaming MCP is plain JSON over POST). Set `baseUrl` in `.watcher/config.json` to the public https URL so links in notifications point somewhere a phone can open.

**A VPS is the right rung when the user wants the Watcher to see the project from outside.** A prober on the same host sees `127.0.0.1` up even when the public path is broken; add one external target (the public readiness URL) or host the Watcher where it can reach the real endpoint.

## 4. Cloudflare Tunnel (the default hosted answer)

Use this whenever the user says "host it with my Cloudflare key" (or hands over a `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`). It needs a hostname whose zone is on the account; it costs nothing and changes nothing in the engine: cloudflared holds an outbound connection, Cloudflare serves the hostname, the Watcher keeps listening on `127.0.0.1`.

```bash
watcher cloudflare tunnel --hostname watch.example.com
```

That creates or reuses a tunnel named for the project, writes its ingress (`watch.example.com → http://127.0.0.1:7717`, catch-all 404), upserts the proxied DNS record, fetches the run token into `.watcher/.env`, and prints the cloudflared command (or hooks it into `watcher service install --with-tunnel`). Add `--access-email you@example.com` to put Cloudflare Access in front of the wall, with bypass policies for `/ingest/*`, `/mcp` and `/healthz`. Full detail, token permissions and failure codes: `watcher skills cloudflare`.

No domain on Cloudflare yet? `watcher cloudflare quick` gives an ephemeral public URL for a demo; it is public, so set `WATCHER_ADMIN_TOKEN` first. Do not hand a user a quick tunnel as their monitoring host.

## 5. Cloudflare Containers (beta)

For a user with a Cloudflare account and no host: the beta template in `deploy/cloudflare/containers/` runs the same image in a Container class. Limits to say out loud: it cannot probe the user's LAN, it is billed while kept awake (~$9.57/mo), and an idle instance is torn down after about 6 hours. Good for a public site; wrong for a home lab.

## 6. Workers edge port

Not yet. A Workers build would need the synchronous SQL layer replaced behind a thin seam; it is a later port, not a hosting option today.

## What to back up

| Path | Committed? | Back up? |
| --- | --- | --- |
| `.watcher/config.json` | Yes — monitoring as code | It is in git |
| `.watcher/.env` | No (0600, gitignored) | Yes, in a secret manager |
| `.watcher/data/` | No | Optional: sqlite with the 30-day history |

## Moving an install

Copy `.watcher/` (config, `.env`, data) to the new host, install the CLI there, and run `watcher doctor --live --prove`. Change `baseUrl` if the public URL changed. Nothing else moves: there is no database server and no account.

## The doctor's hosting checks

`watcher doctor --json` checks the port is free or the server is up (`port.in-use` names a process that is not this Watcher), the data directory is writable (`data.unwritable` with the resolved path), and the required secrets are set (`secret.missing`). `--target cloudflare` adds the token, zone, tunnel health and DNS checks; `--live` reads the running server instead of starting a second one.
