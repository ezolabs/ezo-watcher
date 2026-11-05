// What the web shows of an agent's reads is what the agent gets: the session brief (src/web/lib/agent-brief.ts `statusBrief`) is line for
// line what `watcher status --brief` prints for the same /api/state, and the tool list names the MCP server's tools in its order.
import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import recordingJson from '../src/web/demo/fixtures/recording.json'
import { INIT_SPEC, runInit } from '../src/cli/init.ts'
import { STATUS_SPEC, runStatus } from '../src/cli/status.ts'
import { HOOK_COMMAND } from '../src/cli/hooks.ts'
import { TOOLS } from '../src/server/mcp/tools.ts'
import { DemoWatcher, type Recording } from '../src/web/demo/watcher.ts'
import { AGENT_TOOLS, BRIEF_COMMAND, BRIEF_MAX, briefAge, statusBrief } from '../src/web/lib/agent-brief.ts'
import type { WallState } from '../src/shared/types.ts'
import { EnvGuard, WATCHER_KEYS, capture, fakeServer, parse, readJson, rmTemp, tempDir } from './cli/helpers.ts'

const recording = recordingJson as unknown as Recording
const dirs: string[] = []
const guards: EnvGuard[] = []

afterEach(() => {
  for (const g of guards.splice(0)) g.restore()
  for (const d of dirs.splice(0)) rmTemp(d)
})

/** A project the CLI accepts, as `watcher init` writes it. */
async function project(): Promise<string> {
  const g = new EnvGuard(WATCHER_KEYS)
  guards.push(g)
  g.set({ WATCHER_ACK_SECRET: 'ack-test', WATCHER_MCP_TOKEN: undefined, WATCHER_PORT: undefined, WATCHER_HOST: undefined, WATCHER_CONFIG: undefined, WATCHER_DATA_DIR: undefined })
  const dir = tempDir('agent-brief')
  dirs.push(dir)
  expect(await runInit(parse(['init', '--dir', dir], INIT_SPEC), capture('json').out)).toBe(0)
  const path = join(dir, '.watcher', 'config.json')
  const raw = readJson(path)
  raw.sources = [{ id: 'probe', type: 'http-probe', targets: [{ id: 'api', service: 'api', url: 'https://api.example.com/healthz' }] }]
  raw.channels = []
  raw.routes = []
  writeFileSync(path, JSON.stringify(raw, null, 2))
  return dir
}

/** What the CLI prints for this wall, served the way a running Watcher serves it. */
async function cliBrief(wall: WallState): Promise<string[]> {
  const dir = await project()
  const server = await fakeServer((req, res) => {
    res.writeHead(req.url === '/api/state' ? 200 : 404, { 'content-type': 'application/json' })
    res.end(req.url === '/api/state' ? JSON.stringify(wall) : '{"error":"not found"}')
  })
  try {
    const cap = capture('table')
    expect(await runStatus(parse(['status', '--dir', dir, '--url', server.url, '--brief'], STATUS_SPEC), cap.out)).toBe(0)
    const out = cap.stdout().trim()
    return out === '' ? [] : out.split('\n')
  } finally {
    await server.close()
  }
}

/** The wall the demo shows a visitor who opened it now, after the requests given (an acknowledgement, a park). */
function demoWall(posts: Array<{ path: string; body: unknown }> = []): WallState {
  const w = new DemoWatcher(recording, { anchorMs: Date.now(), acts: [] }, () => Date.now())
  for (const p of posts) expect(w.handle({ method: 'POST', path: p.path, body: p.body }).status, p.path).toBe(200)
  return JSON.parse(w.handle({ method: 'GET', path: '/api/state' }).body as string) as WallState
}

/** The CLI reads its own clock: the web's lines for a moment before and after the run bracket it (an age only moves at a boundary). */
async function same(wall: WallState): Promise<void> {
  const before = statusBrief(wall, Date.now())
  const cli = await cliBrief(wall)
  const after = statusBrief(wall, Date.now())
  expect([before, after]).toContainEqual(cli)
}

describe('the session brief the web shows', () => {
  it('is what watcher status --brief prints for the demo wall', async () => {
    const wall = demoWall()
    await same(wall)
    const lines = statusBrief(wall, Date.parse(wall.generatedAt))
    // the recording's three open incidents (the parked one is left out), then the hint
    expect(lines).toHaveLength(4)
    expect(lines[0]).toMatch(/^warning {2}Billing jobs {2}HeartbeatDown {2}\d+[smhd] {2}Billing jobs\|HeartbeatDown$/)
    expect(lines.some((l) => l.includes('Payments|StripeWebhookStale'))).toBe(false)
    expect(lines.at(-1)).toBe('run `watcher incident <key> --fix-context` or the MCP tool get_fix_context')
  })

  it('drops an incident the visitor parks, and keeps one they acknowledge (it is still open)', async () => {
    const wall = demoWall()
    const page = wall.incidents.find((i) => i.severity === 'page')
    if (!page) throw new Error('the recording has a page')
    const at = Date.now()
    const acked = demoWall([{ path: `/api/incidents/${encodeURIComponent(page.key)}/ack`, body: { by: 'Robin' } }])
    await same(acked)
    expect(statusBrief(acked, at).some((l) => l.endsWith(page.key))).toBe(true)
    const parked = demoWall([{ path: `/api/incidents/${encodeURIComponent(page.key)}/park`, body: { by: 'Robin', state: 'deferred', until: new Date(at + 3_600_000).toISOString(), note: 'after the freeze' } }])
    await same(parked)
    expect(statusBrief(parked, at).some((l) => l.endsWith(page.key))).toBe(false)
  })

  it('stops at eight and says how many more, and prints nothing on a quiet wall', async () => {
    const now = Date.now()
    const incident = (n: number, attention: 'none' | 'parked' = 'none') => ({
      ...recording.state.incidents[0],
      key: `Api|Rule${n}`,
      service: 'Api',
      rule: `Rule${n}`,
      instance: n % 2 === 0 ? `node-${n}` : null,
      severity: n === 0 ? 'page' : 'warning',
      // half a minute off each boundary, so the CLI's clock and this one read the same age
      startsAt: new Date(now - (n * 37 + 1) * 60_000 - 30_000).toISOString(),
      state: { ...recording.state.incidents[0].state, firing: attention !== 'parked', attention, park: null }
    })
    const many = { ...recording.state, incidents: Array.from({ length: 11 }, (_, n) => incident(n)) } as WallState
    await same(many)
    const lines = statusBrief(many, now)
    expect(lines).toHaveLength(BRIEF_MAX + 2)
    expect(lines.at(-2)).toBe('+3 more')
    expect(lines[0]).toBe('page  Api  Rule0 on node-0  1m  Api|Rule0')
    const quiet = { ...recording.state, incidents: [incident(1, 'parked')] } as WallState
    await same(quiet)
    expect(statusBrief(quiet, now)).toEqual([])
  })

  it('says an age as the CLI does', () => {
    const at = Date.parse('2026-11-05T15:30:00.000Z')
    expect(briefAge('2026-11-05T15:29:15.000Z', at)).toBe('45s')
    expect(briefAge('2026-11-05T15:07:00.000Z', at)).toBe('23m')
    expect(briefAge('2026-11-05T13:20:00.000Z', at)).toBe('2h')
    expect(briefAge('2026-11-01T15:30:00.000Z', at)).toBe('4d')
    expect(briefAge(null, at)).toBe('-')
    expect(briefAge('not a time', at)).toBe('-')
  })

  it('is the command the session hook runs', () => {
    expect(BRIEF_COMMAND).toBe(HOOK_COMMAND)
  })
})

describe('the tool list the web shows', () => {
  it("names the MCP server's tools, in its order, the reads first", () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name))
    expect(AGENT_TOOLS.filter((t) => t.reads).map((t) => t.name)).toEqual(['watch_state', 'list_incidents', 'get_incident', 'get_fix_context', 'incident_history', 'list_sources'])
    for (const t of AGENT_TOOLS) expect(t.line, t.name).toMatch(/^[A-Z].{10,90}\.$/)
  })
})
