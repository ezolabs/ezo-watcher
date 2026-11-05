# EZO Watcher on Cloudflare Containers (BETA)

For a user with no host to run the Watcher on. One container instance runs the same image as the
repo's `Dockerfile` (`node dist/server/main.mjs` on port 7717), and a Worker routes every request to
it. This is a **beta** template: it deploys, but the limits below decide whether it fits you.

## Deploy

```bash
# in deploy/cloudflare/containers/
npx wrangler secret put WATCHER_ACK_SECRET   # openssl rand -hex 32
npx wrangler secret put WATCHER_ADMIN_TOKEN  # openssl rand -hex 32
npx wrangler secret put WATCHER_MCP_TOKEN    # openssl rand -hex 32
npx wrangler deploy                          # Docker must be running (it builds the image)
```

The container reads `/app/.watcher/config.json`. This template's `wrangler.jsonc` passes a minimal
config as `WATCHER_CONFIG_JSON`; the Worker does not write it into the image, so to run a real
config you either build an image with `.watcher/config.json` inside it, or mount the config from
Durable Object storage/R2 (a small change to `src/index.ts`). The wall's data dir is
`/app/.watcher/data`, which is container-local and ephemeral.

## Limits that decide whether this is the right rung

| Limit | Consequence |
|---|---|
| **No LAN reach** | the container cannot probe `192.168.x.x`, `10.x.x.x`, a NAS or a home router. Only public URLs work. |
| **Cost** | Workers Paid is required. A lite instance kept awake 24/7 is about **$9.57/month** ($5 plan + $4.57 usage, from the published rates at 730 h/month). Letting it sleep costs less. |
| **Inactivity cap** | `setInactivityTimeout` maxes at **6 h** (21,600,000 ms); the Container class default `sleepAfter` is 10 minutes. A sleeping container answers in 1-3 s and its timers do not run, so a probe cadence longer than `sleepAfter` needs the container kept awake or the schedule moved to a Worker cron. |
| **Ephemeral disk** | the Watcher's SQLite is on local disk: history resets when the container restarts unless `/app/.watcher` is snapshot-backed. |
| **No inbound TCP/UDP** | only HTTP(S) reaches the container. A tcp-probe source pointing at this container cannot work. |
| **Outbound body** | 100 MiB per response; fine for the wall and the API. |

## What this template is not

It is not a deploy pipeline: no image push to the Cloudflare registry, no preview environment, no
access control. For a production Watcher, `watcher cloudflare tunnel --hostname` in front of a host
you own (or the Docker/compose path) keeps the history and the LAN probes.

## API references (retrieved 2026-11-04)

- Containers overview and get started (last updated 2026-09-30):
  <https://developers.cloudflare.com/containers/get-started/>
- Container class API (last updated 2026-09-30):
  <https://developers.cloudflare.com/containers/api/container-class/>
- Containers limits and instance types (last updated 2026-11-02):
  <https://developers.cloudflare.com/containers/platform/limits/>
- Containers pricing (last updated 2026-10-05):
  <https://developers.cloudflare.com/containers/platform/pricing/>
- Durable Object Container API, `setInactivityTimeout` (last updated 2026-09-30):
  <https://developers.cloudflare.com/containers/api/durable-object-container/>
