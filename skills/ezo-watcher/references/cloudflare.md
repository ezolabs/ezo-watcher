# Cloudflare

Cloudflare is the default way to put a Watcher on a hostname: a Tunnel holds an outbound connection from the machine running `watcher run`, Cloudflare serves the hostname, and nothing is exposed on the machine's network. It is $0, it needs no port forwarding, and the engine does not change.

```bash
watcher cloudflare quick                          # zero-account rung: an ephemeral URL
watcher cloudflare tunnel --hostname watch.example.com
watcher cloudflare tunnel --hostname watch.example.com --access-email you@example.com
```

## Credentials

The CLI reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the environment or from `.watcher/.env` (a value passed with `--secret-value`, or written once by hand).

Create the token in the Cloudflare dashboard: **My Profile → API Tokens → Create Token → Custom token**. The minimum permissions:

| Scope | Permission | Why |
| --- | --- | --- |
| Account → Cloudflare Tunnel | **Edit** (shown as Write) | Find or create the tunnel, write its ingress config, read its token |
| Zone → DNS | **Edit** (shown as Write) | Upsert the proxied CNAME for the hostname |
| Account → Access: Apps and Policies | **Edit** | Only with `--access-email`: create the Access application and its bypass policies |

Scope **Zone Resources** to the one zone, and **Account Resources** to the one account. Nothing else is needed: do not grant Workers, Pages, DNS Firewall or account-wide Access.

`CLOUDFLARE_ACCOUNT_ID` is the account id from the dashboard's account home (a 32-hex string), not the zone id.

## What `watcher cloudflare tunnel --hostname` does

1. Verifies the token (`GET /user/tokens/verify`) and resolves the zone whose apex owns the hostname (`GET /zones?name=<apex>`). A hostname whose zone is not on this account fails `cloudflare.zone-missing` with a `next` — do not create the zone for the user.
2. Finds or creates a remotely managed tunnel named `watcher-<project>`. Re-running is safe: it reuses the tunnel rather than making a second one.
3. Writes the ingress configuration: `<hostname> → http://127.0.0.1:<WATCHER_PORT>`, then a catch-all `http_status: 404` so no other Host reaches the app.
4. Upserts a proxied CNAME `<hostname> → <tunnel-id>.cfargotunnel.com` in the zone (create if absent; point an existing record at the tunnel).
5. Fetches the tunnel's run token into `.watcher/.env` as `CLOUDFLARE_TUNNEL_TOKEN` (0600, gitignored) and prints the `cloudflared` run command. If the CLI manages a service for the Watcher, `watcher service install --with-tunnel` hooks cloudflared in beside it.
6. Checks `cloudflared` is on `PATH` (`cloudflare.cloudflared-missing`, with the brew/apt install line as `next`).

All steps are idempotent and `--dry-run` prints the plan without calling the API. Nothing about the API token is printed or logged.

**Binding note:** with a tunnel, the Watcher stays on `127.0.0.1` and Cloudflare is the only way in — good. The tunnel makes the wall reachable from the internet, so set `WATCHER_ADMIN_TOKEN` and run `watcher doctor --live --prove` afterwards. Cloudflare Access is an extra layer, not a substitute for it.

## Access (optional)

`--access-email <email>` creates a Cloudflare Access application for the hostname with a one-email allow policy, plus **bypass** policies for the paths that carry their own auth:

- `/ingest/*` — each source's bearer token;
- `/mcp` — `WATCHER_MCP_TOKEN`;
- `/healthz` — a liveness answer with no data.

Without the bypasses, a webhook sender and an MCP client would be stopped at the Access login. Access is identity for humans; the service paths keep their own keys.

## The zero-account rung

```bash
watcher cloudflare quick
```

Runs `cloudflared tunnel --url http://127.0.0.1:<WATCHER_PORT>` and prints an ephemeral `https://<random>.trycloudflare.com` URL. It needs no Cloudflare account, no zone and no API token — and it is **public**, so `WATCHER_ADMIN_TOKEN` is required before it starts. The URL changes every run and dies with the process: it is a demo or a phone test, never the user's monitoring host.

## Verify and troubleshoot

```bash
watcher doctor --target cloudflare --json
```

checks the token is present and valid, the zone is on the account, the tunnel exists and is healthy, and the DNS record points at it. The checks carry the same `{ code, status, message, next }` shape as every other doctor check.

| Code (where one is named) | Meaning | First fix |
| --- | --- | --- |
| `cloudflare.zone-missing` | The hostname's zone is not on this account | Use a hostname on a zone the account holds, or add the zone in Cloudflare first |
| `cloudflare.cloudflared-missing` | `cloudflared` is not on `PATH` | `brew install cloudflared` (macOS) or the apt package (Linux), then re-run |
| token refused | `GET /user/tokens/verify` refused the token | Recreate the token with the permissions above |
| tunnel unhealthy | The tunnel exists but has no healthy connector | Start the printed `cloudflared` command (or the service) on the Watcher's host |
| DNS record missing | No record for the hostname | Re-run `watcher cloudflare tunnel --hostname …`; the upsert is idempotent |

A token that lacks one permission fails at the first call that needs it; `watcher doctor --target cloudflare` names the missing permission in `message` and puts the dashboard edit in `next`.

## Containers (beta)

For a user with a Cloudflare account and **no host at all**, `deploy/cloudflare/containers/` is a beta template: a wrangler configuration and a Container class that runs the Watcher image. Say the limits out loud before recommending it:

- it cannot probe anything on the user's LAN;
- it is billed while kept awake (~$9.57/month);
- an idle instance is stopped after about 6 hours.

It is right for a public site; wrong for a home lab or anything that must watch a local port.

## Not yet

A Workers port (SQLite in a Durable Object behind the sync SQL seam) is a later project, not a hosting option today. Do not offer it as one.
