// An optional source whose credential is absent from this host (src/server/config.ts's `optional`, written by
// `watcher add … --optional`) is not started at all: left running it could only log one poll error every cycle for a
// value its config already says may be missing. A required source keeps today's behaviour and reports the missing
// value on its own poll, and an optional source whose credential is present is started like any other.
//
// A skipped source is not a silent gap: /api/state, the MCP `list_sources` row and the Sources page carry `skipped`
// (`missing <ENV>`) and read idle, never the stale or error state another run may have left in the database.
//
// The server's own startup wiring (src/server/main.ts) runs in this process: `@hono/node-server` is stubbed, so
// nothing listens on a port; the stub keeps the app's own fetch, so the test reads the state the running process would
// answer. The only other seams are a temp config and the console log main.ts writes.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { openDb } from '../../src/server/db.ts'
import { Engine } from '../../src/server/engine.ts'
import type { WatchConfig } from '../../src/server/config.ts'
import { sourceRow, summarizeWall } from '../../src/server/mcp/shape.ts'
import type { SourceStatus, WallState } from '../../src/shared/types.ts'
import { Sources } from '../../src/web/views/Sources.tsx'

/** The app fetch main.ts hands to the HTTP server, so a test can call a route without a socket. */
const served = vi.hoisted(() => ({ fetch: null as null | ((request: Request) => Response | Promise<Response>) }))

vi.mock('@hono/node-server', () => ({
  serve: (options: { fetch: (request: Request) => Response | Promise<Response> }, listening: (info: { address: string; port: number }) => void) => {
    served.fetch = options.fetch
    listening({ address: '127.0.0.1', port: 48_123 })
    return { close: () => Promise.resolve() }
  }
}))

/** Test values only: built from parts so no credential-shaped literal sits in this file. */
const testValue = (...parts: string[]): string => `test-only-${parts.join('-')}`
const ACK_FOR_TEST = testValue('ack')
const MCP_FOR_TEST = testValue('mcp').padEnd(64, '0')
const HEARTBEAT_FOR_TEST = testValue('heartbeat')

/** Every JSON line main.ts's logger wrote, as the message it carries. */
const logged: string[] = []
const lines = (): string[] => {
  const out: string[] = []
  for (const raw of logged) {
    try {
      out.push((JSON.parse(raw) as { msg?: string }).msg ?? '')
    } catch {
      out.push(raw)
    }
  }
  return out
}

const saved = new Map<string, string | undefined>()
const setEnv = (vars: Record<string, string | undefined>): void => {
  for (const [key, value] of Object.entries(vars)) {
    if (!saved.has(key)) saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

const timers: number[] = []
let dir = ''
let importError: unknown = null

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'watcher-optional-source-'))
  const configPath = join(dir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      baseUrl: 'https://watch.test',
      port: 48_123,
      host: '127.0.0.1',
      historyHours: 24,
      staleAfterMisses: 3,
      sources: [
        // optional, and its token env is not set below: never started
        { id: 'optional-grafana', type: 'grafana', url: 'http://127.0.0.1:1', tokenEnv: 'OPTIONAL_GRAFANA_TOKEN', pollSec: 60, optional: true },
        // required, with the same kind of missing credential: started, and its poll names the value every cycle
        { id: 'required-grafana', type: 'grafana', url: 'http://127.0.0.1:1', tokenEnv: 'REQUIRED_GRAFANA_TOKEN', pollSec: 60 },
        // optional, with its token env set: started like any other source
        { id: 'optional-heartbeat', type: 'heartbeat', every: '5m', grace: '2m', tokenEnv: 'OPTIONAL_HEARTBEAT_TOKEN', optional: true }
      ],
      channels: [],
      routes: [],
      serviceMap: []
    })
  )
  setEnv({
    WATCHER_CONFIG: configPath,
    WATCHER_DATA_DIR: join(dir, 'data'),
    WATCHER_PORT: '48123',
    WATCHER_HOST: '127.0.0.1',
    WATCHER_ACK_SECRET: ACK_FOR_TEST,
    WATCHER_MCP_TOKEN: MCP_FOR_TEST,
    WATCHER_ADMIN_TOKEN: undefined,
    OPTIONAL_GRAFANA_TOKEN: undefined,
    REQUIRED_GRAFANA_TOKEN: undefined,
    OPTIONAL_HEARTBEAT_TOKEN: HEARTBEAT_FOR_TEST
  })

  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
    logged.push(String(line))
  })
  // Record the server's intervals, so the worker is not left with a 5 s tick running; restoring the spy does not clear them.
  const realSetInterval = globalThis.setInterval
  let recording = true
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms?: number, ...args: unknown[]) => {
    const timer = realSetInterval(callback, ms, ...args)
    if (recording) timers.push(timer)
    return timer
  }) as typeof globalThis.setInterval)
  try {
    await import('../../src/server/main.ts')
  } catch (err) {
    importError = err
  } finally {
    recording = false
  }
  if (importError) throw importError
  // The required source's first poll runs after startup; wait for its error line, then everything the start wrote is in.
  await vi.waitFor(
    () => {
      expect(lines()).toContain('poll required-grafana failed: missing environment variable REQUIRED_GRAFANA_TOKEN')
    },
    { timeout: 3000 }
  )
})

afterAll(() => {
  for (const timer of timers) clearInterval(timer)
  vi.restoreAllMocks()
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const T0 = Date.parse('2026-11-04T12:00:00Z')

/** GET /api/state from the app main.ts built, without a listening port. */
async function stateResponse(): Promise<WallState> {
  if (!served.fetch) throw new Error('main.ts did not hand its app to serve')
  const res = await served.fetch(new Request('http://127.0.0.1:48123/api/state'))
  expect(res.status).toBe(200)
  return (await res.json()) as WallState
}

const sourceOf = (state: WallState, id: string): SourceStatus => {
  const s = state.sources.find((x) => x.id === id)
  if (!s) throw new Error(`no source ${id} in the state`)
  return s
}

describe('a source whose credential is absent', () => {
  it('an optional one is not started: one line names the source and the env var, and nothing polls it', () => {
    expect(lines().filter((line) => line === 'source optional-grafana not started: missing OPTIONAL_GRAFANA_TOKEN (optional source)')).toHaveLength(1)
    expect(lines().filter((line) => line.startsWith('poll optional-grafana'))).toEqual([])
    // it is not one of the started sources counted at startup either
    expect(lines()).toContain('listening on 127.0.0.1:48123, 2 polled sources, 0 channels')
  })

  it('a required one still starts and reports the missing value on its poll, as before', () => {
    expect(lines().filter((line) => line.startsWith('source required-grafana not started'))).toEqual([])
    expect(lines()).toContain('poll required-grafana failed: missing environment variable REQUIRED_GRAFANA_TOKEN')
  })

  it('an optional one whose credential is present is started like any other', () => {
    expect(lines().filter((line) => line.startsWith('source optional-heartbeat'))).toEqual([])
  })
})

describe('a skipped source in the state', () => {
  it('reads idle with the missing credential as `skipped` in /api/state, and never as an error', async () => {
    const state = await stateResponse()
    expect(sourceOf(state, 'optional-grafana')).toMatchObject({ state: 'idle', skipped: 'missing OPTIONAL_GRAFANA_TOKEN', error: null })
    // a required source is started and reports its own poll error; a skipped one carries no error of its own
    expect(sourceOf(state, 'required-grafana').skipped).toBeUndefined()
    expect(sourceOf(state, 'optional-heartbeat').skipped).toBeUndefined()
  })

  it('carries the reason into list_sources', async () => {
    const state = await stateResponse()
    expect(sourceRow(sourceOf(state, 'optional-grafana'))).toMatchObject({ id: 'optional-grafana', state: 'idle', skipped: 'missing OPTIONAL_GRAFANA_TOKEN' })
    expect(sourceRow(sourceOf(state, 'optional-heartbeat'))).not.toHaveProperty('skipped')
  })

  it('names it in the watch_state rollup and never says every source is answering', async () => {
    const state = await stateResponse()
    const summary = summarizeWall(state, new Map(), 'https://watch.test')
    expect(summary.sources.skipped).toEqual([{ id: 'optional-grafana', reason: 'missing OPTIONAL_GRAFANA_TOKEN' }])
    expect(summary.text).not.toContain('Every source is answering.')
    expect(summary.text).toContain('optional-grafana: missing OPTIONAL_GRAFANA_TOKEN')
  })

  it('shows it muted on the Sources page in place of Waiting for the first poll', async () => {
    const state = await stateResponse()
    const page = (s: SourceStatus): string => renderToStaticMarkup(createElement(Sources, { state: { ...state, sources: [s] } as WallState, nowMs: T0 }))
    const skipped = page(sourceOf(state, 'optional-grafana'))
    expect(skipped).toContain('data-tone="muted">skipped</span>')
    expect(skipped).toContain('Not started on this host. Set OPTIONAL_GRAFANA_TOKEN to start it.')
    expect(skipped).not.toContain('Waiting for the first poll')
    // a source that runs keeps its ordinary state chip
    const failing = page(sourceOf(state, 'required-grafana'))
    expect(failing).toContain('Last poll failed')
    expect(failing).not.toContain('skipped')
  })
})

describe('a skipped source at the engine', () => {
  /** The same two-source config main.ts builds, without the startup wiring. */
  const cfg: WatchConfig = {
    baseUrl: 'https://watch.test',
    port: 0,
    host: '127.0.0.1',
    dataDir: ':memory:',
    historyHours: 24,
    staleAfterMisses: 3,
    sources: [
      { id: 'optional-grafana', type: 'grafana', url: 'http://127.0.0.1:1', tokenEnv: 'OPTIONAL_GRAFANA_TOKEN', pollSec: 60 },
      { id: 'required-grafana', type: 'grafana', url: 'http://127.0.0.1:1', tokenEnv: 'REQUIRED_GRAFANA_TOKEN', pollSec: 60 }
    ],
    serviceMap: [],
    channels: [],
    routes: [],
    quietHours: null
  }
  /** A row from a run whose credential was present: three missed polls, so it reads stale on its own. */
  const make = (): Engine => {
    const engine = new Engine(openDb(':memory:'), cfg, () => T0)
    for (let i = 0; i < 3; i += 1) engine.recordSource('optional-grafana', false, 'connection refused')
    return engine
  }
  const raisedIds = (engine: Engine): string[] =>
    engine.staleAlerts((id, name) => ({ id, name }) as never).map((a) => (a as unknown as { id: string }).id)

  it('reads idle with the reason, never the stale row another run left behind', () => {
    const engine = make()
    engine.skippedSources.set('optional-grafana', 'missing OPTIONAL_GRAFANA_TOKEN')
    expect(engine.sources().find((s) => s.id === 'optional-grafana')).toMatchObject({
      state: 'idle',
      skipped: 'missing OPTIONAL_GRAFANA_TOKEN',
      error: null,
      misses: 3
    })
    // the wall's own status line does not read stale for it either
    expect(engine.wall().header.stale).toBe(false)
    // the same row without the skip is stale: the set is the whole difference
    engine.skippedSources.delete('optional-grafana')
    expect(engine.sources().find((s) => s.id === 'optional-grafana')).toMatchObject({ state: 'stale' })
    expect(engine.wall().header.stale).toBe(true)
  })

  it('raises no source-stale alert for it', () => {
    const engine = make()
    expect(raisedIds(engine)).toEqual(['optional-grafana'])
    engine.skippedSources.set('optional-grafana', 'missing OPTIONAL_GRAFANA_TOKEN')
    expect(raisedIds(engine)).toEqual([])
  })
})
