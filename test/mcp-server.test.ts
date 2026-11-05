// The MCP endpoint end to end through the Hono app: the bearer gate, the tool list with its hints and required `by`, the read tools, and each
// write tool's attribution and limits. Written, not run, in the session that added it (checks were off). The token below is a test value.
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/server/app.ts'
import type { AppDeps } from '../src/server/app.ts'
import type { WatchConfig } from '../src/server/config.ts'
import { makeAlert } from '../src/server/derive.ts'
import { openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'
import { SqlitePushStore } from '../src/server/stores.ts'
import { COMMENT_MAX } from '../src/shared/agent.ts'
import type { Alert, Observation } from '../src/shared/types.ts'

const T0 = Date.parse('2026-10-15T12:00:00Z')
let clock = T0
const iso = (ms = clock): string => new Date(ms).toISOString()
const TOKEN = 'mcp-test-token-'.padEnd(64, '0')

const cfg: WatchConfig = {
  baseUrl: 'https://watch.test',
  port: 0,
  host: '127.0.0.1',
  dataDir: ':memory:',
  historyHours: 24,
  staleAfterMisses: 3,
  sources: [{ id: 'grafana', type: 'grafana', url: 'http://g', tokenEnv: 'X', pollSec: 10 }],
  serviceMap: [],
  channels: [],
  routes: [],
  quietHours: null
}

const raised = (): Alert =>
  makeAlert(
    {
      origin: 'grafana',
      fingerprint: 'a1b2c3d4e5f60718',
      rule: 'DiskFull',
      labels: { alertname: 'DiskFull', severity: 'warning', host: 'node-4', service: 'Disk' },
      annotations: { summary: 'DiskFull on node-4' },
      startsAt: iso(clock - 60_000),
      via: { source: 'grafana', kind: 'grafana', lastSeen: iso() },
      raw: {},
      links: {}
    },
    [],
    iso()
  )
const poll = (firing: Alert[]): Observation => ({ source: 'grafana', kind: 'grafana', at: iso(), firing, resolved: [], complete: true })

let engine: Engine
let nudges: number
function boot(env: NodeJS.ProcessEnv = { WATCHER_MCP_TOKEN: TOKEN }) {
  const deps: AppDeps = {
    engine,
    cfg,
    env,
    db: engine.db,
    push: new SqlitePushStore(engine.db),
    ackSecret: ['mcp', 'test', '0001'].join('-'),
    webDir: '/nonexistent',
    normalizeWebhook: () => {
      throw new Error('unused')
    },
    testChannel: async () => ({ ok: true, status: 'ok', latencyMs: 1 }),
    nudge: () => void (nudges += 1),
    vapidPublicKey: null,
    now: () => clock,
    log: () => undefined
  }
  return createApp(deps)
}

beforeEach(() => {
  clock = T0
  nudges = 0
  engine = new Engine(openDb(':memory:'), cfg, () => clock)
})

let rpcId = 0
async function call(app: ReturnType<typeof boot>, method: string, params: unknown, token: string | null = TOKEN): Promise<Response> {
  return app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: (rpcId += 1), method, params })
  })
}
type Rpc = { error?: { message: string }; result?: { isError?: boolean; content?: Array<{ text: string }>; tools?: Array<{ name: string; inputSchema: { required?: string[] }; annotations: Record<string, boolean> }> } }
const rpcOf = async (r: Response): Promise<Rpc> => (await r.json()) as Rpc
async function tool(app: ReturnType<typeof boot>, name: string, args: Record<string, unknown>): Promise<{ refused: boolean; text: string; data: any }> {
  const r = await rpcOf(await call(app, 'tools/call', { name, arguments: args }))
  const text = r.error?.message ?? r.result?.content?.[0]?.text ?? ''
  const refused = Boolean(r.error) || r.result?.isError === true
  let data: unknown = null
  try {
    data = JSON.parse(text)
  } catch {
    // an error text is not JSON
  }
  return { refused, text, data }
}
const fire = (): string => {
  engine.ingest(poll([raised()]))
  return engine.wall().incidents[0].key
}

describe('the bearer gate', () => {
  it('answers 401 without a token, with a wrong one, and always when the host has none or a short one', async () => {
    expect((await call(boot(), 'tools/list', {}, null)).status).toBe(401)
    expect((await call(boot(), 'tools/list', {}, 'wrong-token')).status).toBe(401)
    expect((await call(boot({}), 'tools/list', {}, TOKEN)).status).toBe(401)
    expect((await call(boot({ WATCHER_MCP_TOKEN: 'short' }), 'tools/list', {}, 'short')).status).toBe(401)
    const res = await call(boot(), 'tools/list', {}, null)
    expect(res.headers.get('www-authenticate')).toContain('Bearer')
    expect(await res.text()).not.toContain(TOKEN)
  })

  it('answers 405 to a GET and a DELETE with the token, and never serves the wall shell at /mcp', async () => {
    const app = boot()
    for (const method of ['GET', 'DELETE']) {
      const res = await app.request('/mcp', { method, headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'text/event-stream' } })
      expect(res.status).toBe(405)
    }
    expect((await app.request('/mcp', { method: 'GET' })).status).toBe(401)
  })
})

describe('tools/list', () => {
  it('lists the sixteen tools, marks reads read-only, every write needs by, and only silence, park, unacknowledge, unpark and resolve are destructive', async () => {
    const r = await rpcOf(await call(boot(), 'tools/list', {}))
    const tools = r.result?.tools ?? []
    expect(tools.map((t) => t.name)).toEqual([
      'watch_state', 'list_incidents', 'get_incident', 'get_fix_context', 'incident_history', 'list_sources',
      'acknowledge', 'unacknowledge', 'silence', 'park', 'unpark', 'comment', 'recheck', 'verify_fix', 'resolve', 'confirm_resolution'
    ])
    const reads = new Set(['watch_state', 'list_incidents', 'get_incident', 'get_fix_context', 'incident_history', 'list_sources'])
    for (const t of tools) {
      expect(t.annotations.readOnlyHint).toBe(reads.has(t.name))
      if (!reads.has(t.name)) expect(t.inputSchema.required).toContain('by')
    }
    expect(tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort()).toEqual(['park', 'resolve', 'silence', 'unacknowledge', 'unpark'])
    expect(tools.find((t) => t.name === 'recheck')?.annotations.openWorldHint).toBe(true)
  })

  it('park says in its description to park only after a fix or a verdict and never to hide a live problem', async () => {
    const r = await rpcOf(await call(boot(), 'tools/list', {}))
    const park = (r.result?.tools ?? []).find((t) => t.name === 'park') as { description?: string; inputSchema: { required?: string[] } } | undefined
    expect(park?.description).toMatch(/only after a fix or a verdict/i)
    expect(park?.description).toMatch(/never to hide a live problem/i)
    expect(park?.inputSchema.required).toEqual(expect.arrayContaining(['key', 'state', 'until', 'by', 'note']))
  })
})

describe('read tools', () => {
  it('watch_state counts what is firing and who has it', async () => {
    const key = fire()
    const app = boot()
    engine.ack(key, 'agent: claude')
    const { data } = await tool(app, 'watch_state', {})
    expect(data.counts).toMatchObject({ firing: 1, acknowledged: 1, unattended: 0, warning: 1 })
    expect(data.incidents[0]).toMatchObject({ key, attention: 'acked', ackedBy: 'agent: claude' })
  })

  it('get_incident carries the alerts, the history with who, and the comments, and no raw payload', async () => {
    const key = fire()
    const app = boot()
    await tool(app, 'acknowledge', { key, by: 'claude', note: 'on it' })
    await tool(app, 'comment', { key, by: 'agent: claude', text: 'disk is the wal volume' })
    const { data, text } = await tool(app, 'get_incident', { key })
    expect(data.state).toBe('firing')
    expect(data.alerts[0]).toMatchObject({ key: 'grafana:a1b2c3d4', rule: 'DiskFull' })
    expect(data.history.some((h: { text: string }) => h.text === 'Acknowledged by agent: claude. Note: on it')).toBe(true)
    expect(data.comments[0]).toMatchObject({ by: 'agent: claude', agent: true, text: 'disk is the wal volume' })
    expect(text).not.toContain('"raw"')
  })

  it('get_incident for a key Watch never held is a refusal that points at the listing tools', async () => {
    const r = await tool(boot(), 'get_incident', { key: 'No|Such' })
    expect(r.refused).toBe(true)
    expect(r.text).toContain('watch_state')
  })

  it('refuses a tool this server does not have as unknown, never as a silent success', async () => {
    // env_compare was dropped in extraction; a client that still calls it must be told, not answered with nothing.
    const r = await tool(boot(), 'env_compare', { pair: 'nope' })
    expect(r.refused).toBe(true)
    expect(r.text.toLowerCase()).toContain('env_compare')
    expect(r.text.toLowerCase()).toMatch(/not found|unknown/)
  })
})

describe('write tools are attributed, limited and never resolve an alert', () => {
  it('refuse a call with no by, and name the author "agent: <who>" when it is given bare', async () => {
    const key = fire()
    const app = boot()
    expect((await tool(app, 'acknowledge', { key })).refused).toBe(true)
    expect((await tool(app, 'acknowledge', { key, by: '   ' })).refused).toBe(true)
    expect(engine.wall().incidents[0].ackedBy).toBeNull()
    expect((await tool(app, 'acknowledge', { key, by: 'claude, api' })).refused).toBe(false)
    expect(engine.wall().incidents[0].ackedBy).toBe('agent: claude, api')
    expect(nudges).toBeGreaterThan(0)
  })

  it('unacknowledge takes the ack off and is recorded with who', async () => {
    const key = fire()
    const app = boot()
    await tool(app, 'acknowledge', { key, by: 'agent: claude' })
    await tool(app, 'unacknowledge', { key, by: 'agent: claude', note: 'handing back' })
    expect(engine.wall().incidents[0].state.attention).toBe('none')
    expect(engine.incidentDetail(key).events.find((e) => e.kind === 'unack')?.detail).toMatchObject({ by: 'agent: claude', note: 'handing back' })
  })

  it('silence is capped at 240 minutes (refused, not shortened) and needs a reason', async () => {
    const key = fire()
    const app = boot()
    expect((await tool(app, 'silence', { key, by: 'agent: claude', minutes: 241, reason: 'reboot' })).refused).toBe(true)
    expect((await tool(app, 'silence', { key, by: 'agent: claude', minutes: 60 })).refused).toBe(true)
    expect(engine.wall().incidents[0].state.attention).toBe('none')
    const ok = await tool(app, 'silence', { key, by: 'agent: claude', minutes: 240, reason: 'planned reboot of node-4' })
    expect(ok.refused).toBe(false)
    expect(ok.data.minutes).toBe(240)
    const i = engine.wall().incidents[0]
    expect(i.state.attention).toBe('silenced')
    expect(i.silencedBy).toBe('agent: claude')
    expect(engine.incidentDetail(key).events.find((e) => e.kind === 'silence')?.detail).toMatchObject({ reason: 'planned reboot of node-4' })
  })

  it('comment accepts 4000 characters and refuses 4001, and stores the author', async () => {
    const key = fire()
    const app = boot()
    expect((await tool(app, 'comment', { key, by: 'agent: claude', text: 'x'.repeat(COMMENT_MAX + 1) })).refused).toBe(true)
    expect(engine.comments(key)).toHaveLength(0)
    const r = await tool(app, 'comment', { key, by: 'agent: claude', text: 'x'.repeat(COMMENT_MAX) })
    expect(r.refused).toBe(false)
    expect(r.data).toMatchObject({ ok: true })
    expect(engine.comments(key)[0]).toMatchObject({ by: 'agent: claude' })
    // the incident API carries the comments for the sheet
    const api = (await (await app.request(`/api/incidents/${encodeURIComponent(key)}`)).json()) as { comments: Array<{ by: string }> }
    expect(api.comments[0].by).toBe('agent: claude')
  })

  it('resolve marks the incident resolved with who and why, and the source still firing reopens it', async () => {
    const key = fire()
    const app = boot()
    expect((await tool(app, 'resolve', { key, by: 'agent: claude' })).refused).toBe(true)
    const r = await tool(app, 'resolve', { key, by: 'agent: claude', reason: 'freed the wal volume' })
    expect(r.refused).toBe(false)
    expect(r.data).toMatchObject({ ok: true, alertsResolved: 1 })
    expect(engine.wall().incidents).toHaveLength(0)
    expect(engine.history(24)[0].manual).toEqual({ by: 'agent: claude', reason: 'freed the wal volume' })
    clock += 10_000
    engine.ingest(poll([raised()]))
    expect(engine.wall().incidents[0].state.attention).toBe('none')
    expect(engine.incidentDetail(key).events.some((e) => e.kind === 'reopened')).toBe(true)
  })

  it('confirm_resolution is refused while firing and recorded after a source resolves', async () => {
    const key = fire()
    const app = boot()
    expect((await tool(app, 'confirm_resolution', { key, by: 'agent: claude' })).refused).toBe(true)
    clock += 60_000
    engine.ingest(poll([]))
    const r = await tool(app, 'confirm_resolution', { key, by: 'agent: claude', note: 'PR 4821' })
    expect(r.refused).toBe(false)
    expect(engine.history(24)[0].confirmed).toMatchObject({ by: 'agent: claude', note: 'PR 4821' })
  })

  it('there is no tool that resolves, deletes or edits an alert', async () => {
    const r = await rpcOf(await call(boot(), 'tools/list', {}))
    const names = (r.result?.tools ?? []).map((t) => t.name)
    expect(names.filter((n) => /delete|edit|update|remove/.test(n))).toEqual([])
  })
})
