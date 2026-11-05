// The fleet metrics source and its rules: pure threshold replay, the data response reader against a table built the way Netdata Cloud's json2 answers
// (shape read from the live room, 2026-10-15), the snapshot /api/fleet serves, the alerts and cells a poll hands the engine, and the fold of Netdata's own
// CPU and RAM alerts into the same incident. No network: a fake Cloud serves the bodies. The token is a stand-in and must never show up in a message.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/server/config.ts'
import type { NetdataCloudSourceConfig, NetdataFleetSourceConfig, WatchConfig } from '../src/server/config.ts'
import { openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'
import { makeAlert } from '../src/server/derive.ts'
import { matchedRoutes } from '../src/server/notify/match.ts'
import { createApp } from '../src/server/app.ts'
import type { AppDeps } from '../src/server/app.ts'
import { SqlitePushStore } from '../src/server/stores.ts'
import { classifyNetdataAlert, netdataPolicyOf } from '../src/server/sources/netdata-cloud.ts'
import { FLEET_INSTANCES, MOUNT_EXCLUDE_PREFIXES, createNetdataFleetSource, fleetQuery, ignoredNode, keepMount, memoryPercent, mountPath, parseFleetData, readNodeSpecs, roleOf, splitColumnId } from '../src/server/sources/netdata-fleet.ts'
import { DEFAULT_FLEET_RULES, NO_STATES, describeFinding, evaluateNode, fleetRuleTitle, fleetRulesOf, heatOf, replayThreshold, thresholdsOf, twinOf } from '../src/server/sources/fleet-rules.ts'
import type { Threshold } from '../src/server/sources/fleet-rules.ts'
import type { SourceDeps } from '../src/server/sources/types.ts'
import { diskHeatOf } from '../src/shared/fleet.ts'
import type { FleetView } from '../src/shared/fleet.ts'
import { cellOrigin } from '../src/web/lib/cells.ts'
import { bytesText, diskFreeText, diskPercentText, diskWords, fleetHeadline, sortNodes, stripLabel, worstMount } from '../src/web/lib/fleet.ts'
import { kindLabel, quietText } from '../src/web/lib/sources.ts'
import type { Alert } from '../src/shared/types.ts'

const NOW = '2026-10-15T21:30:00.000Z'
const NOW_SEC = Date.parse(NOW) / 1000
const FAKE_TOKEN = 'fake-netdata-token-for-tests-0123456789'
const SPACE = '00000000-0000-4000-8000-00000000000f'
const ROOM = '00000000-0000-4000-8000-000000000010'
const CLOUD = 'https://app.netdata.cloud/spaces/example-space/rooms/all-nodes'

const cfg: NetdataFleetSourceConfig = {
  id: 'netdata-fleet',
  type: 'netdata-fleet',
  url: 'https://app.netdata.cloud',
  tokenEnv: 'NETDATA_CLOUD_TOKEN',
  spaceId: SPACE,
  roomId: ROOM,
  pollSec: 60,
  cloudUrl: CLOUD,
  fleetNodes: ['node-1', 'node-2', 'node-13'],
  watchOnlyNodes: ['print', 'mac-a1.example.net'],
  k8sNodes: ['netdata-k8s-state']
}

// ---- pure rules --------------------------------------------------------------------------------------------------

const fill = (n: number, v: number | null): Array<number | null> => Array.from({ length: n }, () => v)
const cat = (...parts: Array<Array<number | null>>): Array<number | null> => parts.flat()

describe('replayThreshold: averaged (HostCpuHot)', () => {
  const t: Threshold = { warnAbove: 80, clearBelow: 70, forMin: 10, over: 'average' }

  it('fires when the 10-minute MEAN passes the line, not on one busy minute', () => {
    expect(replayThreshold(cat(fill(20, 5), [100], fill(9, 5)), t).firing).toBe(false)
    const r = replayThreshold(cat(fill(10, 5), fill(10, 95)), t)
    expect(r.firing).toBe(true)
    // the window of minutes 10..19 never reaches 80 until 8 of its 10 minutes are 95: the mean passes 80 at index 17 (8 x 95 + 2 x 5 = 77 -> no; 9 x 95 + 5 = 86 -> yes at 18)
    expect(r.edges).toEqual([{ index: 18, kind: 'fire', value: 86 }])
    expect(r.startIndex).toBe(18)
  })

  it('needs the first full window: nothing fires on the first 9 minutes', () => {
    expect(replayThreshold(fill(9, 100), t).firing).toBe(false)
    expect(replayThreshold(fill(10, 100), t)).toMatchObject({ firing: true, startIndex: 9 })
  })

  it('stays firing until EVERY minute of a 10-minute window is under the clear line (clears below 70% for 10 min)', () => {
    const burst = cat(fill(10, 95), fill(9, 10))
    // 9 quiet minutes: the mean is already 50, but the window still holds a 95 minute
    expect(replayThreshold(burst, t).firing).toBe(true)
    expect(replayThreshold(cat(burst, [10]), t)).toMatchObject({ firing: false, startIndex: null })
    // a minute at 75 (above the clear line, under the fire line) keeps it firing
    expect(replayThreshold(cat(fill(10, 95), fill(9, 10), [75, 10]), t).firing).toBe(true)
  })

  it('a mean that sits in the band (70 to 80) neither fires nor clears', () => {
    expect(replayThreshold(fill(30, 75), t).firing).toBe(false)
    expect(replayThreshold(fill(30, 75), t, true).firing).toBe(true)
  })

  it('carries the state the previous poll ended in, and an episode that began before the series has no start', () => {
    const r = replayThreshold(fill(30, 90), t, true)
    expect(r).toMatchObject({ firing: true, startIndex: null, edges: [] })
  })

  it('a gap is not a quiet minute: too few readings hold the state', () => {
    const gappy = cat(fill(10, 95), fill(10, null))
    expect(replayThreshold(gappy, t).firing).toBe(true)
  })
})

describe('replayThreshold: held (memory, load)', () => {
  const t: Threshold = { warnAbove: 85, clearBelow: 80, forMin: 10, over: 'sustained' }

  it('fires only once EVERY minute of the window is above the line', () => {
    expect(replayThreshold(cat(fill(20, 50), fill(9, 90)), t).firing).toBe(false)
    expect(replayThreshold(cat(fill(20, 50), fill(10, 90)), t)).toMatchObject({ firing: true, startIndex: 29, windowValue: 90 })
    // one dip to 84 inside the window and it has not held
    expect(replayThreshold(cat(fill(20, 50), fill(5, 90), [84], fill(4, 90)), t).firing).toBe(false)
  })

  it('a null minute inside the window means it has not held', () => {
    expect(replayThreshold(cat(fill(20, 50), fill(5, 90), [null], fill(4, 90)), t).firing).toBe(false)
  })

  it('clears after 10 minutes under the clear line, not before', () => {
    const up = cat(fill(20, 50), fill(10, 90))
    expect(replayThreshold(cat(up, fill(9, 70)), t).firing).toBe(true)
    expect(replayThreshold(cat(up, fill(10, 70)), t).firing).toBe(false)
    expect(replayThreshold(cat(up, fill(10, 82)), t).firing).toBe(true)
  })
})

describe('evaluateNode: one memory alert whose level moves', () => {
  const rules = DEFAULT_FLEET_RULES
  const calm = fill(40, 10)
  const idle = fill(40, 0.2)

  it('is quiet on a calm node', () => {
    expect(evaluateNode({ cpu: calm, mem: calm, loadPerCore: idle }, rules)).toMatchObject({ findings: [], states: NO_STATES })
  })

  it('85% held 10 minutes is a warning, 95% held 10 minutes is a page, and the page drops back to the warning at 90 (its own clear line)', () => {
    const warn = evaluateNode({ cpu: calm, mem: cat(fill(30, 10), fill(10, 88)), loadPerCore: idle }, rules)
    expect(warn.findings).toMatchObject([{ id: 'memory-hot', level: 'warning', threshold: 85 }])
    const page = evaluateNode({ cpu: calm, mem: cat(fill(30, 10), fill(10, 97)), loadPerCore: idle }, rules)
    expect(page.findings).toMatchObject([{ id: 'memory-hot', level: 'page', threshold: 95 }])
    expect(page.states).toMatchObject({ memWarn: true, memPage: true })
    // 10 minutes at 92: under the page's fire line but over its clear line (90): the page tier holds; the warning tier too
    const held = evaluateNode({ cpu: calm, mem: fill(10, 92), loadPerCore: idle.slice(0, 10) }, rules, page.states)
    expect(held.findings).toMatchObject([{ id: 'memory-hot', level: 'page' }])
    // 10 minutes at 88: the page tier clears (every minute under 90), the warning tier holds
    const down = evaluateNode({ cpu: calm, mem: fill(10, 88), loadPerCore: idle.slice(0, 10) }, rules, page.states)
    expect(down.findings).toMatchObject([{ id: 'memory-hot', level: 'warning' }])
  })

  it('load per core above 1.5 for 15 minutes is a warning and never a page', () => {
    expect(evaluateNode({ cpu: calm, mem: calm, loadPerCore: cat(fill(30, 0.2), fill(14, 2)) }, rules).findings).toEqual([])
    const f = evaluateNode({ cpu: calm, mem: calm, loadPerCore: cat(fill(30, 0.2), fill(15, 2)) }, rules).findings
    expect(f).toMatchObject([{ id: 'load-high', level: 'warning', threshold: 1.5, forMin: 15 }])
  })

  it('describes what it read in words a person can check', () => {
    expect(describeFinding({ id: 'cpu-hot', value: 83.44, threshold: 80, forMin: 10, over: 'average' })).toBe('83.4% averaged over 10 min')
    expect(describeFinding({ id: 'memory-hot', value: 86.2, threshold: 85, forMin: 10, over: 'sustained' })).toBe('86.2% at its lowest in the last 10 min (line 85%)')
    expect(describeFinding({ id: 'load-high', value: 1.826, threshold: 1.5, forMin: 15, over: 'sustained' })).toBe('1.83 per core at its lowest in the last 15 min (line 1.5)')
  })
})

describe('rules from config', () => {
  it('takes the config numbers over the defaults and keeps the defaults for what it omits', () => {
    const r = fleetRulesOf({ cpu: { warnAbove: 90, clearBelow: 60, forMin: 5 } })
    expect(r.cpu).toMatchObject({ warnAbove: 90, clearBelow: 60, forMin: 5, over: 'average' })
    expect(r.memoryPage).toEqual(DEFAULT_FLEET_RULES.memoryPage)
    expect(thresholdsOf(fleetRulesOf(undefined))).toEqual({
      cpu: { warnAbove: 80, clearBelow: 70, forMin: 10 },
      memory: { warnAbove: 85, clearBelow: 80, pageAbove: 95, pageClearBelow: 90, forMin: 10 },
      load: { warnAbove: 1.5, clearBelow: 1.2, forMin: 15 },
      coldCpuBelow: 10
    })
  })

  it('names the rules and the twins', () => {
    expect(fleetRuleTitle('cpu-hot', 'node-13')).toBe('Host CPU hot (node-13)')
    expect(twinOf('10min_cpu_usage')).toBe('cpu-hot')
    expect(twinOf('RAM_IN_USE')).toBe('memory-hot')
    expect(twinOf('ram_available')).toBe('memory-hot')
    expect(twinOf('load_average_5')).toBeUndefined()
  })

  it('reads a node hot, warm, cold or ok from the same lines as the alerts', () => {
    const r = DEFAULT_FLEET_RULES
    expect(heatOf({ cpu10: 85, mem: 10, loadPerCore: 0.1, firing: false }, r)).toBe('hot')
    expect(heatOf({ cpu10: 5, mem: 10, loadPerCore: 0.1, firing: true }, r)).toBe('hot')
    expect(heatOf({ cpu10: 72, mem: 10, loadPerCore: 0.1, firing: false }, r)).toBe('warm')
    expect(heatOf({ cpu10: 20, mem: 81, loadPerCore: 0.1, firing: false }, r)).toBe('warm')
    expect(heatOf({ cpu10: 3, mem: 10, loadPerCore: 0.1, firing: false }, r)).toBe('cold')
    expect(heatOf({ cpu10: 30, mem: 10, loadPerCore: 0.1, firing: false }, r)).toBe('ok')
    expect(heatOf({ cpu10: null, mem: null, loadPerCore: null, firing: false }, r)).toBe('unknown')
  })
})

// ---- the data response -------------------------------------------------------------------------------------------

interface FakeMount {
  path: string
  fs?: string
  /** Percent used of used + avail, by row. */
  pct?: (i: number) => number
  /** used + avail in GiB (default 800). */
  sizeGiB?: number
  /** Reserved for root, GiB (default 0). */
  reservedGiB?: number
}

interface FakeNode {
  name: string
  /** Rows of figures: functions of the row index. A metric left out is not in the response at all. */
  cpu?: (i: number) => number | null
  mem?: (i: number) => number
  load5?: (i: number) => number
  /** The root disk, percent used, shorthand for a `/` mount of 800 GiB (+ 46.5 GiB reserved) on ext4. */
  disk?: (i: number) => number
  /** Other mounts, or all of them (a `/` here replaces the shorthand). */
  mounts?: FakeMount[]
  /** A response that predates the instance grouping: ids are `dimension,guid,context`, and disk.space is the root alone. */
  legacy?: boolean
  cores?: number
  state?: string
  /** macOS: system.ram has no `used`, there is no mem.available. */
  mac?: boolean
  code?: number
}

const guidOf = (name: string): string => `guid-${name}`
const idOf = (name: string): string => `node-id-${name}`
const TOTAL_MIB = 100000
const GIB_ = 1024 ** 3

const ORDER = ['dimension', 'instance', 'label:filesystem', 'node', 'context']

function dataBody(nodes: FakeNode[], rows = 60): unknown {
  const ids: string[] = []
  const unitOf: string[] = []
  const cols: Array<(i: number) => number | null> = []
  const legacy = nodes.some((n) => n.legacy)
  const add = (dim: string, node: FakeNode, ctx: string, f: (i: number) => number | null, o: { instance?: string; fs?: string; unit?: string } = {}): void => {
    ids.push(legacy ? `${dim},${guidOf(node.name)},${ctx}` : `${dim},${o.instance ?? ctx},${o.fs ?? '[unset]'},${guidOf(node.name)},${ctx}`)
    unitOf.push(o.unit ?? (ctx === 'system.ram' || ctx === 'mem.available' ? 'MiB' : ctx === 'system.load' ? 'load' : ctx === 'disk.space' ? 'GiB' : 'percentage'))
    cols.push(f)
  }
  for (const n of nodes) {
    if (n.cpu) {
      const cpu = n.cpu
      add('user', n, 'system.cpu', (i) => (cpu(i) === null ? null : (cpu(i) as number) * 0.7))
      add('system', n, 'system.cpu', (i) => (cpu(i) === null ? null : (cpu(i) as number) * 0.3))
    }
    if (n.load5) {
      const l = n.load5
      add('load1', n, 'system.load', l)
      add('load5', n, 'system.load', l)
      add('load15', n, 'system.load', l)
    }
    if (n.mem) {
      const mem = n.mem
      const avail = (i: number): number => TOTAL_MIB * (1 - mem(i) / 100)
      if (n.mac) {
        add('active', n, 'system.ram', (i) => (TOTAL_MIB * mem(i)) / 100 / 2)
        add('wired', n, 'system.ram', (i) => (TOTAL_MIB * mem(i)) / 100 / 2)
        add('inactive', n, 'system.ram', (i) => avail(i) / 2)
        add('free', n, 'system.ram', (i) => avail(i) / 2)
      } else {
        add('free', n, 'system.ram', (i) => avail(i) / 2)
        add('cached', n, 'system.ram', (i) => avail(i) / 2)
        add('used', n, 'system.ram', (i) => TOTAL_MIB - avail(i))
        add('buffers', n, 'system.ram', () => 0)
        add('avail', n, 'mem.available', avail)
      }
    }
    const mounts: FakeMount[] = [...(n.mounts ?? [])]
    if (n.disk && !mounts.some((m) => m.path === '/')) mounts.unshift({ path: '/', fs: 'ext4', pct: n.disk, sizeGiB: 800, reservedGiB: 46.5 })
    for (const m of legacy ? mounts.filter((x) => x.path === '/') : mounts) {
      const pct = m.pct ?? (() => 10)
      const size = m.sizeGiB ?? 800
      const o = { instance: `disk_space.${m.path}`, fs: m.fs ?? 'ext4' }
      add('used', n, 'disk.space', (i) => (pct(i) / 100) * size, o)
      add('avail', n, 'disk.space', (i) => (1 - pct(i) / 100) * size, o)
      add('reserved for root', n, 'disk.space', () => m.reservedGiB ?? 0, o)
    }
  }
  const times = Array.from({ length: rows }, (_, i) => NOW_SEC - 60 * (rows - 1 - i))
  return {
    api: 3,
    agents: [{ ai: 0, now: NOW_SEC, nm: nodes[0]?.name ?? 'node-1' }],
    summary: { nodes: nodes.map((n, ni) => ({ ni, mg: guidOf(n.name), nd: idOf(n.name), nm: n.name, st: { ai: 0, code: n.code ?? 200 } })), instances: [], alerts: [] },
    view: {
      update_every: 60,
      after: times[0] - 59,
      before: times[rows - 1],
      points: rows,
      dimensions: { grouped_by: legacy ? ['dimension', 'node', 'context'] : ORDER, ids, units: unitOf }
    },
    result: {
      labels: ['time', ...ids],
      point: { value: 0, arp: 1, pa: 2 },
      data: times.map((t, i) => [t, ...cols.map((f) => { const v = f(i); return v === null ? null : [v, 0, 0] })])
    }
  }
}

function nodesBody(nodes: FakeNode[]): unknown {
  return nodes.map((n) => ({
    id: idOf(n.name),
    name: n.name,
    state: n.state ?? 'reachable',
    version: 'v2.12.1',
    isDeleted: false,
    hostLabels: { _system_cores: String(n.cores ?? 32), _system_ram_total: '200000000000' }
  }))
}

describe('parseFleetData', () => {
  it('reads CPU as the sum of the dimensions returned, load by dimension, memory from mem.available, disk as used / (used + avail)', () => {
    const p = parseFleetData(dataBody([{ name: 'node-13', cpu: () => 80, mem: () => 40, load5: () => 12, disk: () => 55 }], 5))
    expect(p.nodes).toHaveLength(1)
    const n = p.nodes[0]
    expect(n).toMatchObject({ name: 'node-13', id: 'node-id-node-13', code: 200 })
    expect(n.cpu.every((v) => v !== null && Math.abs(v - 80) < 1e-9)).toBe(true)
    expect(n.load1).toEqual([12, 12, 12, 12, 12])
    expect(Math.round((n.mem[4] as number) * 100) / 100).toBe(40)
    expect(Math.round((n.disk[4] as number) * 100) / 100).toBe(55)
    expect(p.stepSec).toBe(60)
    expect(p.times[4]).toBe(NOW_SEC)
    expect(p.agentNowSec).toBe(NOW_SEC)
  })

  it('keeps a missing minute as null, never 0', () => {
    const p = parseFleetData(dataBody([{ name: 'node-1', cpu: (i) => (i === 2 ? null : 10), mem: () => 5, load5: () => 1, disk: () => 5 }], 4))
    expect(p.nodes[0].cpu[2]).toBeNull()
    expect(p.nodes[0].cpu[3]).toBeCloseTo(10)
  })

  it('a node with no columns (the Kubernetes state collector) has all-null series', () => {
    const p = parseFleetData(dataBody([{ name: 'netdata-k8s-state' }, { name: 'node-1', cpu: () => 3 }], 3))
    expect(p.nodes.find((n) => n.name === 'netdata-k8s-state')!.cpu).toEqual([null, null, null])
  })

  it('reads macOS memory (no mem.available, no used) as the share that is not free or inactive', () => {
    const p = parseFleetData(dataBody([{ name: 'mac-a1.example.net', cpu: () => 16, mem: () => 60, load5: () => 3.7, disk: () => 27, mac: true }], 3))
    expect(Math.round(p.nodes[0].mem[2] as number)).toBe(60)
  })

  it('refuses a body of the wrong shape', () => {
    expect(() => parseFleetData({ nope: true })).toThrow('unexpected shape')
    expect(() => parseFleetData(null)).toThrow('unexpected shape')
  })

  it('memoryPercent: Linux, BSD and macOS formulas, and nothing when there is nothing', () => {
    expect(memoryPercent({ free: 10, used: 30, cached: 50, buffers: 10 }, 60)).toBe(40)
    expect(memoryPercent({ free: 10, used: 30, cached: 50, buffers: 10 }, null)).toBe(30)
    expect(memoryPercent({ active: 20, wired: 20, inactive: 30, free: 30 }, null)).toBe(40)
    expect(memoryPercent({}, null)).toBeNull()
    expect(memoryPercent({ used: null, free: null }, null)).toBeNull()
  })

  it('reads the node specs: cores and RAM from the host labels, a deleted node dropped', () => {
    const specs = readNodeSpecs([...(nodesBody([{ name: 'node-1', cores: 64 }]) as object[]), { id: 'x', name: 'gone', isDeleted: true }])
    expect(specs).toEqual([{ id: 'node-id-node-1', name: 'node-1', state: 'reachable', version: 'v2.12.1', cores: 64, ramBytes: 200000000000 }])
  })

  it('roles: fleet, watch-only (listed or not listed), k8s', () => {
    expect(roleOf('node-13', cfg)).toBe('fleet')
    expect(roleOf('NODE-13', cfg)).toBe('fleet')
    expect(roleOf('print', cfg)).toBe('watch-only')
    expect(roleOf('newbox', cfg)).toBe('watch-only')
    expect(roleOf('netdata-k8s-state', cfg)).toBe('k8s')
  })
})

// ---- a poll over a fake Cloud ------------------------------------------------------------------------------------

interface Call {
  method: string
  url: string
  headers: Record<string, string>
  body: any
  redirect: RequestRedirect | undefined
}

function fakeCloud(opts: { nodes: FakeNode[]; data?: () => unknown; fail?: (c: Call) => Response | undefined }): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      redirect: init?.redirect
    }
    calls.push(call)
    const failed = opts.fail?.(call)
    if (failed) return failed
    if (call.method === 'GET') return new Response(JSON.stringify(nodesBody(opts.nodes)), { status: 200 })
    return new Response(JSON.stringify(opts.data ? opts.data() : dataBody(opts.nodes)), { status: 200 })
  }
  return { fetch: impl as typeof fetch, calls }
}

const deps = (f: { fetch: typeof fetch }, extra: Partial<SourceDeps> = {}): SourceDeps => ({ fetch: f.fetch, env: { NETDATA_CLOUD_TOKEN: FAKE_TOKEN }, nowIso: () => NOW, serviceMap: [], ...extra })

// node-13 averaged 85 % over the last 10 minutes after an idle start, node-1 is cold, node-2 holds 88 % memory, print is hot but watch-only.
const FLEET: FakeNode[] = [
  { name: 'node-13', cores: 64, cpu: (i) => (i < 50 ? 5 : 90), mem: () => 14, load5: () => 30, disk: () => 58 },
  { name: 'node-1', cores: 32, cpu: () => 2, mem: () => 13, load5: () => 1.5, disk: () => 30 },
  { name: 'node-2', cores: 32, cpu: () => 20, mem: (i) => (i < 40 ? 30 : 88), load5: () => 3, disk: () => 17 },
  { name: 'print', cores: 2, cpu: () => 99, mem: () => 90, load5: () => 8, disk: () => 86 },
  { name: 'netdata-k8s-state', cores: 64 }
]

describe('a poll', () => {
  it('makes one GET and one data POST, asks for the five contexts over 60 one-minute points, and never leaks the token', async () => {
    const f = fakeCloud({ nodes: FLEET })
    await createNetdataFleetSource(cfg, deps(f)).poll()
    expect(f.calls.map((c) => `${c.method} ${c.url.replace('https://app.netdata.cloud/api', '')}`)).toEqual([`GET /v2/spaces/${SPACE}/rooms/${ROOM}/nodes`, `POST /v3/spaces/${SPACE}/rooms/${ROOM}/data`])
    const q = f.calls[1].body
    expect(q.scope.contexts).toEqual(['system.cpu', 'system.load', 'system.ram', 'mem.available', 'disk.space'])
    expect(q.scope.contexts).not.toContain('*')
    // every disk instance but the plumbing paths, in ONE request: the exclusions come first (the first match wins), then the catch-all
    expect(q.selectors.instances).toEqual(FLEET_INSTANCES)
    expect(q.selectors.instances.slice(0, 4)).toEqual(['system.cpu', 'system.load', 'system.ram', 'mem.available'])
    expect(q.selectors.instances.at(-1)).toBe('disk_space.*')
    expect(q.selectors.instances).toContain('!disk_space./run')
    expect(q.selectors.instances).toContain('!disk_space./run/*')
    expect(q.selectors.instances).toContain('!disk_space./var/lib/kubelet/*')
    expect(q.selectors.instances).not.toContain('disk_space./')
    expect(q.window).toEqual({ after: -3600, before: 0, points: 60 })
    expect(q.aggregations.metrics[0].group_by).toEqual(['node', 'context', 'instance', 'dimension', 'label'])
    expect(q.aggregations.metrics[0].group_by_label).toEqual(['filesystem'])
    expect(q.options).toContain('unaligned')
    expect(q.options).not.toContain('null2zero')
    expect(q.format).toBe('json2')
    for (const c of f.calls) {
      expect(c.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`)
      expect(c.redirect).toBe('error')
    }
    expect(fleetQuery(120, 15000).window).toEqual({ after: -7200, before: 0, points: 120 })
  })

  it('raises HostCpuHot and HostMemoryHot on fleet nodes only, one alert each, on the Fleet load service, a warning', async () => {
    const obs = await createNetdataFleetSource(cfg, deps(fakeCloud({ nodes: FLEET }))).poll()
    expect(obs).toMatchObject({ source: 'netdata-fleet', kind: 'netdata-fleet', at: NOW, complete: true, resolved: [] })
    expect(obs.firing.map((a) => [a.rule, a.labels.alertname, a.severity, a.service, a.host]).sort()).toEqual([
      ['Host CPU hot (node-13)', 'HostCpuHot', 'warning', 'Fleet load', 'node-13'],
      ['Host memory hot (node-2)', 'HostMemoryHot', 'warning', 'Fleet load', 'node-2']
    ])
    // print is at 99 % CPU and 90 % memory and raises nothing: it is not a fleet node. node-13's load is 30 on 64 cores (0.47 a core): under the line.
    expect(obs.firing.some((a) => a.host === 'print')).toBe(false)
    expect(obs.firing.some((a) => a.labels.alertname === 'HostLoadHigh')).toBe(false)
    const cpu = obs.firing.find((a) => a.rule === 'Host CPU hot (node-13)')!
    expect(cpu.value).toMatch(/^\d+\.\d% averaged over 10 min$/)
    // the mean of the last 10 minutes passes 80 when 9 of them are at 90 (9 x 90 + 5 = 815 / 10): the minute that ended one minute before the newest
    expect(cpu.startsAt).toBe(new Date((NOW_SEC - 60) * 1000).toISOString())
    expect(cpu.links.generator).toBe(`https://app.netdata.cloud/spaces/example-space/rooms/all-nodes/nodes/node-id-node-13`)
    expect(cpu.via[0]).toMatchObject({ source: 'netdata-fleet', kind: 'netdata-fleet' })
    expect(JSON.stringify(obs)).not.toContain(FAKE_TOKEN)
  })

  it('a memory warning that grows into a page is the same alert, escalated in place; the page route matches it', async () => {
    let level = 88
    const nodes: FakeNode[] = [{ name: 'node-2', cores: 32, cpu: () => 5, mem: () => level, load5: () => 1, disk: () => 10 }]
    const src = createNetdataFleetSource({ ...cfg, fleetNodes: ['node-2'] }, deps(fakeCloud({ nodes })))
    const warn = (await src.poll()).firing[0]
    expect(warn).toMatchObject({ severity: 'warning', labels: { severity: 'warning' } })
    level = 97
    const page = (await src.poll()).firing[0]
    expect(page.key).toBe(warn.key)
    expect(page.severity).toBe('page')
    expect(page.labels.severity).toBe('critical')
    const real = loadConfig(fileURLToPath(new URL('./fixtures/watch.config.json', import.meta.url)))
    expect(matchedRoutes(real.routes, { severity: page.severity, origin: page.origin, labels: page.labels }).map((r) => r.id)).toEqual(['page'])
    expect(matchedRoutes(real.routes, { severity: warn.severity, origin: warn.origin, labels: warn.labels }).map((r) => r.id)).toEqual(['warning'])
  })

  it('HostLoadHigh fires on load5 per core, with the core count from the node, never on a raw load', async () => {
    const nodes: FakeNode[] = [
      { name: 'node-1', cores: 4, cpu: () => 50, mem: () => 20, load5: () => 8, disk: () => 10 },
      { name: 'node-2', cores: 64, cpu: () => 50, mem: () => 20, load5: () => 8, disk: () => 10 }
    ]
    const obs = await createNetdataFleetSource({ ...cfg, fleetNodes: ['node-1', 'node-2'] }, deps(fakeCloud({ nodes }))).poll()
    expect(obs.firing.map((a) => [a.rule, a.severity])).toEqual([['Host load high (node-1)', 'warning']])
  })

  it('publishes one solid cell per rule and one for the metrics read, on the Fleet load tile', async () => {
    const obs = await createNetdataFleetSource(cfg, deps(fakeCloud({ nodes: FLEET }))).poll()
    expect(obs.rules!.map((c) => [c.id, c.state, c.service])).toEqual([
      ['netdata-fleet:metrics', 'ok', 'Fleet load'],
      ['netdata-fleet:cpu-hot', 'firing', 'Fleet load'],
      ['netdata-fleet:memory-hot', 'firing', 'Fleet load'],
      ['netdata-fleet:load-high', 'ok', 'Fleet load']
    ])
    const names = obs.rules!.map((c) => c.name)
    expect(names[1]).toBe('HostCpuHot: CPU above 80% averaged over 10 min')
    expect(names[2]).toBe('HostMemoryHot: memory above 85% for 10 min (page above 95%)')
    expect(names[3]).toBe('HostLoadHigh: load above 1.5 per core for 15 min')
    for (const c of obs.rules!) expect(c).toMatchObject({ source: 'netdata-fleet', evaluatedAt: NOW, intervalSec: 60, url: CLOUD })
  })

  it('a fleet node that did not answer makes the metrics cell an error naming it, and the other rules still evaluate', async () => {
    const nodes: FakeNode[] = [FLEET[1], { name: 'node-13', cores: 64, code: 504 }]
    const obs = await createNetdataFleetSource({ ...cfg, fleetNodes: ['node-1', 'node-13'] }, deps(fakeCloud({ nodes }))).poll()
    const metrics = obs.rules!.find((c) => c.id === 'netdata-fleet:metrics')!
    expect(metrics).toMatchObject({ state: 'error', detail: 'no data from node-13' })
    expect(obs.rules!.find((c) => c.id === 'netdata-fleet:cpu-hot')!.state).toBe('ok')
  })

  it('keeps a node’s alerts for a while when it stops answering, so a blip does not resolve and re-fire the incident', async () => {
    let silent = false
    const nodes: FakeNode[] = [{ name: 'node-13', cores: 64, cpu: () => 95, mem: () => 10, load5: () => 1, disk: () => 10 }]
    let now = Date.parse(NOW)
    const src = createNetdataFleetSource(
      { ...cfg, fleetNodes: ['node-13'] },
      deps(fakeCloud({ nodes, data: () => dataBody(silent ? [{ name: 'node-13', cores: 64, code: 504 }] : nodes) }), { nowIso: () => new Date(now).toISOString() })
    )
    const first = await src.poll()
    expect(first.firing).toHaveLength(1)
    silent = true
    now += 60_000
    expect((await src.poll()).firing.map((a) => a.key)).toEqual(first.firing.map((a) => a.key))
    now += 20 * 60_000
    expect((await src.poll()).firing).toHaveLength(0)
  })

  it('refuses without a token, naming the variable and never a value', async () => {
    const f = fakeCloud({ nodes: FLEET })
    await expect(createNetdataFleetSource(cfg, deps(f, { env: {} })).poll()).rejects.toThrow('NETDATA_CLOUD_TOKEN is not set')
    expect(f.calls).toHaveLength(0)
  })

  it('backs off after repeated failures and honours Retry-After on a 429', async () => {
    let status = 503
    let now = Date.parse(NOW)
    const f = fakeCloud({ nodes: FLEET, fail: () => (status ? new Response('{}', { status, headers: status === 429 ? { 'retry-after': '240' } : {} }) : undefined) })
    const src = createNetdataFleetSource(cfg, deps(f, { nowIso: () => new Date(now).toISOString() }))
    await expect(src.poll()).rejects.toThrow('Netdata Cloud nodes returned HTTP 503')
    now += 60_000
    await expect(src.poll()).rejects.toThrow('HTTP 503')
    expect(f.calls).toHaveLength(2)
    now += 60_000
    await expect(src.poll()).rejects.toThrow(/^backing off after: .*503.* \(next request in \d+ s\)$/)
    expect(f.calls).toHaveLength(2)
    now += 600_000
    status = 429
    await expect(src.poll()).rejects.toThrow('HTTP 429')
    expect(src.view(now).error).toContain('429')
    status = 0
    now += 61_000
    await expect(src.poll()).rejects.toThrow('backing off')
    now += 240_000
    await expect(src.poll()).resolves.toMatchObject({ source: 'netdata-fleet' })
    expect(src.view(now).error).toBeNull()
  })
})

// ---- GET /api/fleet ----------------------------------------------------------------------------------------------

describe('the fleet view', () => {
  async function view(nodes: FakeNode[] = FLEET, at = Date.parse(NOW) + 5000): Promise<FleetView> {
    const src = createNetdataFleetSource(cfg, deps(fakeCloud({ nodes }), {}), () => Date.parse(NOW))
    await src.poll()
    return src.view(at)
  }

  it('lists fleet servers first (numerically), then watch-only, then k8s, with role and group', async () => {
    const v = await view()
    expect(v.nodes.map((n) => [n.name, n.role, n.group])).toEqual([
      ['node-1', 'fleet', 'servers'],
      ['node-2', 'fleet', 'servers'],
      ['node-13', 'fleet', 'servers'],
      ['print', 'watch-only', 'watch only'],
      ['netdata-k8s-state', 'k8s', 'k8s']
    ])
  })

  it('carries the figures now, the 60-point series, the cores, the link and the firing rules per node', async () => {
    const v = await view()
    const node13 = v.nodes.find((n) => n.name === 'node-13')!
    expect(node13).toMatchObject({ live: true, stale: false, cores: 64, ramBytes: 200000000000, version: 'v2.12.1', cpu: 90, mem: 14, load5: 30, loadPerCore: 0.47, disk: 58, heat: 'hot' })
    expect(node13.cpu10).toBeGreaterThan(80)
    expect(node13.series.cpu).toHaveLength(60)
    expect(node13.series.mem).toHaveLength(60)
    expect(node13.series.loadPerCore).toHaveLength(60)
    expect(node13.series.stepSec).toBe(60)
    expect(node13.series.from).toBe(NOW_SEC - 59 * 60)
    expect(node13.series.cpu[0]).toBe(5)
    expect(node13.series.cpu[59]).toBe(90)
    expect(node13.url).toBe('https://app.netdata.cloud/spaces/example-space/rooms/all-nodes/nodes/node-id-node-13')
    expect(node13.rules).toMatchObject([{ id: 'cpu-hot', alertname: 'HostCpuHot', level: 'warning' }])
    expect(node13.updatedAt).toBe(NOW)
    expect(v.nodes.find((n) => n.name === 'node-1')!.heat).toBe('cold')
  })

  it('a watch-only node has figures and a heat but never a rule; the k8s collector has no figures and is not counted as a host', async () => {
    const v = await view()
    const print = v.nodes.find((n) => n.name === 'print')!
    expect(print).toMatchObject({ role: 'watch-only', heat: 'hot', cpu: 99, rules: [] })
    const k8s = v.nodes.find((n) => n.name === 'netdata-k8s-state')!
    expect(k8s).toMatchObject({ live: false, stale: true, heat: 'unknown', cpu: null, mem: null, loadPerCore: null, rules: [] })
    expect(v.summary).toMatchObject({ nodes: 4, servers: 3, watchOnly: 1, live: 4, hot: 3, hottest: { name: 'print', cpu: 99 } })
  })

  it('says what its thresholds are, when the data is from, and when it is stale', async () => {
    const v = await view()
    expect(v.thresholds.cpu).toEqual({ warnAbove: 80, clearBelow: 70, forMin: 10 })
    expect(v).toMatchObject({ pollSec: 60, windowMin: 60, stepSec: 60, stale: false, error: null, dataAt: NOW, cloudUrl: CLOUD })
    const old = await view(FLEET, Date.parse(NOW) + 4 * 60_000)
    expect(old.stale).toBe(true)
    expect(old.ageSec).toBe(240)
    expect(old.nodes.every((n) => n.stale && n.cpu === null)).toBe(true)
  })

  it('before the first poll it is empty and stale, not an error', () => {
    const v = createNetdataFleetSource(cfg, deps(fakeCloud({ nodes: FLEET }))).view()
    expect(v).toMatchObject({ nodes: [], dataAt: null, ageSec: null, stale: true })
  })

  it('GET /api/fleet answers the view, with no caching, and 503 where the source is not configured', async () => {
    const src = createNetdataFleetSource(cfg, deps(fakeCloud({ nodes: FLEET })), () => Date.parse(NOW))
    await src.poll()
    const engine = new Engine(openDb(':memory:'), wallCfg, () => Date.parse(NOW))
    const base: AppDeps = {
      engine,
      cfg: wallCfg,
      env: {},
      db: engine.db,
      push: new SqlitePushStore(engine.db),
      ackSecret: ['fleet', 'test', '0001'].join('-'),
      webDir: '/nonexistent',
      normalizeWebhook: () => {
        throw new Error('unused')
      },
      testChannel: async () => ({ ok: true, status: 'ok', latencyMs: 1 }),
      nudge: () => undefined,
      vapidPublicKey: null,
      now: () => Date.parse(NOW)
    }
    const on = createApp({ ...base, fleet: () => src.view(Date.parse(NOW)) })
    const res = await on.request('/api/fleet')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as FleetView
    expect(body.nodes.map((n) => n.name)).toContain('node-13')
    const off = createApp(base)
    expect((await off.request('/api/fleet')).status).toBe(503)
  })
})

// ---- disks: every mount that matters ----------------------------------------------------------------------------------

describe('which mounts are kept', () => {
  const GIB = 1024 ** 3

  it('keeps / always, and any other real filesystem of at least 50 GiB', () => {
    expect(keepMount('/', 'ext4', 0.1 * GIB)).toBe(true)
    expect(keepMount('/', 'tmpfs', null)).toBe(true)
    expect(keepMount('/data/ssd1', 'ext4', 3341 * GIB)).toBe(true)
    expect(keepMount('/var/lib/fleet-data', 'xfs', 400 * GIB)).toBe(true)
    expect(keepMount('/Volumes/OWC Express 1M2', 'apfs', 3577 * GIB)).toBe(true)
    expect(keepMount('/data', 'ext4', 50 * GIB)).toBe(true)
  })

  it('drops a small mount, a mount with no size, and a mount of 49.9 GiB', () => {
    expect(keepMount('/Volumes/Ollama', 'hfs', 0.1 * GIB)).toBe(false)
    expect(keepMount('/data', 'ext4', null)).toBe(false)
    expect(keepMount('/data', 'ext4', 50 * GIB - 1)).toBe(false)
  })

  it('drops boot, snap, run, dev, sys, proc, the container runtimes and the macOS system volumes, whatever their size', () => {
    for (const path of ['/boot', '/boot/efi', '/snap/core/1', '/var/snap/lxd', '/run', '/run/user/1000', '/run/box-space/box-dev/pvc-1_desk-usr-1-space', '/var/run', '/dev', '/dev/shm', '/sys/fs/cgroup', '/proc',
      '/var/lib/docker/overlay2/abc/merged', '/var/lib/containerd/io.containerd.runtime.v2.task/k8s.io/abc/rootfs', '/var/lib/kubelet/pods/abc/volumes/kubernetes.io~empty-dir/x', '/var/lib/containers/storage/overlay', '/System/Volumes/Data']) {
      expect(keepMount(path, 'ext4', 900 * GIB), path).toBe(false)
    }
  })

  it('an excluded prefix means that path and what is under it, never a sibling that only starts the same way', () => {
    expect(keepMount('/runner', 'ext4', 900 * GIB)).toBe(true)
    expect(keepMount('/boot2', 'ext4', 900 * GIB)).toBe(true)
    expect(keepMount('/devices/a', 'ext4', 900 * GIB)).toBe(true)
    expect(keepMount('/var/lib/docker-data', 'ext4', 900 * GIB)).toBe(true)
    expect(keepMount('/var/lib/dockerx', 'ext4', 900 * GIB)).toBe(true)
  })

  it('drops tmpfs and the other plumbing filesystems by type, even at 93 GiB on /tmp', () => {
    expect(keepMount('/tmp', 'tmpfs', 93 * GIB)).toBe(false)
    expect(keepMount('/tmp', 'TMPFS', 93 * GIB)).toBe(false)
    expect(keepMount('/mnt/x', 'overlay', 900 * GIB)).toBe(false)
    expect(keepMount('/mnt/y', 'squashfs', 900 * GIB)).toBe(false)
    // a /tmp that is a real partition of its own is a disk worth watching
    expect(keepMount('/tmp', 'ext4', 93 * GIB)).toBe(true)
  })

  it('the query and the filter share one exclusion list', () => {
    for (const p of MOUNT_EXCLUDE_PREFIXES) {
      expect(FLEET_INSTANCES).toContain(`!disk_space.${p}`)
      expect(FLEET_INSTANCES).toContain(`!disk_space.${p}/*`)
    }
  })
})

describe('the heat lines of a disk', () => {
  it('79.9 is ok, 80 is warm, 89.9 is warm, 90 is hot, no reading is unknown', () => {
    expect(diskHeatOf(0)).toBe('ok')
    expect(diskHeatOf(79.9)).toBe('ok')
    expect(diskHeatOf(80)).toBe('warm')
    expect(diskHeatOf(85.7)).toBe('warm')
    expect(diskHeatOf(89.9)).toBe('warm')
    expect(diskHeatOf(90)).toBe('hot')
    expect(diskHeatOf(100)).toBe('hot')
    expect(diskHeatOf(null)).toBe('unknown')
    expect(diskHeatOf(Number.NaN)).toBe('unknown')
  })

  it('reads the figure as the page shows it, to one decimal: 79.96 shows 80.0 and is warm, 79.94 shows 79.9 and is ok', () => {
    expect(diskHeatOf(79.96)).toBe('warm')
    expect(diskHeatOf(79.94)).toBe('ok')
    expect(diskHeatOf(89.96)).toBe('hot')
  })
})

describe('reading disks from the response', () => {
  const GIB = 1024 ** 3
  const mounts = (extra: FakeMount[] = []): FakeMount[] => [
    { path: '/', fs: 'ext4', pct: () => 30.4, sizeGiB: 821.4, reservedGiB: 46.5 },
    { path: '/boot/efi', fs: 'vfat', pct: () => 0.6, sizeGiB: 1 },
    { path: '/run', fs: 'tmpfs', pct: () => 0, sizeGiB: 18.6 },
    { path: '/tmp', fs: 'tmpfs', pct: () => 0, sizeGiB: 93.1 },
    { path: '/run/box-space/box-dev/pvc-1_desk-usr-1-space', fs: 'ext4', pct: () => 8, sizeGiB: 10 },
    { path: '/var/lib/kubelet/pods/abc/volumes/x', fs: 'ext4', pct: () => 50, sizeGiB: 200 },
    { path: '/data/ssd1', fs: 'ext4', pct: () => 25.4, sizeGiB: 3341 - 178.9, reservedGiB: 178.9 },
    { path: '/Volumes/Ollama', fs: 'hfs', pct: () => 80.1, sizeGiB: 0.1 },
    ...extra
  ]

  it('keeps / and the big real mounts, one parsed mount each, and drops the rest', () => {
    const p = parseFleetData(dataBody([{ name: 'node-1', cpu: () => 1, mem: () => 1, load5: () => 1, mounts: mounts() }], 3))
    expect(p.nodes[0].mounts.map((m) => m.path)).toEqual(['/', '/data/ssd1'])
    expect(p.nodes[0].mounts.map((m) => m.fs)).toEqual(['ext4', 'ext4'])
    // `disk` stays the root's percent
    expect(p.nodes[0].disk[2]).toBeCloseTo(30.4, 6)
  })

  it('percent is used / (used + avail), bytes come from the column units, size adds what is reserved for root', () => {
    const p = parseFleetData(dataBody([{ name: 'node-1', cpu: () => 1, mounts: [{ path: '/', fs: 'ext4', pct: () => 86, sizeGiB: 800, reservedGiB: 46.5 }] }], 2))
    const m = p.nodes[0].mounts[0]
    expect(m.pct[1]).toBeCloseTo(86, 9)
    expect(m.used[1]).toBeCloseTo(0.86 * 800 * GIB, 0)
    expect(m.free[1]).toBeCloseTo(0.14 * 800 * GIB, 0)
    expect(m.reserved[1]).toBeCloseTo(46.5 * GIB, 0)
  })

  it('a node with no disk columns has no mounts and an all-null root series', () => {
    const p = parseFleetData(dataBody([{ name: 'node-1', cpu: () => 1 }], 3))
    expect(p.nodes[0].mounts).toEqual([])
    expect(p.nodes[0].disk).toEqual([null, null, null])
  })

  it('reads a response that predates the instance grouping as the root alone', () => {
    const p = parseFleetData(dataBody([{ name: 'node-13', cpu: () => 80, mem: () => 40, load5: () => 12, disk: () => 55, legacy: true }], 3))
    expect(p.nodes[0].mounts.map((m) => m.path)).toEqual(['/'])
    expect(Math.round(p.nodes[0].disk[2] as number)).toBe(55)
  })

  it('splits a column id by the order the response names, an instance with a comma in it whole', () => {
    expect(splitColumnId('used,disk_space./data/ssd1,ext4,guid-node-1,disk.space', ORDER)).toEqual({ dim: 'used', instance: 'disk_space./data/ssd1', fs: 'ext4', guid: 'guid-node-1', ctx: 'disk.space' })
    expect(splitColumnId('reserved for root,disk_space./Volumes/A,B,hfs,guid-node-1,disk.space', ORDER)).toMatchObject({ dim: 'reserved for root', instance: 'disk_space./Volumes/A,B', fs: 'hfs' })
    expect(splitColumnId('user,system.cpu,[unset],guid-node-1,system.cpu', ORDER)).toMatchObject({ instance: 'system.cpu', fs: '' })
    expect(splitColumnId('used,guid-node-1,disk.space')).toEqual({ dim: 'used', instance: '', fs: '', guid: 'guid-node-1', ctx: 'disk.space' })
    expect(splitColumnId('nonsense', ORDER)).toBeNull()
    expect(mountPath('disk_space./data/ssd1')).toBe('/data/ssd1')
    expect(mountPath('disk_space._')).toBe('/')
  })
})

describe('the disk in the fleet view', () => {
  const NODES: FakeNode[] = [
    // node-1: root 30.4 %, six data disks, the fullest at 38.3 %: the fullest leads
    {
      name: 'node-1',
      cores: 32,
      cpu: () => 2,
      mem: () => 13,
      load5: () => 1.5,
      mounts: [
        { path: '/', fs: 'ext4', pct: () => 30.4, sizeGiB: 821.4, reservedGiB: 46.5 },
        { path: '/data/ssd1', fs: 'ext4', pct: () => 25.4, sizeGiB: 3162.1, reservedGiB: 178.9 },
        { path: '/data/ssd6', fs: 'ext4', pct: () => 38.3, sizeGiB: 3162.1, reservedGiB: 178.9 },
        { path: '/tmp', fs: 'tmpfs', pct: () => 0, sizeGiB: 93.1 }
      ]
    },
    // node-4: root at 85.2 % (warm); node-3: a data volume at 91 % hotter than its root at 69 %
    { name: 'node-4', cores: 32, cpu: () => 3, mem: () => 13, load5: () => 1, mounts: [{ path: '/', fs: 'ext4', pct: (i) => (i < 30 ? 70 : 85.2), sizeGiB: 868.1, reservedGiB: 46.5 }] },
    {
      name: 'node-2',
      cores: 32,
      cpu: () => 3,
      mem: () => 13,
      load5: () => 1,
      mounts: [
        { path: '/', fs: 'ext4', pct: () => 69, sizeGiB: 868.1, reservedGiB: 46.5 },
        { path: '/var/lib/fleet-data', fs: 'xfs', pct: () => 91, sizeGiB: 400 }
      ]
    },
    // print: root 79.9 %, just under the line
    { name: 'print', cores: 2, cpu: () => 5, mem: () => 28, load5: () => 0.5, disk: () => 79.9 },
    // the k8s collector reports no disk at all
    { name: 'netdata-k8s-state' }
  ]
  const view = async (): Promise<FleetView> => {
    const src = createNetdataFleetSource({ ...cfg, fleetNodes: ['node-1', 'node-2', 'node-4'] }, deps(fakeCloud({ nodes: NODES })), () => Date.parse(NOW))
    await src.poll()
    return src.view(Date.parse(NOW) + 5000)
  }

  it('lists every mount that matters, the fullest first, with the heat of each and the heat of the worst on the node', async () => {
    const v = await view()
    const node1 = v.nodes.find((n) => n.name === 'node-1')!
    expect(node1.mounts.map((m) => [m.path, m.usedPct, m.heat])).toEqual([
      ['/data/ssd6', 38.3, 'ok'],
      ['/', 30.4, 'ok'],
      ['/data/ssd1', 25.4, 'ok']
    ])
    expect(node1.diskHeat).toBe('ok')
    // the root figure survives for readers of the old view
    expect(node1.disk).toBe(30.4)
    const node2 = v.nodes.find((n) => n.name === 'node-2')!
    expect(node2.mounts.map((m) => [m.path, m.usedPct, m.heat])).toEqual([
      ['/var/lib/fleet-data', 91, 'hot'],
      ['/', 69, 'ok']
    ])
    expect(node2.diskHeat).toBe('hot')
    expect(node2.disk).toBe(69)
  })

  it('carries bytes in bytes: used, free (avail) and size (used + avail + reserved), and a 60-point used-% series', async () => {
    const v = await view()
    const node4 = v.nodes.find((n) => n.name === 'node-4')!
    const root = node4.mounts[0]
    expect(root).toMatchObject({ path: '/', fs: 'ext4', usedPct: 85.2, heat: 'warm' })
    expect(root.usedBytes).toBe(Math.round(0.852 * 868.1 * GIB_))
    expect(root.freeBytes).toBe(Math.round(0.148 * 868.1 * GIB_))
    expect(root.sizeBytes).toBe(Math.round((868.1 + 46.5) * GIB_))
    expect(root.series).toHaveLength(60)
    expect(root.series[0]).toBe(70)
    expect(root.series[59]).toBe(85.2)
    expect(node4.series.disk[59]).toBe(85.2)
  })

  it('a warm or hot disk never changes the node heat, which stays CPU, memory and load', async () => {
    const v = await view()
    const node4 = v.nodes.find((n) => n.name === 'node-4')!
    expect(node4.diskHeat).toBe('warm')
    expect(node4.heat).toBe('cold')
    expect(v.nodes.find((n) => n.name === 'node-2')!.heat).toBe('cold')
  })

  it('79.9 % is ok, and publishes the two lines it was judged by', async () => {
    const v = await view()
    expect(v.nodes.find((n) => n.name === 'print')).toMatchObject({ diskHeat: 'ok', disk: 79.9, mounts: [{ path: '/', usedPct: 79.9, heat: 'ok' }] })
    expect(v.thresholds.disk).toEqual({ warmAt: 80, hotAt: 90 })
  })

  it('a node that reported no disk has no mounts, an unknown disk heat and a null root figure', async () => {
    const k8s = (await view()).nodes.find((n) => n.name === 'netdata-k8s-state')!
    expect(k8s).toMatchObject({ mounts: [], diskHeat: 'unknown', disk: null })
  })

  it('a stale feed keeps each mount and its series but no figure, and reads unknown', async () => {
    const src = createNetdataFleetSource({ ...cfg, fleetNodes: ['node-1', 'node-2', 'node-4'] }, deps(fakeCloud({ nodes: NODES })), () => Date.parse(NOW))
    await src.poll()
    const old = src.view(Date.parse(NOW) + 4 * 60_000)
    const node4 = old.nodes.find((n) => n.name === 'node-4')!
    expect(node4.mounts[0]).toMatchObject({ path: '/', usedPct: null, usedBytes: null, freeBytes: null, sizeBytes: null, heat: 'unknown' })
    expect(node4.mounts[0].series).toHaveLength(60)
    expect(node4.diskHeat).toBe('unknown')
  })
})

describe('the disk in words and in the sort', () => {
  const GIB = 1024 ** 3
  const nodes: FakeNode[] = [
    { name: 'node-4', cores: 32, cpu: () => 3, mem: () => 13, load5: () => 1, mounts: [{ path: '/', fs: 'ext4', pct: () => 86, sizeGiB: 868.2, reservedGiB: 46.5 }] },
    { name: 'node-1', cores: 32, cpu: () => 2, mem: () => 13, load5: () => 1.5, mounts: [{ path: '/', fs: 'ext4', pct: () => 30.4, sizeGiB: 821.4, reservedGiB: 46.5 }, { path: '/data/ssd1', fs: 'ext4', pct: () => 91, sizeGiB: 3162, reservedGiB: 178.9 }] },
    { name: 'node-2', cores: 32, cpu: () => 3, mem: () => 13, load5: () => 1, disk: () => 79.9 },
    { name: 'print', cores: 2, cpu: () => 5, mem: () => 28, load5: () => 0.5, disk: () => 85.7 }
  ]
  const view = async (): Promise<FleetView> => {
    const src = createNetdataFleetSource({ ...cfg, fleetNodes: ['node-1', 'node-2', 'node-4'] }, deps(fakeCloud({ nodes })), () => Date.parse(NOW))
    await src.poll()
    return src.view(Date.parse(NOW) + 5000)
  }

  it('says a size the way Netdata does: GiB under 1 TiB, TiB from it, one decimal under 10 GiB and from 1 TiB', () => {
    expect(bytesText(121.9 * GIB)).toBe('122\u00a0GiB')
    expect(bytesText(914.7 * GIB)).toBe('915\u00a0GiB')
    expect(bytesText(9.44 * GIB)).toBe('9.4\u00a0GiB')
    expect(bytesText(3.4 * 1024 * GIB)).toBe('3.4\u00a0TiB')
    expect(bytesText(512 * 1024 ** 2)).toBe('512\u00a0MiB')
    expect(bytesText(null)).toBe('')
    expect(diskFreeText({ freeBytes: 121.9 * GIB, sizeBytes: 914.7 * GIB })).toBe('122\u00a0GiB free of 915\u00a0GiB')
    expect(diskFreeText({ freeBytes: 5 * GIB, sizeBytes: null })).toBe('5.0\u00a0GiB free')
    expect(diskFreeText({ freeBytes: null, sizeBytes: 5 * GIB })).toBe('')
    expect(diskPercentText(86)).toBe('86.0%')
    expect(diskPercentText(79.9)).toBe('79.9%')
    expect(diskPercentText(null)).toBe('-')
  })

  it('the header line names a warm or hot disk with its figure, hot first, and a node that is only warm on disk is not counted hot', async () => {
    const v = await view()
    const h = fleetHeadline(v)
    expect(h.lead).toBe('4 nodes, none hot, 1 disk hot: node-1 91.0%, 2 disks warm: node-4 86.0% and print 85.7%.')
    expect(stripLabel(v, Date.parse(NOW) + 5000)).toContain('1 disk hot: node-1 91.0%')
    // 79.9 % is under the line: node-2 is not named
    expect(h.lead).not.toContain('node-2')
  })

  it('the header line stays as it was when every disk is under 80 %', async () => {
    const src = createNetdataFleetSource({ ...cfg, fleetNodes: ['node-2'] }, deps(fakeCloud({ nodes: [nodes[2]] })), () => Date.parse(NOW))
    await src.poll()
    expect(fleetHeadline(src.view(Date.parse(NOW) + 5000)).lead).toBe('1 node, none hot.')
  })

  it('sorts by the fullest mount, not the root: node-1 (91 % on a data disk) leads, 79.9 % last, a node with no disk after all of them', async () => {
    const v = await view()
    expect(worstMount(v.nodes.find((n) => n.name === 'node-1')!)).toMatchObject({ path: '/data/ssd1', usedPct: 91 })
    expect(sortNodes(v.nodes, { key: 'disk', dir: 'desc' }).map((n) => n.name)).toEqual(['node-1', 'node-4', 'print', 'node-2'])
    expect(sortNodes(v.nodes, { key: 'disk', dir: 'asc' }).map((n) => n.name)).toEqual(['node-2', 'print', 'node-4', 'node-1'])
  })

  it('a screen reader hears the node, the fullest mount, its heat and what is free', async () => {
    const v = await view()
    expect(diskWords(v.nodes.find((n) => n.name === 'node-4')!)).toBe('node-4 disk 86.0% on /, warm, 122\u00a0GiB free of 915\u00a0GiB')
    expect(diskWords({ name: 'x', mounts: [] })).toBe('x disk, no reading')
  })
})

// ---- one incident with Netdata's own alert -----------------------------------------------------------------------

const cloudCfg: NetdataCloudSourceConfig = {
  id: 'netdata-cloud',
  type: 'netdata-cloud',
  url: 'https://app.netdata.cloud',
  tokenEnv: 'NETDATA_CLOUD_TOKEN',
  spaceId: SPACE,
  roomId: ROOM,
  pollSec: 60,
  fleetNodes: ['node-1', 'node-2', 'node-3', 'node-4', 'node-5'],
  watchOnlyNodes: ['print', 'mac-a1.example.net']
}

const wallCfg: WatchConfig = {
  baseUrl: 'https://watch.test',
  port: 0,
  host: '127.0.0.1',
  dataDir: ':memory:',
  historyHours: 24,
  staleAfterMisses: 3,
  sources: [cloudCfg, cfg],
  serviceMap: [],
  channels: [],
  routes: [
    { id: 'page', match: { severity: ['page'] }, receivers: ['phone'], mode: 'all', groupWaitSec: 0, groupIntervalSec: 60, repeatIntervalSec: 600 },
    { id: 'warning', match: { severity: ['warning'] }, receivers: [], mode: 'all', groupWaitSec: 0, groupIntervalSec: 300, repeatIntervalSec: 86400 }
  ],
  quietHours: null
}

describe('dedupe with Netdata’s own 10min_cpu_usage', () => {
  const policy = netdataPolicyOf(cloudCfg, cfg.fleetNodes)
  const finding = (node: string, alert: string, level: 'warning' | 'critical') => ({ node, alert, instance: 'system.cpu', level })

  it('on a node the fleet rules cover, Netdata’s CPU and RAM alerts take the rule’s title and the Fleet load service, as a warning', () => {
    for (const [alert, id] of [['10min_cpu_usage', 'cpu-hot'], ['ram_in_use', 'memory-hot'], ['ram_available', 'memory-hot']] as const) {
      for (const level of ['warning', 'critical'] as const) {
        expect(classifyNetdataAlert(finding('node-13', alert, level), policy)).toMatchObject({ show: true, rule: fleetRuleTitle(id, 'node-13'), service: 'Fleet load', severity: 'warning', fleetRule: id, watchOnly: false })
      }
    }
  })

  it('elsewhere nothing changes: a watch-only node, and a policy with no load nodes, keep the old title on the Netdata tile', () => {
    expect(classifyNetdataAlert(finding('print', '10min_cpu_usage', 'warning'), policy)).toMatchObject({ rule: 'Netdata: CPU usage (print)', service: 'Netdata', watchOnly: true })
    expect(classifyNetdataAlert(finding('node-13', 'ram_available', 'critical'), netdataPolicyOf(cloudCfg))).toMatchObject({ rule: 'Netdata: RAM available (node-13)', service: 'Netdata' })
  })

  it('Watch’s alert and Netdata’s land in ONE incident: same service and rule, two alerts, reach 2, the memory page still a page', async () => {
    const T0 = Date.parse(NOW)
    const engine = new Engine(openDb(':memory:'), wallCfg, () => T0)
    const ours = await createNetdataFleetSource(cfg, deps(fakeCloud({ nodes: FLEET }))).poll()
    engine.ingest(ours)
    const verdict = classifyNetdataAlert(finding('node-13', '10min_cpu_usage', 'warning'), policy)
    if (!verdict.show) throw new Error('expected the alert to show')
    const theirs: Alert = makeAlert(
      {
        origin: 'netdata-cloud',
        fingerprint: 'feedfacecafebeef',
        rule: verdict.rule,
        labels: { alertname: '10min_cpu_usage', severity: 'warning', host: 'node-13', service: verdict.service },
        startsAt: NOW,
        via: { source: 'netdata-cloud', kind: 'netdata-cloud', lastSeen: NOW },
        raw: {}
      },
      [],
      NOW
    )
    engine.ingest({ source: 'netdata-cloud', kind: 'netdata-cloud', at: NOW, firing: [theirs], resolved: [], complete: true })
    const wall = engine.wall()
    const tile = wall.incidents.find((i) => i.key === 'Fleet load|Host CPU hot (node-13)')!
    expect(tile.alerts.map((a) => a.origin).sort()).toEqual(['netdata-cloud', 'netdata-fleet'])
    expect(tile.state.instances).toBe(2)
    expect(wall.incidents.filter((i) => i.service === 'Fleet load' && i.rule.includes('CPU'))).toHaveLength(1)
  })
})

// ---- the web side ------------------------------------------------------------------------------------------------

describe('the Sources page and the wall know the new kind', () => {
  it('labels it in words, says what silence does, and words its cells like the Netdata Cloud ones', () => {
    expect(kindLabel('netdata-fleet')).toBe('Netdata fleet metrics (CPU, memory, load), polled every minute')
    expect(quietText({ kind: 'netdata-fleet', staleAfterSec: undefined })).toBe('If it misses three polls in a row, the wall raises its own source-stale warning.')
    const cell = { id: 'netdata-fleet:cpu-hot', source: 'netdata-fleet', name: 'HostCpuHot', service: 'Fleet load', state: 'ok' as const }
    expect(cellOrigin(cell, { 'netdata-fleet': 'netdata-fleet' })).toBe('netdata-cloud')
  })
})

// ---- ignoreNodes -------------------------------------------------------------------------------------------------

describe('ignoreNodes: a node Watch does not watch (print: print spooler, not monitored)', () => {
  const ignoring: NetdataFleetSourceConfig = { ...cfg, watchOnlyNodes: ['mac-a1.example.net'], ignoreNodes: { print: 'print spooler, not monitored' } }
  const newbox: FakeNode = { name: 'newbox', cores: 2, cpu: () => 5, mem: () => 10, load5: () => 0.1, disk: () => 10 }
  async function polled(config: NetdataFleetSourceConfig, nodes: FakeNode[] = FLEET) {
    const src = createNetdataFleetSource(config, deps(fakeCloud({ nodes })), () => Date.parse(NOW))
    const obs = await src.poll()
    return { obs, v: src.view(Date.parse(NOW) + 5000) }
  }

  it('has no row and no count: not in nodes[], and out of nodes, servers, watchOnly, live, hot, warm, cold, hottest and the fleet CPU average', async () => {
    const { v } = await polled(ignoring)
    expect(v.nodes.map((n) => n.name)).toEqual(['node-1', 'node-2', 'node-13', 'netdata-k8s-state'])
    expect(v.summary).toEqual({ nodes: 3, servers: 3, watchOnly: 0, live: 3, hot: 2, warm: 0, cold: 1, hottest: { name: 'node-13', cpu: 90 }, fleetCpuAvg: 37.3 })
    // the same room with print listed as watch-only is the old view: a row, and print the hottest node
    const before = await polled(cfg)
    expect(before.v.nodes.map((n) => n.name)).toContain('print')
    expect(before.v.summary).toMatchObject({ nodes: 4, watchOnly: 1, hottest: { name: 'print', cpu: 99 } })
  })

  it('raises nothing for it and the rules and cells on the fleet nodes are unchanged', async () => {
    const { obs } = await polled(ignoring)
    expect(obs.firing.some((a) => a.host === 'print')).toBe(false)
    expect(obs.firing.map((a) => a.rule).sort()).toEqual(['Host CPU hot (node-13)', 'Host memory hot (node-2)'])
    expect(obs.rules!.find((c) => c.name.startsWith('Fleet metrics from Netdata Cloud'))!.name).toBe('Fleet metrics from Netdata Cloud (3/3 servers)')
  })

  it('a node in the room that is in no list and not ignored behaves as before: a watch-only row, counted, never a rule', async () => {
    const { obs, v } = await polled(ignoring, [...FLEET, newbox])
    expect(v.nodes.map((n) => [n.name, n.role, n.group])).toEqual([
      ['node-1', 'fleet', 'servers'],
      ['node-2', 'fleet', 'servers'],
      ['node-13', 'fleet', 'servers'],
      ['newbox', 'watch-only', 'watch only'],
      ['netdata-k8s-state', 'k8s', 'k8s']
    ])
    expect(v.summary).toMatchObject({ nodes: 4, servers: 3, watchOnly: 1, live: 4 })
    expect(obs.firing.some((a) => a.host === 'newbox')).toBe(false)
  })

  it('ignoredNode compares names without case and takes the exact name, not a prefix', () => {
    expect(ignoredNode('print', ignoring)).toBe(true)
    expect(ignoredNode('PRINT', ignoring)).toBe(true)
    expect(ignoredNode('printer', ignoring)).toBe(false)
    expect(ignoredNode('node-13', ignoring)).toBe(false)
    expect(ignoredNode('print', cfg)).toBe(false)
  })
})

// ---- config ------------------------------------------------------------------------------------------------------

describe('config', () => {
  const real = JSON.parse(JSON.stringify(loadConfig(fileURLToPath(new URL('./fixtures/watch.config.json', import.meta.url))))) as WatchConfig
  const write = (patch: Record<string, unknown>): string => {
    const copy = JSON.parse(JSON.stringify(real)) as WatchConfig
    Object.assign(copy.sources.find((s) => s.type === 'netdata-fleet')!, patch)
    const path = join(mkdtempSync(join(tmpdir(), 'watch-fleet-')), 'cfg.json')
    writeFileSync(path, JSON.stringify(copy))
    return path
  }

  it('ships the thresholds in config/watch.example.json and the fleet list of the brief', () => {
    const s = real.sources.find((x) => x.type === 'netdata-fleet') as NetdataFleetSourceConfig
    expect(s.fleetNodes).toEqual(['node-1', 'node-2', 'node-3', 'node-4', 'node-5', 'node-6', 'node-7', 'node-8', 'node-13', 'node-14', 'node-15'])
    expect(s.rules).toEqual({
      cpu: { warnAbove: 80, clearBelow: 70, forMin: 10 },
      memory: { warnAbove: 85, clearBelow: 80, pageAbove: 95, pageClearBelow: 90, forMin: 10 },
      load: { warnAbove: 1.5, clearBelow: 1.2, forMin: 15 },
      coldCpuBelow: 10
    })
    expect(s.tokenEnv).toBe('NETDATA_CLOUD_TOKEN')
  })

  it('does not watch print: it is in ignoreNodes with its reason and in no list', () => {
    const s = real.sources.find((x) => x.type === 'netdata-fleet') as NetdataFleetSourceConfig
    expect(s.ignoreNodes).toEqual({ print: 'print spooler, not monitored' })
    expect(s.watchOnlyNodes).toEqual(['mac-a1.example.net'])
    expect([...s.fleetNodes, ...(s.k8sNodes ?? [])]).not.toContain('print')
  })

  it('validates ignoreNodes: an object of node name to a one-line reason, and a node is never both ignored and listed', () => {
    expect(() => loadConfig(write({ ignoreNodes: { print: 'print spooler, not monitored', box2: 'decommissioned' } }))).not.toThrow()
    expect(() => loadConfig(write({ ignoreNodes: undefined }))).not.toThrow()
    expect(() => loadConfig(write({ ignoreNodes: ['print'] }))).toThrow('ignoreNodes must be an object')
    expect(() => loadConfig(write({ ignoreNodes: { '': 'why' } }))).toThrow('ignoreNodes has an entry that names a node')
    expect(() => loadConfig(write({ ignoreNodes: { print: '' } }))).toThrow('ignoreNodes.print must be one line')
    expect(() => loadConfig(write({ ignoreNodes: { print: 3 } }))).toThrow('ignoreNodes.print must be one line')
    expect(() => loadConfig(write({ ignoreNodes: { print: 'two\nlines' } }))).toThrow('ignoreNodes.print must be one line')
    expect(() => loadConfig(write({ ignoreNodes: { 'NODE-13': 'why' } }))).toThrow('NODE-13 is in ignoreNodes and in fleetNodes')
    expect(() => loadConfig(write({ ignoreNodes: { 'mac-a1.example.net': 'why' } }))).toThrow('mac-a1.example.net is in ignoreNodes and in watchOnlyNodes')
    expect(() => loadConfig(write({ ignoreNodes: { 'netdata-k8s-state': 'why' } }))).toThrow('netdata-k8s-state is in ignoreNodes and in k8sNodes')
  })

  it('rejects a bad rule with a message that names the field', () => {
    expect(() => loadConfig(write({}))).not.toThrow()
    expect(() => loadConfig(write({ url: 'http://app.netdata.cloud' }))).toThrow('needs an https url')
    expect(() => loadConfig(write({ fleetNodes: [] }))).toThrow('needs fleetNodes')
    expect(() => loadConfig(write({ windowMin: 5 }))).toThrow('windowMin')
    expect(() => loadConfig(write({ rules: { cpu: { warnAbove: 70, clearBelow: 80, forMin: 10 } } }))).toThrow('rules.cpu.clearBelow must be under warnAbove')
    expect(() => loadConfig(write({ rules: { cpu: { warnAbove: 80, clearBelow: 70, forMin: 90 } } }))).toThrow('forMin must be a whole number of minutes, at most windowMin')
    expect(() => loadConfig(write({ rules: { memory: { warnAbove: 85, clearBelow: 80, forMin: 10, pageAbove: 80, pageClearBelow: 70 } } }))).toThrow('pageAbove must not be under warnAbove')
    expect(() => loadConfig(write({ rules: { memory: { warnAbove: 85, clearBelow: 80, forMin: 10 } } }))).toThrow('pageAbove and pageClearBelow')
  })
})
