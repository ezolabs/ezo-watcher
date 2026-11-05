// The host source: the machine the Watcher runs on, read with node:os and fs.statfs and nothing installed. Every reading goes through the reader
// seam, so a test says what the machine holds (a disk at 3 % free, a dead pid) instead of depending on the one CI happens to run on. The two cases
// the seam cannot fake (a real statfs of a temp directory, the real /proc/meminfo or the platform's free memory, a real process by its own pid) are
// checked against this machine at the end.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { configServiceNames, loadConfig } from '../../src/server/config.ts'
import type { HostSourceConfig, WatchConfig } from '../../src/server/config.ts'
import { openDb } from '../../src/server/db.ts'
import { Engine } from '../../src/server/engine.ts'
import { POLLED } from '../../src/server/source-registry.ts'
import { GB, HOST_ASSERTS, HOST_DEFAULTS, HOST_RULES, createHostSource, hostMountsOf, hostProblems, hostThresholdsOf, normalizeHost, pctText, proveHost, readHost } from '../../src/server/sources/host.ts'
import type { HostReadings, HostReader } from '../../src/server/sources/host.ts'
import type { SourceDeps } from '../../src/server/sources/types.ts'
import type { Observation, RuleCell } from '../../src/shared/types.ts'
import { assertsBeyondDefault } from '../../src/server/sources/checks.ts'

const T0 = Date.parse('2026-11-04T12:00:00Z')
const ISO = new Date(T0).toISOString()
const GB_BYTES = GB

const cfg = (over: Partial<HostSourceConfig> = {}): HostSourceConfig => ({ id: 'host', type: 'host', ...over })

const ctx = (nowIso = ISO) => ({ nowIso, serviceMap: [] })

/** One machine, with what the test cares about changed. Defaults are a quiet box: 50 % disk free, half the memory available, load 0.4 on 4 cores. */
function readings(over: Partial<HostReadings> = {}): HostReadings {
  return {
    at: ISO,
    hostname: 'build-1',
    cores: 4,
    load5: 0.4,
    totalBytes: 16 * GB_BYTES,
    availableBytes: 8 * GB_BYTES,
    memSource: 'MemAvailable',
    disks: [{ mount: '/', ok: true, totalBytes: 100 * GB_BYTES, freeBytes: 50 * GB_BYTES }],
    process: null,
    ...over
  }
}

/** A disk with this percent of 100 GB free. */
const diskAt = (pct: number, mount = '/'): HostReadings['disks'] => [{ mount, ok: true, totalBytes: 100 * GB_BYTES, freeBytes: pct * GB_BYTES }]

const cellOf = (obs: Observation, rule: string, instance: string): RuleCell | undefined => obs.checks?.cells.find((c) => c.checkId === rule && c.name === instance)

// ---- what one poll means -----------------------------------------------------------------------------------------------------------------

describe('the disk check', () => {
  it('warns under 10 % free, pages under 5 %, and is quiet above both', () => {
    const warn = normalizeHost(readings({ disks: diskAt(8) }), cfg(), ctx())
    expect(warn.firing.map((a) => [a.rule, a.severity])).toEqual([[HOST_RULES.disk, 'warning']])
    // the page tier is resolved, not left firing from a previous poll
    expect(warn.resolved.filter((a) => a.rule === HOST_RULES.disk).map((a) => a.severity)).toEqual(['page'])
    expect(cellOf(warn, HOST_RULES.disk, '/')).toMatchObject({ state: 'firing', service: 'host' })

    const page = normalizeHost(readings({ disks: diskAt(3) }), cfg(), ctx())
    expect(page.firing.map((a) => [a.rule, a.severity])).toEqual([[HOST_RULES.disk, 'page']])
    expect(page.resolved.filter((a) => a.rule === HOST_RULES.disk).map((a) => a.severity)).toEqual(['warning'])
    expect(page.firing[0].annotations.summary).toContain('3.0% free')
    expect(page.firing[0].annotations.page_reason).toContain('3.0% free')

    const fine = normalizeHost(readings({ disks: diskAt(50) }), cfg(), ctx())
    expect(fine.firing).toEqual([])
    expect(fine.resolved.filter((a) => a.rule === HOST_RULES.disk).map((a) => a.severity).sort()).toEqual(['page', 'warning'])
    expect(cellOf(fine, HOST_RULES.disk, '/')).toMatchObject({ state: 'ok', detail: '50.0% free (50.0 GB of 100.0 GB)' })
  })

  it('reads the boundary as the better tier: exactly 5 % free is a warning, not a page', () => {
    const at = normalizeHost(readings({ disks: diskAt(5) }), cfg(), ctx())
    expect(at.firing.map((a) => a.severity)).toEqual(['warning'])
    const under = normalizeHost(readings({ disks: diskAt(4.9) }), cfg(), ctx())
    expect(under.firing.map((a) => a.severity)).toEqual(['page'])
  })

  it('takes its own thresholds, and the assertion names the page tier', () => {
    const own = normalizeHost(readings({ disks: diskAt(20) }), cfg({ thresholds: { diskFreeWarnPct: 25, diskFreePagePct: 15 } }), ctx())
    expect(own.firing.map((a) => a.severity)).toEqual(['warning'])
    expect(cellOf(own, HOST_RULES.disk, '/')?.asserts).toEqual(['disk:/ free>15%'])
  })

  it('watches every configured mount on its own instance', () => {
    const two = normalizeHost(
      readings({ disks: [{ mount: '/', ok: true, totalBytes: 100 * GB_BYTES, freeBytes: 50 * GB_BYTES }, { mount: '/data', ok: true, totalBytes: 100 * GB_BYTES, freeBytes: 2 * GB_BYTES }] }),
      cfg({ mounts: ['/', '/data'] }),
      ctx()
    )
    expect(two.firing.map((a) => [a.labels.instance, a.severity])).toEqual([['/data', 'page']])
    expect(cellOf(two, HOST_RULES.disk, '/data')).toMatchObject({ state: 'firing', asserts: ['disk:/data free>5%'] })
    expect(cellOf(two, HOST_RULES.disk, '/')).toMatchObject({ state: 'ok' })
  })

  it('leaves the alert as it was, and the cell without data, when the disk cannot be read', () => {
    const blind = normalizeHost(readings({ disks: [{ mount: '/', ok: false, detail: 'statfs failed: ENOENT' }] }), cfg(), ctx())
    expect(blind.firing.filter((a) => a.rule === HOST_RULES.disk)).toEqual([])
    expect(blind.resolved.filter((a) => a.rule === HOST_RULES.disk)).toEqual([])
    expect(cellOf(blind, HOST_RULES.disk, '/')).toMatchObject({ state: 'nodata', detail: 'statfs failed: ENOENT' })
    // one blind reading makes the poll partial: nothing it omits may resolve
    expect(blind.complete).toBe(false)
  })
})

describe('the memory check', () => {
  it('warns when available memory is under 10 %, and resolves when it is back above', () => {
    const tight = normalizeHost(readings({ availableBytes: 1 * GB_BYTES }), cfg(), ctx())
    expect(tight.firing.map((a) => [a.rule, a.severity])).toEqual([[HOST_RULES.memory, 'warning']])
    expect(tight.firing[0].annotations.summary).toContain('6.3%')
    expect(cellOf(tight, HOST_RULES.memory, 'memory')).toMatchObject({ state: 'firing', asserts: ['mem:available>10%'] })

    const fine = normalizeHost(readings(), cfg(), ctx())
    expect(fine.firing).toEqual([])
    expect(fine.resolved.filter((a) => a.rule === HOST_RULES.memory).map((a) => a.rule)).toEqual([HOST_RULES.memory])
    expect(cellOf(fine, HOST_RULES.memory, 'memory')).toMatchObject({ state: 'ok', detail: '50.0% available (8.0 GB of 16.0 GB, MemAvailable)' })
  })

  it('names the source of the number it read', () => {
    const free = normalizeHost(readings({ availableBytes: 1 * GB_BYTES, memSource: 'free' }), cfg(), ctx())
    expect(free.firing[0].annotations.description).toContain('the free memory the platform reports')
  })

  it('skips the cell when the platform reports no total memory', () => {
    const none = normalizeHost(readings({ totalBytes: 0, availableBytes: 0 }), cfg(), ctx())
    expect(none.firing.filter((a) => a.rule === HOST_RULES.memory)).toEqual([])
    expect(cellOf(none, HOST_RULES.memory, 'memory')).toMatchObject({ state: 'nodata' })
  })
})

describe('the load check', () => {
  it('warns above 2 per core on the kernel 5-minute average, and resolves under it', () => {
    const hot = normalizeHost(readings({ cores: 4, load5: 8.4 }), cfg(), ctx())
    expect(hot.firing.map((a) => [a.rule, a.severity])).toEqual([[HOST_RULES.load, 'warning']])
    expect(hot.firing[0].annotations.summary).toBe('Load on build-1 is 8.40 (2.10 per core)')
    expect(cellOf(hot, HOST_RULES.load, 'load')).toMatchObject({ state: 'firing', asserts: ['load:5m/core<2'] })

    // the same load on 64 cores is a quiet machine
    const big = normalizeHost(readings({ cores: 64, load5: 8.4 }), cfg(), ctx())
    expect(big.firing).toEqual([])
    expect(cellOf(big, HOST_RULES.load, 'load')).toMatchObject({ state: 'ok' })

    const cooled = normalizeHost(readings(), cfg(), ctx())
    expect(cooled.resolved.filter((a) => a.rule === HOST_RULES.load).map((a) => a.rule)).toEqual([HOST_RULES.load])
  })

  it('skips the cell where the platform reports no load average', () => {
    const windows = normalizeHost(readings({ load5: null }), cfg(), ctx())
    expect(windows.firing.filter((a) => a.rule === HOST_RULES.load)).toEqual([])
    expect(cellOf(windows, HOST_RULES.load, 'load')).toMatchObject({ state: 'nodata', detail: 'this platform reports no load average' })
    expect(windows.complete).toBe(false)
  })
})

describe('the optional process check', () => {
  const pid = (state: 'alive' | 'dead' | 'missing' | 'unreadable', pid: number | null = 4242): HostReadings => readings({ process: { pidFile: '/run/app.pid', state, pid, detail: `pid ${pid ?? 'none'}` } })

  it('pages when the pid in the file is not running, and resolves when it is', () => {
    const dead = normalizeHost(pid('dead'), cfg({ pidFile: '/run/app.pid' }), ctx())
    expect(dead.firing.map((a) => [a.rule, a.severity])).toEqual([[HOST_RULES.process, 'page']])
    expect(cellOf(dead, HOST_RULES.process, '/run/app.pid')).toMatchObject({ state: 'firing', asserts: ['pid:/run/app.pid running'] })

    const gone = normalizeHost(pid('missing', null), cfg({ pidFile: '/run/app.pid' }), ctx())
    expect(gone.firing.map((a) => a.rule)).toEqual([HOST_RULES.process])

    const alive = normalizeHost(pid('alive'), cfg({ pidFile: '/run/app.pid' }), ctx())
    expect(alive.firing).toEqual([])
    expect(alive.resolved.filter((a) => a.rule === HOST_RULES.process).map((a) => a.rule)).toEqual([HOST_RULES.process])
    expect(cellOf(alive, HOST_RULES.process, '/run/app.pid')).toMatchObject({ state: 'ok' })
  })

  it('fires and resolves nothing when the pid file cannot be read: a blind check is not a dead process', () => {
    const blind = normalizeHost(pid('unreadable', null), cfg({ pidFile: '/run/app.pid' }), ctx())
    expect(blind.firing).toEqual([])
    expect(blind.resolved.filter((a) => a.rule === HOST_RULES.process)).toEqual([])
    expect(cellOf(blind, HOST_RULES.process, '/run/app.pid')).toMatchObject({ state: 'nodata' })
  })

  it('has no process cell at all when the source names no pid file', () => {
    const none = normalizeHost(readings(), cfg(), ctx())
    expect(none.checks?.cells.some((c) => c.checkId === HOST_RULES.process)).toBe(false)
  })
})

// ---- the observation ----------------------------------------------------------------------------------------------------------------------

describe('the observation', () => {
  it('carries one asserted cell per check, so the wall knows each one can go red', () => {
    const obs = normalizeHost(readings({ process: { pidFile: '/run/app.pid', state: 'alive', pid: 1, detail: 'pid 1 is running' } }), cfg({ pidFile: '/run/app.pid', mounts: ['/'] }), ctx())
    const cells = obs.checks?.cells ?? []
    expect(cells.map((c) => [c.checkId, c.name]).sort()).toEqual([
      [HOST_RULES.disk, '/'],
      [HOST_RULES.load, 'load'],
      [HOST_RULES.memory, 'memory'],
      [HOST_RULES.process, '/run/app.pid']
    ])
    for (const c of cells) expect(assertsBeyondDefault(c.asserts), `${c.checkId} ${c.name}`).toBe(true)
    expect(obs).toMatchObject({ source: 'host', kind: 'host', at: ISO })
  })

  it('is complete when every reading was taken, so a check taken out of the config resolves', () => {
    const complete = normalizeHost(readings(), cfg(), ctx())
    expect(complete.complete).toBe(true)
    const partial = normalizeHost(readings({ disks: [{ mount: '/', ok: false, detail: 'statfs failed: EACCES' }] }), cfg(), ctx())
    expect(partial.complete).toBe(false)
  })

  it('writes no em dash in any alert it can raise', () => {
    const worst = normalizeHost(
      readings({ disks: diskAt(1), availableBytes: 0.5 * GB_BYTES, load5: 20, process: { pidFile: '/run/app.pid', state: 'dead', pid: 9, detail: 'pid 9 is not running' } }),
      cfg({ pidFile: '/run/app.pid' }),
      ctx()
    )
    expect(worst.firing).toHaveLength(4)
    for (const a of worst.firing) {
      for (const text of Object.values(a.annotations)) expect(text).not.toContain('\u2014')
      expect(a.value ?? '').not.toContain('\u2014')
    }
  })
})

// ---- the source and the engine -------------------------------------------------------------------------------------------------------------

function harness(c: HostSourceConfig) {
  const clock = { ms: T0 }
  const deps: SourceDeps = { fetch, env: {}, nowIso: () => new Date(clock.ms).toISOString(), serviceMap: [] }
  const watch: WatchConfig = {
    baseUrl: 'https://watch.test',
    port: 0,
    host: '127.0.0.1',
    dataDir: ':memory:',
    historyHours: 24,
    staleAfterMisses: 3,
    sources: [c],
    serviceMap: [],
    splitIncidents: [{ match: { origin: `^${c.id}$` }, by: 'instance' }],
    channels: [],
    routes: [],
    quietHours: null
  }
  const engine = new Engine(openDb(':memory:'), watch, () => clock.ms)
  let current: HostReadings = readings()
  const source = createHostSource(c, deps, async () => current)
  let last: Observation | null = null
  const poll = async (over: Partial<HostReadings>): Promise<Observation> => {
    current = readings(over)
    const obs = await source.poll()
    last = obs
    engine.ingest(obs)
    engine.recordSource(source.id, true, null)
    clock.ms += 60_000
    return obs
  }
  const firing = (rule: string) => engine.wall().incidents.filter((i) => i.rule === rule)
  return { clock, engine, source, poll, firing, last: () => last }
}

describe('the host source', () => {
  it('polls itself, turns a low disk into a page and resolves it when space comes back', async () => {
    const h = harness(cfg())
    expect(h.source).toMatchObject({ id: 'host', kind: 'host', name: 'Host', pollSec: 60 })
    await h.poll({ disks: diskAt(3) })
    expect(h.firing(HOST_RULES.disk)).toHaveLength(1)
    expect(h.firing(HOST_RULES.disk)[0]).toMatchObject({ severity: 'page', service: 'Host', instance: '/' })
    await h.poll({ disks: diskAt(40) })
    expect(h.firing(HOST_RULES.disk)).toHaveLength(0)
    expect(h.engine.sources()[0]).toMatchObject({ id: 'host', kind: 'host', state: 'ok', misses: 0, rules: 3 })
    // every cell asserts a predicate, so the source is proof of watch and not just of a running poll
    expect(h.engine.sources()[0].asserted).toBe(3)
  })

  it('never throws for a machine it cannot read', async () => {
    const broken: HostReader = async () => readings({ disks: [{ mount: '/', ok: false, detail: 'statfs failed: EACCES' }], load5: null, totalBytes: 0, availableBytes: 0 })
    const source = createHostSource(cfg(), { fetch, env: {}, nowIso: () => ISO, serviceMap: [] }, broken)
    await expect(source.poll()).resolves.toMatchObject({ source: 'host', kind: 'host', firing: [] })
  })
})

// ---- the real readers ----------------------------------------------------------------------------------------------------------------------

describe('reading this machine', () => {
  it('reads this process and a missing pid through the real pid reader', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'watch-host-pid-'))
    const file = join(dir, 'app.pid')
    writeFileSync(file, `${process.pid}\n`)
    const alive = await readHost(cfg({ pidFile: file, mounts: [dir] }), ISO)
    expect(alive.process).toMatchObject({ state: 'alive', pid: process.pid })
    expect(alive.cores).toBeGreaterThan(0)
    expect(alive.totalBytes).toBeGreaterThan(0)
    expect(alive.disks[0]).toMatchObject({ mount: dir, ok: true })

    const missing = await readHost(cfg({ pidFile: join(dir, 'nope.pid'), mounts: [dir] }), ISO)
    expect(missing.process).toMatchObject({ state: 'missing', pid: null })

    writeFileSync(file, 'not a pid\n')
    expect((await readHost(cfg({ pidFile: file, mounts: [dir] }), ISO)).process).toMatchObject({ state: 'unreadable', pid: null })

    writeFileSync(file, '4194303\n')
    expect((await readHost(cfg({ pidFile: file, mounts: [dir] }), ISO)).process?.state).toBe('dead')

    const nobody = await readHost(cfg({ mounts: [join(dir, 'no-such-mount')] }), ISO)
    expect(nobody.disks[0]).toMatchObject({ mount: join(dir, 'no-such-mount'), ok: false, detail: 'statfs failed: ENOENT' })
  })

  it('reads the whole machine without throwing, and says which memory number it got', async () => {
    const all = await readHost(cfg(), ISO)
    expect(all.hostname).not.toBe('')
    expect(all.memSource === 'MemAvailable' || all.memSource === 'free').toBe(true)
    expect(all.availableBytes).toBeGreaterThanOrEqual(0)
    expect(all.disks.map((d) => d.mount)).toEqual(['/'])
  })
})

// ---- the config ----------------------------------------------------------------------------------------------------------------------------

describe('the host config', () => {
  const write = (source: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), 'watch-host-cfg-'))
    const file = join(dir, 'watch.json')
    writeFileSync(file, JSON.stringify({ baseUrl: 'https://watch.test', port: 0, host: '127.0.0.1', dataDir: ':memory:', historyHours: 24, staleAfterMisses: 3, sources: [source], serviceMap: [], channels: [], routes: [], quietHours: null }))
    return file
  }

  it('takes the bare shape the CLI writes, with the brief defaults', () => {
    const loaded = loadConfig(write({ id: 'host', type: 'host' }))
    const s = loaded.sources[0] as HostSourceConfig
    expect(hostThresholdsOf(s)).toEqual({ diskFreeWarnPct: 10, diskFreePagePct: 5, memAvailableWarnPct: 10, loadPerCoreWarn: 2 })
    expect(hostMountsOf(s)).toEqual(['/'])
    expect(HOST_DEFAULTS.pollSec).toBe(60)
    const built = POLLED.host?.(s, { fetch, env: {}, nowIso: () => ISO, serviceMap: [] }, { loadNodes: [] })
    expect(built?.source).toMatchObject({ id: 'host', kind: 'host', pollSec: 60 })
    expect([...configServiceNames(loaded)]).toContain('host')
  })

  it('takes repeated mounts, a pid file and its own thresholds', () => {
    const loaded = loadConfig(write({ id: 'box', type: 'host', service: 'Build box', pollSec: 30, mounts: ['/', '/data'], pidFile: '/run/app.pid', thresholds: { diskFreeWarnPct: 15, diskFreePagePct: 7, memAvailableWarnPct: 5, loadPerCoreWarn: 3 } }))
    const s = loaded.sources[0] as HostSourceConfig
    expect(hostMountsOf(s)).toEqual(['/', '/data'])
    expect(hostThresholdsOf(s)).toEqual({ diskFreeWarnPct: 15, diskFreePagePct: 7, memAvailableWarnPct: 5, loadPerCoreWarn: 3 })
    expect([...configServiceNames(loaded)]).toContain('Build box')
    expect(normalizeHost(readings({ disks: diskAt(6) }), s, ctx()).firing.map((a) => [a.severity, a.service])).toEqual([['page', 'Build box']])
  })

  it('refuses what it cannot read, naming the field', () => {
    // the ordinary shapes are accepted
    expect(() => loadConfig(write({ id: 'host', type: 'host', mounts: ['/'] }))).not.toThrow()
    expect(hostProblems({ id: 'host', type: 'host' })).toEqual([])
    const bad: Array<[unknown, RegExp]> = [
      [{ id: 'host', type: 'host', pollSec: 0 }, /pollSec must be a number of seconds above 0/],
      [{ id: 'host', type: 'host', mounts: 'boot' }, /mounts must be a list of paths/],
      [{ id: 'host', type: 'host', mounts: [''] }, /mounts\[0\] must be a path/],
      [{ id: 'host', type: 'host', mounts: ['/', '/'] }, /mounts\[1\] \/ is listed twice/],
      [{ id: 'host', type: 'host', mounts: ['/a\nb'] }, /mounts\[0\] must be one line/],
      [{ id: 'host', type: 'host', pidFile: '' }, /pidFile must be a path/],
      [{ id: 'host', type: 'host', service: '' }, /service must name the wall tile/],
      [{ id: 'host', type: 'host', thresholds: { diskFreeWarnPct: 5, diskFreePagePct: 10 } }, /diskFreePagePct must be under diskFreeWarnPct/],
      [{ id: 'host', type: 'host', thresholds: { diskFreeWarnPct: 0 } }, /diskFreeWarnPct must be above 0/],
      [{ id: 'host', type: 'host', thresholds: { memAvailableWarnPct: 101 } }, /memAvailableWarnPct must be a number from 0 to 100/],
      [{ id: 'host', type: 'host', thresholds: { loadPerCoreWarn: -1 } }, /loadPerCoreWarn must be a number from 0 to 1000/],
      [{ id: 'host', type: 'host', thresholds: 'tight' }, /thresholds must be an object/]
    ]
    for (const [source, message] of bad) expect(() => loadConfig(write(source)), JSON.stringify(source)).toThrow(message)
  })

  it('loads the fixture config and its host source', () => {
    const fixture = loadConfig(fileURLToPath(new URL('../fixtures/watch.config.json', import.meta.url)))
    const s = fixture.sources.find((x) => x.type === 'host') as HostSourceConfig
    expect(s).toMatchObject({ id: 'host', pollSec: 60, mounts: ['/', '/data'], pidFile: '/run/example-app.pid' })
    expect(hostThresholdsOf(s)).toEqual({ diskFreeWarnPct: 10, diskFreePagePct: 5, memAvailableWarnPct: 10, loadPerCoreWarn: 2 })
  })
})

describe('the numbers in words', () => {
  it('gives one decimal and never a long float', () => {
    expect(pctText(1, 3)).toBe('33.3')
    expect(pctText(0, 100)).toBe('0.0')
    expect(pctText(1, 0)).toBe('0')
  })

  it('names every assertion the source makes', () => {
    expect(HOST_ASSERTS.diskFree('/', 5)).toBe('disk:/ free>5%')
    expect(HOST_ASSERTS.memAvailable(10)).toBe('mem:available>10%')
    expect(HOST_ASSERTS.loadPerCore(2)).toBe('load:5m/core<2')
    expect(HOST_ASSERTS.process('/run/app.pid')).toBe('pid:/run/app.pid running')
  })
})

describe('proveHost: a reading past each threshold fires that rule', () => {
  it('fires the disk, memory and load rules on one synthetic reading', () => {
    const out = proveHost(cfg(), ISO)
    expect(out.red).toBe(true)
    expect(out.runs.map((run) => run.ok)).toEqual([false, false, false])
    expect(out.runs[0].mutation).toContain('disk / at 0% free')
    expect(out.runs[1].mutation).toContain('memory available at 0%')
    expect(out.runs[2].mutation).toContain('load5')
  })

  it('adds the process check only when a pid file is configured, and leaves out a switched-off memory threshold', () => {
    const withProcess = proveHost(cfg({ pidFile: '/run/app.pid' }), ISO)
    expect(withProcess.runs).toHaveLength(4)
    expect(withProcess.runs[3].mutation).toContain('/run/app.pid')
    const noMemory = proveHost(cfg({ thresholds: { memAvailableWarnPct: 0 } }), ISO)
    expect(noMemory.red).toBe(true)
    expect(noMemory.runs.some((run) => run.mutation.startsWith('memory'))).toBe(false)
  })
})
