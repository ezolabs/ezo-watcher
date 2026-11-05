// BETA: EZO Watcher on Cloudflare Containers, for a user with no host to run it on.
//
// One container instance runs the same image the Dockerfile builds (node dist/server/main.mjs,
// listening on 7717). The Worker routes every request to one named instance, so the wall, the
// ingests and MCP all talk to the same SQLite file inside that instance.
//
// Limits this template cannot fix (measured in the hosting research, 2026-11-04):
//   - NO LAN PROBES: a container on Cloudflare's network cannot reach 192.168.x.x, 10.x.x.x or a
//     home NAS. Only public URLs are probeable; a private target needs the local Docker/compose path.
//   - COST: Workers Paid is required. A lite instance kept awake 24/7 is about $9.57/month
//     ($5 plan + $4.57 overage, from the published rates at 730 h/month). Idle sleep reduces it.
//   - INACTIVITY: the Durable Object Container API caps setInactivityTimeout at 6 h (21,600,000 ms);
//     the Container class default sleepAfter is 10 minutes. A sleeping container takes 1-3 s to
//     answer the next request, and its timers do not run while it sleeps, so a probe cadence longer
//     than sleepAfter needs the container kept awake or the watchdog moves to a Worker cron.
//   - STORAGE: container disk is ephemeral unless snapshotted; Durable Object SQLite persists, but
//     the Watcher writes SQLite on local disk, so the wall's history resets on a container restart
//     unless /app/.watcher is snapshot-backed.
//   - OUTBOUND BODY: 100 MiB per response; inbound non-HTTP TCP/UDP is not supported.
//
// Deploy: `npx wrangler deploy` from this directory (Docker must be running), then set the secrets:
//   npx wrangler secret put WATCHER_ACK_SECRET
//   npx wrangler secret put WATCHER_ADMIN_TOKEN
//   npx wrangler secret put WATCHER_MCP_TOKEN
// and put config.json in an image or a KV/R2 mount the container can read (the built image expects
// /app/.watcher/config.json). This template is a starting point, not a served product.

import { Container, getContainer } from '@cloudflare/containers'

interface Env {
  WATCHER: DurableObjectNamespace<WatcherContainer>
  WATCHER_ACK_SECRET: string
  WATCHER_ADMIN_TOKEN: string
  WATCHER_MCP_TOKEN: string
  /** The project config, JSON, one line. See config/watch.example.json. */
  WATCHER_CONFIG_JSON: string
}

export class WatcherContainer extends Container {
  defaultPort = 7717
  /** Keep it warm for 10 minutes after the last request; the class default, made explicit. */
  sleepAfter = '10m'
  enableInternet = true

  override async fetch(request: Request): Promise<Response> {
    // The config and the secrets arrive per start, from Worker secrets, never baked into the image.
    await this.startAndWaitForPorts({
      ports: [7717],
      startOptions: {
        envVars: {
          WATCHER_HOST: '0.0.0.0',
          WATCHER_PORT: '7717',
          WATCHER_DATA_DIR: '/app/.watcher/data',
          WATCHER_CONFIG: '/app/.watcher/config.json',
          WATCHER_ACK_SECRET: this.env.WATCHER_ACK_SECRET,
          WATCHER_ADMIN_TOKEN: this.env.WATCHER_ADMIN_TOKEN,
          WATCHER_MCP_TOKEN: this.env.WATCHER_MCP_TOKEN
        }
      }
    })
    return this.containerFetch(request)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // One instance: every request must see the same wall and the same SQLite file.
    return getContainer(env.WATCHER, 'watcher-singleton').fetch(request)
  }
}
