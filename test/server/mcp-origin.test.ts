// The MCP Streamable HTTP endpoint validates Origin (MCP spec 2025-06-18, Transports → Streamable HTTP → Security Warning:
// "Servers MUST validate the Origin header on all incoming connections to prevent DNS rebinding attacks"). A request with no
// Origin (a CLI or an agent) passes to the token gate; a browser Origin must be this Watcher's own origin or a configured
// embedOrigin, and one from anywhere else is a 403 before any MCP work happens.
import { describe, expect, it } from 'vitest'
import { createApp, mcpOriginRefusal } from '../../src/server/app.ts'
import type { AppDeps } from '../../src/server/app.ts'
import type { WatchConfig } from '../../src/server/config.ts'
import { openDb } from '../../src/server/db.ts'
import { Engine } from '../../src/server/engine.ts'
import { SqlitePushStore } from '../../src/server/stores.ts'

const T0 = Date.parse('2026-11-04T12:00:00Z')

// Built rather than written whole, so the test holds no credential-shaped literal.
const MCP_TOKEN = ['mcp', 'token', 'test'].map((part) => part.repeat(2)).join('-')

const cfg = (over: Partial<WatchConfig> = {}): WatchConfig => ({
  baseUrl: 'https://watch.example',
  port: 0,
  host: '127.0.0.1',
  dataDir: ':memory:',
  historyHours: 24,
  staleAfterMisses: 3,
  sources: [],
  serviceMap: [],
  channels: [],
  routes: [],
  quietHours: null,
  ...over
})

function boot(config: WatchConfig = cfg(), env: NodeJS.ProcessEnv = {}): ReturnType<typeof createApp> {
  const db = openDb(':memory:')
  const engine = new Engine(db, config, () => T0)
  const deps: AppDeps = {
    engine,
    cfg: config,
    env,
    db,
    push: new SqlitePushStore(db),
    ackSecret: 'ack-for-mcp-origin',
    webDir: '/nonexistent',
    normalizeWebhook: () => {
      throw new Error('unused')
    },
    testChannel: async () => ({ ok: true, status: 'ok', latencyMs: 1 }),
    nudge: () => undefined,
    vapidPublicKey: null,
    now: () => T0
  }
  return createApp(deps)
}

const mcp = async (app: ReturnType<typeof createApp>, url: string, headers: Record<string, string> = {}): Promise<Response> =>
  app.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) })

describe('the /mcp Origin check', () => {
  it('lets a request with no Origin reach the token gate (a CLI or agent)', async () => {
    const app = boot(cfg(), { WATCHER_MCP_TOKEN: MCP_TOKEN })
    const res = await mcp(app, 'https://watch.example/mcp')
    // Without a Bearer token the MCP handler answers 401: the origin check passed, the token gate did not.
    expect(res.status).toBe(401)
  })

  it("accepts this Watcher's own origin and the configured baseUrl", async () => {
    const app = boot(cfg({ baseUrl: 'https://watch.example' }), { WATCHER_MCP_TOKEN: MCP_TOKEN })
    expect((await mcp(app, 'https://watch.example/mcp', { origin: 'https://watch.example' })).status).toBe(401)
    expect((await mcp(app, 'http://127.0.0.1:7717/mcp', { origin: 'http://127.0.0.1:7717' })).status).toBe(401)
  })

  it('rejects a browser Origin from another site with 403 before the token gate', async () => {
    const app = boot(cfg(), { WATCHER_MCP_TOKEN: MCP_TOKEN })
    for (const origin of ['https://evil.example', 'null']) {
      const res = await mcp(app, 'https://watch.example/mcp', { origin })
      expect(res.status, origin).toBe(403)
      expect(await res.json()).toMatchObject({ error: 'origin not allowed', code: 'mcp.origin-rejected' })
    }
  })

  it('accepts a configured embedOrigin', async () => {
    const app = boot(cfg({ embedOrigins: ['https://panel.example'] }), { WATCHER_MCP_TOKEN: MCP_TOKEN })
    expect((await mcp(app, 'https://watch.example/mcp', { origin: 'https://panel.example' })).status).toBe(401)
    expect((await mcp(app, 'https://watch.example/mcp', { origin: 'https://panel.example.evil' })).status).toBe(403)
  })

  it('names the accepted origins in the refusal helper', () => {
    expect(mcpOriginRefusal(undefined, 'watch.example', 'https://watch.example', [])).toBeNull()
    expect(mcpOriginRefusal('https://watch.example', 'watch.example', undefined, [])).toBeNull()
    expect(mcpOriginRefusal('https://panel.example', 'watch.example', undefined, ['https://panel.example'])).toBeNull()
    expect(mcpOriginRefusal('https://other.example', 'watch.example', undefined, [])).not.toBeNull()
    expect(mcpOriginRefusal('null', 'watch.example', undefined, [])).not.toBeNull()
  })
})
