// A restart is not a resolve. A heartbeat's ping history lives in SQLite (heartbeat_state), so a Watcher that restarts must
// still see a missed run as HeartbeatDown, an open failure as failed, and a job that has never pinged as late from its first
// registration rather than from the new process's start. The test opens a real database file, pings, advances the clock past
// the deadline, and builds a NEW engine and source on the same file.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../src/server/db.ts'
import type { Db } from '../../src/server/db.ts'
import { Engine } from '../../src/server/engine.ts'
import { HeartbeatSource, HEARTBEAT_RULE, resetHeartbeatSources } from '../../src/server/sources/heartbeat.ts'
import type { HeartbeatSourceConfig } from '../../src/server/sources/heartbeat.ts'
import type { SourceDeps } from '../../src/server/sources/types.ts'
import type { WatchConfig } from '../../src/server/config.ts'

const T0 = Date.parse('2026-11-04T09:00:00.000Z')
let clock = T0

const cfg: HeartbeatSourceConfig = { id: 'nightly', type: 'heartbeat', every: '1h', grace: '5m', tokenEnv: 'JOB_TOKEN' }

const watch: WatchConfig = {
  baseUrl: 'https://watch.example',
  dataDir: ':memory:',
  historyHours: 24,
  staleAfterMisses: 3,
  sources: [cfg],
  serviceMap: [],
  channels: [],
  routes: [],
  quietHours: null
}

const deps = (): SourceDeps => ({
  fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
  env: { JOB_TOKEN: 'job-secret' },
  nowIso: () => new Date(clock).toISOString(),
  serviceMap: []
})

const dirs: string[] = []
let db: Db | null = null

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'heartbeat-restart-'))
  dirs.push(dir)
  return join(dir, 'watcher.db')
}

function boot(path: string): { engine: Engine; source: HeartbeatSource } {
  resetHeartbeatSources()
  db?.close()
  db = openDb(path)
  const engine = new Engine(db, watch, () => clock)
  const source = new HeartbeatSource(cfg, deps())
  return { engine, source }
}

beforeEach(() => {
  clock = T0
})

afterEach(() => {
  resetHeartbeatSources()
  db?.close()
  db = null
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('a heartbeat across a Watcher restart', () => {
  it('keeps a live HeartbeatDown firing when the process restarts after the deadline, and resolves it on an ok ping', () => {
    const path = tempDb()
    const first = boot(path)
    expect(first.source.ping('', new Date(T0).toISOString()).status).toBe(200)
    // Restart well past the run due at T0 + 1h plus the 5m grace, with no new ping.
    clock = T0 + 3600_000 + 300_000 + 1000
    const second = boot(path)
    const overdue = second.source.observation()
    expect(overdue.firing.map((a) => a.rule)).toEqual([HEARTBEAT_RULE])
    second.engine.ingest(overdue)
    expect(second.engine.wall().incidents.map((i) => i.key)).toContain(`Nightly|${HEARTBEAT_RULE}`)

    // An ok ping at the new time is the only thing that resolves it.
    clock += 60_000
    const answer = second.source.ping('', new Date(clock).toISOString())
    expect(answer.observation?.firing).toEqual([])
    second.engine.ingest(answer.observation!)
    expect(second.engine.wall().incidents.filter((i) => i.key === `Nightly|${HEARTBEAT_RULE}`)).toHaveLength(0)
  })

  it('keeps a declared failure failed across a restart, while a /start punch does not clear it', () => {
    const path = tempDb()
    const first = boot(path)
    first.source.ping('fail', new Date(T0).toISOString())
    clock = T0 + 60_000
    const second = boot(path)
    expect(second.source.observation().firing.map((a) => a.rule)).toEqual([HEARTBEAT_RULE])

    clock += 60_000
    second.source.ping('start', new Date(clock).toISOString())
    const still = second.source.observation()
    expect(still.firing.map((a) => a.rule)).toEqual([HEARTBEAT_RULE])

    clock += 60_000
    const ok = second.source.ping('', new Date(clock).toISOString())
    expect(ok.observation?.firing).toEqual([])
  })

  it('counts a never-pinged job from its first-ever registration, not from each process start', () => {
    const path = tempDb()
    // First process: registers the job at T0, no ping.
    boot(path)
    // A restart two hours later: every 1h with a 5m grace means the run due at T0+1h was missed, so it is late even though this
    // process has just started.
    clock = T0 + 2 * 3600_000
    const second = boot(path)
    expect(second.source.observation().firing.map((a) => a.rule)).toEqual([HEARTBEAT_RULE])

    // A fresh database is a fresh registration: the same instant is healthy for a job first seen now.
    const other = boot(tempDb())
    expect(other.source.observation().firing).toEqual([])
  })

  it('persists the last ping kind and start time, so the state a restart reads is the state the job left', () => {
    const path = tempDb()
    const first = boot(path)
    first.source.ping('start', new Date(T0).toISOString())
    clock = T0 + 120_000
    first.source.ping('fail', new Date(clock).toISOString())
    const rows = db!.prepare('SELECT last_ping_at, last_kind, last_start_at, last_fail_at, exit_code FROM heartbeat_state WHERE source = ?').get('nightly') as Record<string, unknown>
    expect(rows.last_kind).toBe('fail')
    expect(rows.last_start_at).toBe(new Date(T0).toISOString())
    expect(rows.last_fail_at).toBe(new Date(T0 + 120_000).toISOString())
    expect(rows.last_ping_at).toBe(new Date(T0 + 120_000).toISOString())

    const second = boot(path)
    clock = T0 + 660_000
    expect(second.source.observation().firing.map((a) => a.rule)).toEqual([HEARTBEAT_RULE])
  })

  it('forgets a heartbeat source the config no longer names', () => {
    const path = tempDb()
    boot(path)
    clock = T0 + 60_000
    const other = { ...watch, sources: [] }
    const second = new Engine(db!, other, () => clock)
    second.dropRemovedSources()
    const rows = db!.prepare('SELECT COUNT(*) AS n FROM heartbeat_state').get() as { n: number }
    expect(rows.n).toBe(0)
  })
})
