// host source: the machine the Watcher runs on, read with nothing installed. Netdata is the richer add-on (every context it collects, its own
// evaluated alerts, the fleet view); this is the floor under it, for a laptop, a fresh VPS or a box nobody put an agent on: load average per core,
// memory available, free space per configured mount, and optionally one process's pid file. node:os and fs.statfs are all it touches: no network,
// no credential, no agent, so a project can be watched before anything else exists.
//
// The meanings are chosen to be honest rather than convenient:
//   - memory is AVAILABLE, not free. On Linux the reading is /proc/meminfo's MemAvailable (what the kernel believes it can hand out, page cache
//     included), because os.freemem() there is free memory only and would warn on every box holding a warm cache. Everywhere else it is
//     os.freemem(), the platform's own best answer, and the cell says which one it read.
//   - load is load5 per core, and the kernel's own five-minute average is the "for 5m" the brief asks for: a poll reads one number that already
//     averages the window, so a build that peaks for a minute never fires it. A platform that reports no load average (Windows) leaves the cell
//     with no data instead of a green one.
//   - a disk's free percent is bavail/blocks, the space an unprivileged user can write to, not bfree (which counts the root reserve).
//
// A reading that cannot be taken fires and resolves nothing (a failed statfs is not evidence a disk is full), so the cell reads "no data" with the
// reason and the wall shows the blind spot. A poll that read everything is complete, so a check taken out of the config resolves; one with a blind
// reading is not, and a mount this poll could not read keeps whatever alert it had. Thresholds are the source's own, with the brief's defaults (disk
// warn under 10 % free and page under 5, memory available under 10 % a warning, load over 2 per core a warning), and every cell carries the predicate
// it proves as RuleCell.asserts (`disk:/ free>5%`), so the wall can tell a host check from one that only proves the poll ran.

import { readFile, statfs } from 'node:fs/promises'
import { cpus, freemem, hostname as osHostname, loadavg, totalmem } from 'node:os'
import { createHash } from 'node:crypto'
import type { Alert, ChecksPush, Observation, Severity } from '../../shared/types.ts'
import { makeAlert } from '../derive.ts'
import { parseChecks } from './checks.ts'
import type { PolledSource, SourceDeps } from './types.ts'
import { clip, markResolved } from './shared.ts'

export const HOST_DEFAULTS = {
  pollSec: 60,
  /** Under this free percent a disk is the warning. */
  diskFreeWarnPct: 10,
  /** Under this free percent it pages. */
  diskFreePagePct: 5,
  /** Under this percent available memory is a warning. */
  memAvailableWarnPct: 10,
  /** Load5 above this many per core is a warning. */
  loadPerCoreWarn: 2
} as const

/** The alert classes: what can be wrong with the machine. */
export const HOST_RULES = {
  disk: 'HostDiskFree',
  memory: 'HostMemoryFree',
  load: 'HostLoadHigh',
  process: 'HostProcessDown'
} as const

/** What each cell proves beyond "the poll ran" (RuleCell.asserts): the predicate a red cell falsifies. */
export const HOST_ASSERTS = {
  /** The mount has more than the page threshold of percent free. */
  diskFree: (mount: string, pagePct: number): string => `disk:${mount} free>${pagePct}%`,
  /** Memory available is over the warning threshold of percent. */
  memAvailable: (warnPct: number): string => `mem:available>${warnPct}%`,
  /** Load5 per core is under the warning threshold. */
  loadPerCore: (warn: number): string => `load:5m/core<${warn}`,
  /** The pid in the file names a running process. */
  process: (pidFile: string): string => `pid:${pidFile} running`
} as const

/** The GB figure in a detail line: one decimal, no unit suffix (the line says "of 64.0 GB"). */
export const GB = 1024 ** 3

/** The four numbers a reading is judged by, each optional in the config and filled from HOST_DEFAULTS. */
export interface HostThresholdConfig {
  /** Under this free percent a disk is the warning. Default 10. */
  diskFreeWarnPct?: number
  /** Under this free percent it pages. Default 5; 0 never pages. */
  diskFreePagePct?: number
  /** Under this percent available memory is the warning. Default 10; 0 never warns. */
  memAvailableWarnPct?: number
  /** Load5 above this many per core is the warning. Default 2. */
  loadPerCoreWarn?: number
}

/**
 * One machine: the one this process runs on, read with node:os and fs.statfs. The field names are the brief's: `mounts`, `pidFile`, `thresholds`.
 * The discriminator is `type`, as it is for every other source in src/server/config.ts, so a host entry in the config file is
 * `{ "type": "host", ... }`. Every field but id and type is optional: `watcher add host --id host` writes exactly that, and the defaults are the
 * brief's (root filesystem, 60 s, disk 10/5 percent, memory 10 percent available, load 2 per core).
 */
export interface HostSourceConfig {
  id: string
  type: 'host'
  /** Seconds between polls. Default 60. */
  pollSec?: number
  /** The wall tile its alerts and cells land on. Default the source id. */
  service?: string
  /** The filesystems to watch, by mount point. Default ["/"]. */
  mounts?: string[]
  /** A process to keep alive, by the file it writes its pid into. Absent: no process check. */
  pidFile?: string
  thresholds?: HostThresholdConfig
}

// ---- the thresholds -----------------------------------------------------------------------------------

/** The source's four numbers with the defaults filled: what every reading is judged by. */
export interface HostThresholds {
  diskFreeWarnPct: number
  diskFreePagePct: number
  memAvailableWarnPct: number
  loadPerCoreWarn: number
}

export function hostThresholdsOf(cfg: HostSourceConfig): HostThresholds {
  const t = cfg.thresholds ?? {}
  return {
    diskFreeWarnPct: t.diskFreeWarnPct ?? HOST_DEFAULTS.diskFreeWarnPct,
    diskFreePagePct: t.diskFreePagePct ?? HOST_DEFAULTS.diskFreePagePct,
    memAvailableWarnPct: t.memAvailableWarnPct ?? HOST_DEFAULTS.memAvailableWarnPct,
    loadPerCoreWarn: t.loadPerCoreWarn ?? HOST_DEFAULTS.loadPerCoreWarn
  }
}

/** The mounts the source reads: the configured ones, else the root of the filesystem it runs on. */
export function hostMountsOf(cfg: HostSourceConfig): string[] {
  const mounts = (cfg.mounts ?? []).filter((m) => typeof m === 'string' && m.trim() !== '')
  return mounts.length > 0 ? mounts : ['/']
}

// ---- one reading --------------------------------------------------------------------------------------

/** One mount this poll: its figures, or why they could not be read. */
export type HostDiskReading =
  | { mount: string; ok: true; totalBytes: number; freeBytes: number }
  | { mount: string; ok: false; detail: string }

/** One pid file this poll. `missing` is a dead process whose file is already gone, which is the common case after a crash. */
export type HostProcessReading = { pidFile: string; state: 'alive' | 'dead' | 'missing' | 'unreadable'; pid: number | null; detail: string }

/** Everything one poll read: the machine, as the readers below found it. Never contains a secret, and never a path outside the configured mounts. */
export interface HostReadings {
  at: string
  /** The machine's own name, for the words of an alert ("on build-1"). */
  hostname: string
  /** Core count, the denominator of load5 per core. 0 when the platform reports none. */
  cores: number
  /** The kernel's five-minute load average. null when this platform reports none (Windows: always 1, 5 and 15 minutes of zero). */
  load5: number | null
  totalBytes: number
  availableBytes: number
  /** Which reading available memory came from: Linux's MemAvailable, else the platform's free memory. Shown on the cell. */
  memSource: 'MemAvailable' | 'free'
  disks: HostDiskReading[]
  /** The one configured pid file, when the source names one. */
  process: HostProcessReading | null
}

/** The seam: a test hands `createHostSource` its own readings instead of the machine it happens to run on. */
export type HostReader = (cfg: HostSourceConfig, nowIso: string) => Promise<HostReadings>

/** "3.2" for 3.24, "0" for 0: one decimal, never a long float on the wall. */
export function pctText(part: number, whole: number): string {
  if (!(whole > 0)) return '0'
  return (Math.round((part / whole) * 1000) / 10).toFixed(1)
}

/** Bytes in GB with one decimal, for a detail line. */
export const gbText = (bytes: number): string => (bytes / GB).toFixed(1)

/** Read /proc/meminfo's MemAvailable and MemTotal, in bytes. null when the file is not there (macOS) or does not carry both. */
async function readProcMeminfo(): Promise<{ total: number; available: number } | null> {
  let text: string
  try {
    text = await readFile('/proc/meminfo', 'utf8')
  } catch {
    return null
  }
  const kb = (name: string): number | null => {
    const m = new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, 'm').exec(text)
    return m ? Number(m[1]) * 1024 : null
  }
  const total = kb('MemTotal')
  const available = kb('MemAvailable')
  return total !== null && available !== null ? { total, available } : null
}

/** One mount's free space, from fs.statfs: total and what an unprivileged user can still write. */
async function readDisk(mount: string): Promise<HostDiskReading> {
  try {
    const st = await statfs(mount)
    const totalBytes = Number(st.blocks) * Number(st.bsize)
    const freeBytes = Number(st.bavail) * Number(st.bsize)
    if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes) || totalBytes <= 0) return { mount, ok: false, detail: 'the filesystem reported no size' }
    return { mount, ok: true, totalBytes, freeBytes: Math.max(0, freeBytes) }
  } catch (err) {
    // The code only (ENOENT, EACCES), never the error's message, which can name a path outside the config's own mounts.
    const code = (err as NodeJS.ErrnoException).code
    return { mount, ok: false, detail: typeof code === 'string' && /^[A-Z0-9_]{2,64}$/.test(code) ? `statfs failed: ${code}` : 'statfs failed' }
  }
}

/** One pid file: the number in it, and whether a process by that number answers. never throws. */
async function readProcess(pidFile: string): Promise<HostProcessReading> {
  let text: string
  try {
    text = await readFile(pidFile, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { pidFile, state: 'missing', pid: null, detail: `no pid file at ${pidFile}` }
    return { pidFile, state: 'unreadable', pid: null, detail: `pid file could not be read${typeof code === 'string' && /^[A-Z0-9_]{2,64}$/.test(code) ? `: ${code}` : ''}` }
  }
  const pid = Number(text.trim().split(/\s+/)[0])
  if (!Number.isInteger(pid) || pid <= 0) return { pidFile, state: 'unreadable', pid: null, detail: 'the pid file holds no process id' }
  try {
    // Signal 0 checks existence and permission without sending anything. EPERM means the process is there and not ours: alive.
    process.kill(pid, 0)
    return { pidFile, state: 'alive', pid, detail: `pid ${pid} is running` }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return { pidFile, state: 'dead', pid, detail: `pid ${pid} is not running` }
    if (code === 'EPERM') return { pidFile, state: 'alive', pid, detail: `pid ${pid} is running (owned by another user)` }
    return { pidFile, state: 'unreadable', pid, detail: `pid ${pid} could not be checked${typeof code === 'string' && /^[A-Z0-9_]{2,64}$/.test(code) ? `: ${code}` : ''}` }
  }
}

/** The real readers: this machine, this instant. Bounded to the configured mounts and the one pid file, and it never throws. */
export async function readHost(cfg: HostSourceConfig, nowIso: string): Promise<HostReadings> {
  const meminfo = await readProcMeminfo()
  const totalBytes = meminfo?.total ?? totalmem()
  const availableBytes = meminfo?.available ?? freemem()
  const cores = cpus().length
  const avg = loadavg()
  const measured = typeof avg[1] === 'number' && avg[1] >= 0 && process.platform !== 'win32'
  const disks = await Promise.all(hostMountsOf(cfg).map((mount) => readDisk(mount)))
  return {
    at: nowIso,
    hostname: safeHostname(),
    cores,
    load5: measured ? avg[1] : null,
    totalBytes,
    availableBytes,
    memSource: meminfo ? 'MemAvailable' : 'free',
    disks,
    process: typeof cfg.pidFile === 'string' && cfg.pidFile.trim() !== '' ? await readProcess(cfg.pidFile) : null
  }
}

/** The machine's name, or "this host" when the platform will not give one: the alert must read even then. */
function safeHostname(): string {
  try {
    const name = osHostname()
    return name && name.trim() !== '' ? name.trim() : 'this host'
  } catch {
    return 'this host'
  }
}

// ---- the poll's arithmetic ----------------------------------------------------------------------------

export interface HostContext {
  nowIso: string
  serviceMap: SourceDeps['serviceMap']
}

const sha = (...parts: string[]): string => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16)

/** The predicate a cell proves, attached to the cell after parseChecks (and repeated in the list entry, for a parseChecks that keeps it). */
function assertedCells(checks: ChecksPush, byRuleAndName: ReadonlyMap<string, string[]>): void {
  for (const cell of checks.cells) {
    const asserts = byRuleAndName.get(`${cell.checkId ?? ''}\u0000${cell.name}`)
    if (asserts) cell.asserts = asserts
  }
}

/**
 * One poll's readings as the Observation. Pure: no clock of its own, no machine, no network. Each check fires its one alert class and resolves the
 * other disk tier, and a reading that could not be taken fires and resolves nothing (its cell reads "no data" with the reason). A reading inside
 * its threshold resolves what it might have fired, so recovery is the source's own word and a restart loses nothing.
 */
export function normalizeHost(readings: HostReadings, cfg: HostSourceConfig, ctx: HostContext): Observation {
  const pollSec = cfg.pollSec ?? HOST_DEFAULTS.pollSec
  const t = hostThresholdsOf(cfg)
  const service = cfg.service ?? cfg.id
  const there = readings.hostname
  const firing: Alert[] = []
  const resolved: Alert[] = []
  const list: Array<Record<string, unknown>> = []
  const asserted = new Map<string, string[]>()

  const build = (rule: string, severity: Extract<Severity, 'page' | 'warning'>, instance: string, words: { summary: string; description: string; value: string }, raw: unknown, tier = ''): Alert =>
    makeAlert(
      {
        origin: cfg.id,
        fingerprint: sha('host', cfg.id, rule, instance, tier),
        rule,
        labels: { alertname: rule, severity, service, instance, host: there },
        annotations: { summary: clip(words.summary, 220), description: words.description, ...(severity === 'page' ? { page_reason: clip(words.summary, 220) } : {}) },
        startsAt: ctx.nowIso,
        value: clip(words.value, 120),
        via: { source: cfg.id, kind: 'host', lastSeen: ctx.nowIso },
        raw
      },
      ctx.serviceMap,
      ctx.nowIso
    )
  const cell = (rule: string, instance: string, state: 'ok' | 'pending' | 'failing' | 'skipped', detail: string, asserts: string[]): void => {
    list.push({ id: rule, instance, service, state, ...(state === 'skipped' ? {} : { lastRunAt: ctx.nowIso }), detail: clip(detail, 230), asserts })
    asserted.set(`${rule}\u0000${instance}`, asserts)
  }

  // ---- disks
  for (const disk of readings.disks) {
    const assert = [HOST_ASSERTS.diskFree(disk.mount, t.diskFreePagePct)]
    const diskAlert = (tier: Extract<Severity, 'page' | 'warning'>): Alert =>
      build(
        HOST_RULES.disk,
        tier,
        disk.mount,
        {
          summary: `${disk.mount} on ${there} has ${disk.ok ? `${pctText(disk.freeBytes, disk.totalBytes)}% free` : 'no free-space reading'}`,
          description:
            `Watch reads the free space of ${disk.mount} every ${pollSec} s with statfs. Under ${t.diskFreeWarnPct}% free is a warning and under ` +
            `${t.diskFreePagePct}% a page; a reading near either line says nothing about the disk's health beyond this instant.`,
          value: disk.ok ? `${pctText(disk.freeBytes, disk.totalBytes)}% free` : 'unreadable'
        },
        disk.ok
          ? { mount: disk.mount, freePct: Number(pctText(disk.freeBytes, disk.totalBytes)), freeBytes: disk.freeBytes, totalBytes: disk.totalBytes }
          : { mount: disk.mount, error: disk.detail },
        // The tier is part of the identity: a disk dropping from the warning to the page must replace one alert with the other, not rename the same one.
        tier
      )
    if (!disk.ok) {
      // A read that failed is not evidence of a full disk: no alert, no resolve, and the cell says why it is blind.
      cell(HOST_RULES.disk, disk.mount, 'skipped', disk.detail, assert)
      continue
    }
    const freePct = (disk.freeBytes / disk.totalBytes) * 100
    const figures = `${gbText(disk.freeBytes)} GB of ${gbText(disk.totalBytes)} GB`
    if (freePct < t.diskFreePagePct) {
      firing.push(diskAlert('page'))
      resolved.push(markResolved(diskAlert('warning'), ctx.nowIso))
      cell(HOST_RULES.disk, disk.mount, 'failing', `${pctText(disk.freeBytes, disk.totalBytes)}% free (${figures}), under ${t.diskFreePagePct}%`, assert)
    } else if (freePct < t.diskFreeWarnPct) {
      firing.push(diskAlert('warning'))
      resolved.push(markResolved(diskAlert('page'), ctx.nowIso))
      cell(HOST_RULES.disk, disk.mount, 'failing', `${pctText(disk.freeBytes, disk.totalBytes)}% free (${figures}), under ${t.diskFreeWarnPct}%`, assert)
    } else {
      resolved.push(markResolved(diskAlert('page'), ctx.nowIso), markResolved(diskAlert('warning'), ctx.nowIso))
      cell(HOST_RULES.disk, disk.mount, 'ok', `${pctText(disk.freeBytes, disk.totalBytes)}% free (${figures})`, assert)
    }
  }

  // ---- memory
  {
    const assert = [HOST_ASSERTS.memAvailable(t.memAvailableWarnPct)]
    const instance = 'memory'
    const availablePct = readings.totalBytes > 0 ? (readings.availableBytes / readings.totalBytes) * 100 : 0
    const figures = `${gbText(readings.availableBytes)} GB of ${gbText(readings.totalBytes)} GB`
    const memoryAlert = (): Alert =>
      build(
        HOST_RULES.memory,
        'warning',
        instance,
        {
          summary: `Memory available on ${there} is ${pctText(readings.availableBytes, readings.totalBytes)}%`,
          description:
            `Watch reads ${readings.memSource === 'MemAvailable' ? 'MemAvailable from /proc/meminfo' : 'the free memory the platform reports'} every ${pollSec} s. ` +
            `Under ${t.memAvailableWarnPct}% available is this warning: the kernel is close to reclaiming or killing processes for memory.`,
          value: `${pctText(readings.availableBytes, readings.totalBytes)}% available (${figures})`
        },
        { availableBytes: readings.availableBytes, totalBytes: readings.totalBytes, memSource: readings.memSource }
      )
    if (readings.totalBytes <= 0) {
      cell(HOST_RULES.memory, instance, 'skipped', 'the platform reported no total memory', assert)
    } else if (availablePct < t.memAvailableWarnPct) {
      firing.push(memoryAlert())
      cell(HOST_RULES.memory, instance, 'failing', `${pctText(readings.availableBytes, readings.totalBytes)}% available (${figures}), under ${t.memAvailableWarnPct}%`, assert)
    } else {
      resolved.push(markResolved(memoryAlert(), ctx.nowIso))
      cell(HOST_RULES.memory, instance, 'ok', `${pctText(readings.availableBytes, readings.totalBytes)}% available (${figures}, ${readings.memSource})`, assert)
    }
  }

  // ---- load
  {
    const assert = [HOST_ASSERTS.loadPerCore(t.loadPerCoreWarn)]
    const instance = 'load'
    const load5 = readings.load5
    const cores = readings.cores
    if (load5 === null || cores <= 0) {
      cell(HOST_RULES.load, instance, 'skipped', 'this platform reports no load average', assert)
    } else {
      const perCore = load5 / cores
      const shown = `${load5.toFixed(2)} load5 on ${cores} core${cores === 1 ? '' : 's'} (${perCore.toFixed(2)} per core)`
      const loadAlert = (): Alert =>
        build(
          HOST_RULES.load,
          'warning',
          instance,
          {
            summary: `Load on ${there} is ${load5.toFixed(2)} (${perCore.toFixed(2)} per core)`,
            description:
              `Watch reads the kernel's five-minute load average every ${pollSec} s, so the number is already a five-minute reading. Above ` +
              `${t.loadPerCoreWarn} per core on ${cores} core${cores === 1 ? '' : 's'} is this warning: work is queueing faster than the machine retires it.`,
            value: shown
          },
          { load5, cores, perCore: Number(perCore.toFixed(2)) }
        )
      if (perCore > t.loadPerCoreWarn) {
        firing.push(loadAlert())
        cell(HOST_RULES.load, instance, 'failing', `${shown}, over ${t.loadPerCoreWarn} per core`, assert)
      } else {
        resolved.push(markResolved(loadAlert(), ctx.nowIso))
        cell(HOST_RULES.load, instance, 'ok', shown, assert)
      }
    }
  }

  // ---- the optional process
  const proc = readings.process
  if (proc) {
    const assert = [HOST_ASSERTS.process(proc.pidFile)]
    const instance = proc.pidFile
    const processAlert = (): Alert =>
      build(
        HOST_RULES.process,
        'page',
        instance,
        {
          summary: `The process in ${proc.pidFile} is not running on ${there}`,
          description:
            `Watch reads the pid in ${proc.pidFile} every ${pollSec} s and asks the kernel whether it is still there. A pid file that is gone or names no ` +
            'running process is this page; a process is expected to write its pid on start and remove the file on exit.',
          value: proc.detail
        },
        { pidFile: proc.pidFile, state: proc.state, pid: proc.pid }
      )
    if (proc.state === 'alive') {
      resolved.push(markResolved(processAlert(), ctx.nowIso))
      cell(HOST_RULES.process, instance, 'ok', proc.detail, assert)
    } else if (proc.state === 'unreadable') {
      // A file that cannot be read is not proof the process died: leave the alert as it was and say the check is blind.
      cell(HOST_RULES.process, instance, 'skipped', proc.detail, assert)
    } else {
      firing.push(processAlert())
      cell(HOST_RULES.process, instance, 'failing', proc.detail, assert)
    }
  }

  let checks: ChecksPush | undefined
  if (list.length > 0) {
    checks = parseChecks({ staleAfterSec: Math.max(300, pollSec * 4), complete: true, list }, { origin: cfg.id, source: cfg.id, now: ctx.nowIso })
    assertedCells(checks, asserted)
  }
  // Complete only when every reading was taken: then the firing list IS this machine's whole state, so a mount or a pid file taken out of the config
  // resolves instead of firing for good. One blind reading (a statfs that failed) makes the poll partial, and a partial poll resolves nothing.
  const blind =
    readings.disks.some((d) => !d.ok) ||
    readings.totalBytes <= 0 ||
    readings.load5 === null ||
    readings.cores <= 0 ||
    (proc !== null && proc.state === 'unreadable')
  return { source: cfg.id, kind: 'host', at: ctx.nowIso, firing, resolved, complete: !blind, ...(checks ? { checks } : {}) }
}

// ---- the proof ----------------------------------------------------------------------------------------

/** One mutation of a host reading, and what the evaluator made of it (http-probe.ts's ProveRun, repeated here so this source needs no prober). */
export interface HostProveRun {
  /** What was changed, in words ("disk / at 0% free"). */
  mutation: string
  /** True when the mutated reading stayed green, which is what a proof must not do. */
  ok: boolean
  /** The rules the mutation should have reddened. */
  failed: string[]
}

export interface HostProveOutcome {
  /** True when every check this source configures was shown to fire on a reading past its threshold. */
  red: boolean
  runs: HostProveRun[]
}

/**
 * Prove each host check by mutating a synthetic reading past its own threshold and running the same
 * `normalizeHost` the poll runs: a disk at 0% free, memory at 0% available, load above its per-core
 * warning, and a configured pid file whose process is dead. A check whose threshold is switched off
 * (`0`) makes no assertion and is left out; a source with no active check proves nothing (red false).
 * Pure: no clock of its own, no machine, no network.
 */
export function proveHost(cfg: HostSourceConfig, nowIso: string): HostProveOutcome {
  const t = hostThresholdsOf(cfg)
  const totalBytes = 100 * GB
  const mounts = hostMountsOf(cfg)
  const disks: HostDiskReading[] = mounts.map((mount) => ({ mount, ok: true, totalBytes, freeBytes: 0 }))
  const cores = 4
  // Above the per-core warning whatever it is set to (0 included): a load of zero would prove nothing.
  const load5 = Math.max(t.loadPerCoreWarn + 0.5, 0.5) * cores
  const readings: HostReadings = {
    at: nowIso,
    hostname: 'this host',
    cores,
    load5,
    totalBytes,
    availableBytes: 0,
    memSource: 'free',
    disks,
    process:
      typeof cfg.pidFile === 'string' && cfg.pidFile.trim() !== ''
        ? { pidFile: cfg.pidFile, state: 'dead', pid: 12345, detail: 'pid 12345 is not running' }
        : null
  }
  const obs = normalizeHost(readings, cfg, { nowIso, serviceMap: [] })
  const runs: HostProveRun[] = []
  const check = (rule: string, instance: string | null, mutation: string): void => {
    const fired = obs.firing.some((a) => a.rule === rule && (instance === null || a.labels.instance === instance))
    runs.push({ mutation, ok: !fired, failed: fired ? [] : [rule] })
  }
  for (const mount of mounts) check(HOST_RULES.disk, mount, `disk ${mount} at 0% free (under ${t.diskFreePagePct}% page, ${t.diskFreeWarnPct}% warning)`)
  if (t.memAvailableWarnPct > 0) check(HOST_RULES.memory, 'memory', `memory available at 0% (under ${t.memAvailableWarnPct}%)`)
  check(HOST_RULES.load, 'load', `load5 ${load5.toFixed(2)} on ${cores} cores (over ${t.loadPerCoreWarn} per core)`)
  if (readings.process) check(HOST_RULES.process, readings.process.pidFile, `the pid in ${readings.process.pidFile} is not running`)
  return { red: runs.length > 0 && runs.every((run) => !run.ok), runs }
}

// ---- the source ---------------------------------------------------------------------------------------

/**
 * The source. `read` is the seam: the real one reads this machine, and a test hands its own readings instead. The poll itself never throws: a
 * mount or pid file that cannot be read is that check's "no data" cell, never a missed poll of the source.
 */
export function createHostSource(cfg: HostSourceConfig, deps: SourceDeps, read: HostReader = readHost): PolledSource {
  async function poll(): Promise<Observation> {
    const nowIso = deps.nowIso()
    const readings = await read(cfg, nowIso)
    return normalizeHost(readings, cfg, { nowIso, serviceMap: deps.serviceMap })
  }

  return { id: cfg.id, kind: 'host', name: 'Host', pollSec: cfg.pollSec ?? HOST_DEFAULTS.pollSec, poll }
}

// ---- config -------------------------------------------------------------------------------------------

const MAX_PATH = 500
const MAX_MOUNTS = 20

/** A configured path: one line, no control characters, at most `max` characters. Problems name the field, never the value. */
function pathProblem(v: unknown, max: number, what: string): string | null {
  if (typeof v !== 'string' || v.trim() === '') return `${what} must be a path`
  if (v.length > max) return `${what} must be at most ${max} characters`
  if (/[\u0000-\u001f\u007f]/.test(v)) return `${what} must be one line`
  return null
}

/**
 * Every problem with one host entry, as sentences that name the field. src/server/config.ts's `checkHost` is one call:
 * `const p = hostProblems(s); if (p.length) throw new Error(`config: source ${s.id}: ${p[0]}`)`.
 */
export function hostProblems(raw: unknown): string[] {
  const problems: string[] = []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return ['a host source must be an object with id and type']
  const cfg = raw as Record<string, unknown>
  if (cfg.type !== 'host') problems.push('type must be "host"')
  if (typeof cfg.id !== 'string' || cfg.id.trim() === '') problems.push('id must name the source: it is the alert identity and cannot be empty')
  if (cfg.pollSec !== undefined && !(typeof cfg.pollSec === 'number' && Number.isFinite(cfg.pollSec) && cfg.pollSec > 0)) problems.push('pollSec must be a number of seconds above 0')
  if (cfg.service !== undefined && (typeof cfg.service !== 'string' || cfg.service.trim() === '')) problems.push('service must name the wall tile its alerts land on')
  if (cfg.mounts !== undefined) {
    if (!Array.isArray(cfg.mounts)) problems.push('mounts must be a list of paths')
    else {
      if (cfg.mounts.length > MAX_MOUNTS) problems.push(`mounts holds more than ${MAX_MOUNTS} paths`)
      const seen = new Set<string>()
      for (const [i, m] of cfg.mounts.entries()) {
        const p = pathProblem(m, MAX_PATH, `mounts[${i}]`)
        if (p) problems.push(p)
        else if (seen.has(m)) problems.push(`mounts[${i}] ${m} is listed twice`)
        else seen.add(m)
      }
    }
  }
  if (cfg.pidFile !== undefined) {
    const p = pathProblem(cfg.pidFile, MAX_PATH, 'pidFile')
    if (p) problems.push(p)
  }
  const t = cfg.thresholds
  if (t !== undefined) {
    if (typeof t !== 'object' || t === null || Array.isArray(t)) problems.push('thresholds must be an object of percent and load numbers')
    else {
      const th = t as Record<string, unknown>
      // Every number is a percent or a load, so each is bounded; 0 is allowed only where it means "off" (a page tier that never fires).
      const num = (name: string, v: unknown, lo: number, hi: number): number | null => {
        if (v === undefined) return null
        if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) {
          problems.push(`thresholds.${name} must be a number from ${lo} to ${hi}`)
          return null
        }
        return v
      }
      const warn = num('diskFreeWarnPct', th.diskFreeWarnPct, 0, 100)
      const page = num('diskFreePagePct', th.diskFreePagePct, 0, 100)
      if (warn === 0) problems.push('thresholds.diskFreeWarnPct must be above 0, or a disk could never warn')
      num('memAvailableWarnPct', th.memAvailableWarnPct, 0, 100)
      num('loadPerCoreWarn', th.loadPerCoreWarn, 0, 1000)
      const effectiveWarn = warn ?? HOST_DEFAULTS.diskFreeWarnPct
      const effectivePage = page ?? HOST_DEFAULTS.diskFreePagePct
      if (effectivePage >= effectiveWarn) problems.push('thresholds.diskFreePagePct must be under diskFreeWarnPct, or a disk reads two tiers at once')
    }
  }
  return problems
}
