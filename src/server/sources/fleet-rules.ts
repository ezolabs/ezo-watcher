// The fleet-load rules, as pure functions over a node's one-minute series: no network, no clock, no state of their own.
//
//   HostCpuHot     CPU busy percent, AVERAGED over `forMin` minutes, above `warnAbove`  -> warning.
//   HostMemoryHot  memory in use percent, held above `warnAbove` for `forMin` minutes (every minute of it) -> warning; held above `pageAbove` -> page.
//   HostLoadHigh   load5 per core, held above `warnAbove` for `forMin` minutes -> warning.
// Every rule CLEARS the same way: once every minute of the last `forMin` is under its `clearBelow` ("clears below 70% for 10 min").
//
// "Averaged" reads the window's mean (CPU is bursty: one busy minute must not fire it), "held" needs every minute of the window (memory and load
// average move slowly: a node is only hot when it stays hot). The gap between `warnAbove` and `clearBelow`, and the full quiet window the clear needs,
// are the hysteresis: a batch job that ends does not close the incident a minute after the 10-minute average drops, and a reading that sits on the
// line does not open and close it every poll (a 10-minute mean falls by ten points a minute once a 99 % burst ends, so a mean-based clear flapped).
//
// The state machine runs over the whole window the poll holds (60 minutes), not just its end, starting from the state the previous poll ended in. So a
// restart that forgets the state replays the hour and lands on the same answer for every node that crossed a threshold in it. Config: `rules` of the
// netdata-fleet source (src/server/config.ts).

import type { NetdataFleetRulesConfig } from '../config.ts'
import type { FleetHeat, FleetRuleId, FleetThresholds } from '../../shared/fleet.ts'

/** The wall tile the fleet rules land on, and the tile Netdata's own CPU and RAM alerts join on a fleet node (classifyNetdataAlert). */
export const FLEET_LOAD_SERVICE = 'Fleet load'

export type Reducer = 'average' | 'sustained'

export interface Threshold {
  warnAbove: number
  clearBelow: number
  forMin: number
  over: Reducer
}

export interface FleetRules {
  cpu: Threshold
  memoryWarn: Threshold
  memoryPage: Threshold
  load: Threshold
  /** Under this 10-minute CPU average (and not warm or hot) a node reads `cold`. */
  coldCpuBelow: number
}

/**
 * The defaults, and the reason for each number (skills/ezo-watcher/references/netdata.md "Fleet load" repeats them):
 *  - CPU 80 % averaged over 10 min, clear after 10 min under 70 %: Netdata's own `10min_cpu_usage` warns at 85 % and clears at 75 %. Ours trips 5 points
 *    earlier, so the wall says a box is running hot before Netdata does, and it clears only after ten quiet minutes (a batch job that ends does not
 *    open and close an incident in two minutes: over 6 h of node4 on 2026-10-15 a clear on the mean made four incidents where this makes two).
 *  - Memory 85 % warning, 95 % page, each for 10 min, clear 5 points lower: memory here is `100 - available / total`, the figure that decides whether the
 *    kernel starts reclaiming and killing. No fleet node passed 47 % in the six hours before this was written, so 85 % held ten minutes is a real squeeze and 95 % held ten
 *    minutes is the edge of OOM kills (Netdata's own ram_in_use warns at 90 % and is critical at 98 %). Memory moves slowly, so a 5-point band is enough.
 *  - Load 1.5 per core (load5 / cores) for 15 min, clear under 1.2: a load of 1.0 per core is a full box, 1.5 means work is queueing; 15 minutes keeps a
 *    build or a backup from opening an incident. A 20 % band because load5 is noisier than memory. It only ever warns.
 *  - Cold under 10 % CPU: the fleet view's "who is idle", not an alert.
 */
export const DEFAULT_FLEET_RULES: FleetRules = {
  cpu: { warnAbove: 80, clearBelow: 70, forMin: 10, over: 'average' },
  memoryWarn: { warnAbove: 85, clearBelow: 80, forMin: 10, over: 'sustained' },
  memoryPage: { warnAbove: 95, clearBelow: 90, forMin: 10, over: 'sustained' },
  load: { warnAbove: 1.5, clearBelow: 1.2, forMin: 15, over: 'sustained' },
  coldCpuBelow: 10
}

/** The rules a source config describes: its numbers over the defaults. */
export function fleetRulesOf(cfg?: NetdataFleetRulesConfig): FleetRules {
  const d = DEFAULT_FLEET_RULES
  const m = cfg?.memory
  return {
    cpu: cfg?.cpu ? { ...d.cpu, ...cfg.cpu } : d.cpu,
    memoryWarn: m ? { ...d.memoryWarn, warnAbove: m.warnAbove, clearBelow: m.clearBelow, forMin: m.forMin } : d.memoryWarn,
    memoryPage: m ? { ...d.memoryPage, warnAbove: m.pageAbove, clearBelow: m.pageClearBelow, forMin: m.forMin } : d.memoryPage,
    load: cfg?.load ? { ...d.load, ...cfg.load } : d.load,
    coldCpuBelow: cfg?.coldCpuBelow ?? d.coldCpuBelow
  }
}

/** The rule thresholds in the shape /api/fleet publishes (the disk lines are the shared constants, added where the view is made). */
export function thresholdsOf(r: FleetRules): Omit<FleetThresholds, 'disk'> {
  return {
    cpu: { warnAbove: r.cpu.warnAbove, clearBelow: r.cpu.clearBelow, forMin: r.cpu.forMin },
    memory: { warnAbove: r.memoryWarn.warnAbove, clearBelow: r.memoryWarn.clearBelow, pageAbove: r.memoryPage.warnAbove, pageClearBelow: r.memoryPage.clearBelow, forMin: r.memoryWarn.forMin },
    load: { warnAbove: r.load.warnAbove, clearBelow: r.load.clearBelow, forMin: r.load.forMin },
    coldCpuBelow: r.coldCpuBelow
  }
}

// ---- names --------------------------------------------------------------------------------------------------------

export const RULE_INFO: Readonly<Record<FleetRuleId, { alertname: string; title: string }>> = {
  'cpu-hot': { alertname: 'HostCpuHot', title: 'Host CPU hot' },
  'memory-hot': { alertname: 'HostMemoryHot', title: 'Host memory hot' },
  'load-high': { alertname: 'HostLoadHigh', title: 'Host load high' }
}

/** The incident title of one rule on one host: the wall's tile key is `Fleet load|Host CPU hot (node-13)`. Netdata's twin alert uses the same title. */
export const fleetRuleTitle = (id: FleetRuleId, host: string): string => `${RULE_INFO[id].title} (${host})`

/**
 * Netdata's own alerts that say what a fleet rule says. On a fleet node they take the rule's title and the Fleet load service (classifyNetdataAlert), so
 * Watch's alert and Netdata's are two pieces of evidence in ONE incident (same service and rule = same incident key, reach 2), never two tiles.
 * Verified against Netdata's stock health.d (cpu.conf, ram.conf, master, 2026-10-15): 10min_cpu_usage warns above 85 %, ram_in_use above 90 %,
 * ram_available below 10 % available. Load has no twin here: the Netdata load_average_* alerts are not read by Watch.
 */
export const NETDATA_TWINS: Readonly<Record<string, FleetRuleId>> = {
  '10min_cpu_usage': 'cpu-hot',
  ram_in_use: 'memory-hot',
  ram_available: 'memory-hot'
}
export const twinOf = (alert: string): FleetRuleId | undefined => NETDATA_TWINS[alert.toLowerCase()]

// ---- the state machine --------------------------------------------------------------------------------------------

export interface ReplayEdge {
  /** Index into the series the rule was evaluated on. */
  index: number
  kind: 'fire' | 'clear'
  /** What the window read at that minute: at a fire its mean (averaged) or its lowest minute (held); at a clear its highest minute. */
  value: number
}

export interface Replay {
  firing: boolean
  /** The index where the current episode began, or null when it is not firing, or it was already firing when the series began. */
  startIndex: number | null
  /** What the last window reads: the mean, or for a held rule the lowest minute. Null when the window is too short or has too many gaps. */
  windowValue: number | null
  edges: ReplayEdge[]
}

interface Window {
  valid: number
  avg: number
  min: number
  max: number
}

function windowAt(points: ReadonlyArray<number | null>, end: number, len: number): Window | null {
  const start = end - len + 1
  if (start < 0) return null
  let valid = 0
  let sum = 0
  let min = Infinity
  let max = -Infinity
  for (let i = start; i <= end; i++) {
    const v = points[i]
    if (v === null || v === undefined || !Number.isFinite(v)) continue
    valid += 1
    sum += v
    if (v < min) min = v
    if (v > max) max = v
  }
  // A mean needs 60 % of its minutes; a held rule needs all of them (checked by the caller: a gap is not proof the node held).
  return valid >= Math.ceil(len * 0.6) ? { valid, avg: sum / valid, min, max } : null
}

/**
 * Walk the series minute by minute with the rule's hysteresis. A window the data cannot fill (the first `forMin - 1` minutes, or too many gaps) leaves the
 * state where it is. `initial` is the state before the series began: the previous poll's.
 */
export function replayThreshold(points: ReadonlyArray<number | null>, t: Threshold, initial = false): Replay {
  const len = Math.max(1, Math.floor(t.forMin))
  let firing = initial
  let startIndex: number | null = null
  let windowValue: number | null = null
  const edges: ReplayEdge[] = []
  for (let i = 0; i < points.length; i++) {
    const w = windowAt(points, i, len)
    if (!w) {
      windowValue = null
      continue
    }
    const held = t.over === 'sustained'
    // a held rule needs every minute of the window
    if (held && w.valid < len) {
      windowValue = null
      continue
    }
    const fireValue = held ? w.min : w.avg
    // every rule clears on a quiet window, not a quiet mean: the highest minute of the window is under the line
    const clearValue = w.max
    windowValue = held ? w.min : w.avg
    if (!firing && fireValue > t.warnAbove) {
      firing = true
      startIndex = i
      edges.push({ index: i, kind: 'fire', value: fireValue })
    } else if (firing && clearValue < t.clearBelow) {
      firing = false
      startIndex = null
      edges.push({ index: i, kind: 'clear', value: clearValue })
    }
  }
  return { firing, startIndex: firing ? startIndex : null, windowValue, edges }
}

// ---- one node ----------------------------------------------------------------------------------------------------

export interface NodeSeries {
  cpu: ReadonlyArray<number | null>
  mem: ReadonlyArray<number | null>
  /** load5 / cores */
  loadPerCore: ReadonlyArray<number | null>
}

/** Whether each rule was firing when the last poll ended: the one thing the rules remember between polls. */
export interface RuleStates {
  cpu: boolean
  memWarn: boolean
  memPage: boolean
  load: boolean
}
export const NO_STATES: RuleStates = { cpu: false, memWarn: false, memPage: false, load: false }

export interface Finding {
  id: FleetRuleId
  level: 'warning' | 'page'
  /** Index into the series where the episode began; null when it began before the series did. */
  startIndex: number | null
  /** What the rule read at the last minute (see Replay.windowValue). */
  value: number | null
  /** The line it crossed. */
  threshold: number
  forMin: number
  over: Reducer
}

export interface NodeEvaluation {
  findings: Finding[]
  states: RuleStates
  replays: { cpu: Replay; memWarn: Replay; memPage: Replay; load: Replay }
}

export function evaluateNode(s: NodeSeries, rules: FleetRules, prev: RuleStates = NO_STATES): NodeEvaluation {
  const cpu = replayThreshold(s.cpu, rules.cpu, prev.cpu)
  const memWarn = replayThreshold(s.mem, rules.memoryWarn, prev.memWarn)
  const memPage = replayThreshold(s.mem, rules.memoryPage, prev.memPage)
  const load = replayThreshold(s.loadPerCore, rules.load, prev.load)
  const findings: Finding[] = []
  if (cpu.firing) findings.push({ id: 'cpu-hot', level: 'warning', startIndex: cpu.startIndex, value: cpu.windowValue, threshold: rules.cpu.warnAbove, forMin: rules.cpu.forMin, over: rules.cpu.over })
  // One memory alert whose level moves: the page tier wins while it holds, the warning tier otherwise.
  if (memPage.firing) findings.push({ id: 'memory-hot', level: 'page', startIndex: memPage.startIndex, value: memPage.windowValue, threshold: rules.memoryPage.warnAbove, forMin: rules.memoryPage.forMin, over: rules.memoryPage.over })
  else if (memWarn.firing) findings.push({ id: 'memory-hot', level: 'warning', startIndex: memWarn.startIndex, value: memWarn.windowValue, threshold: rules.memoryWarn.warnAbove, forMin: rules.memoryWarn.forMin, over: rules.memoryWarn.over })
  if (load.firing) findings.push({ id: 'load-high', level: 'warning', startIndex: load.startIndex, value: load.windowValue, threshold: rules.load.warnAbove, forMin: rules.load.forMin, over: rules.load.over })
  return { findings, states: { cpu: cpu.firing, memWarn: memWarn.firing, memPage: memPage.firing, load: load.firing }, replays: { cpu, memWarn, memPage, load } }
}

/** What a finding read, in words: "83.4% averaged over 10 min", "86.2% at its lowest in the last 10 min (line 85%)", "1.82 per core at its lowest in the last 15 min (line 1.5)". */
export function describeFinding(f: Pick<Finding, 'id' | 'value' | 'threshold' | 'forMin' | 'over'>): string {
  if (f.value === null) return 'no reading'
  const load = f.id === 'load-high'
  const num = `${load ? f.value.toFixed(2) : f.value.toFixed(1)}${load ? ' per core' : '%'}`
  return f.over === 'average' ? `${num} averaged over ${f.forMin} min` : `${num} at its lowest in the last ${f.forMin} min (line ${f.threshold}${load ? '' : '%'})`
}

/** The cell name of one rule on the check list: its trigger in words, read from the live config. */
export function cellName(id: FleetRuleId, r: FleetRules): string {
  if (id === 'cpu-hot') return `HostCpuHot: CPU above ${r.cpu.warnAbove}% averaged over ${r.cpu.forMin} min`
  if (id === 'memory-hot') return `HostMemoryHot: memory above ${r.memoryWarn.warnAbove}% for ${r.memoryWarn.forMin} min (page above ${r.memoryPage.warnAbove}%)`
  return `HostLoadHigh: load above ${r.load.warnAbove} per core for ${r.load.forMin} min`
}

// ---- how hot a node runs -----------------------------------------------------------------------------------------

export interface HeatInput {
  cpu10: number | null
  mem: number | null
  loadPerCore: number | null
  /** A fleet rule is firing on the node. */
  firing: boolean
}

/** See FleetHeat. The same lines as the alerts: hot over `warnAbove` (or firing), warm from `clearBelow` up, cold under the idle line. */
export function heatOf(n: HeatInput, r: FleetRules): FleetHeat {
  if (n.cpu10 === null && n.mem === null && n.loadPerCore === null) return 'unknown'
  const over = (v: number | null, line: number): boolean => v !== null && v > line
  const from = (v: number | null, line: number): boolean => v !== null && v >= line
  if (n.firing || over(n.cpu10, r.cpu.warnAbove) || over(n.mem, r.memoryWarn.warnAbove) || over(n.loadPerCore, r.load.warnAbove)) return 'hot'
  if (from(n.cpu10, r.cpu.clearBelow) || from(n.mem, r.memoryWarn.clearBelow) || from(n.loadPerCore, r.load.clearBelow)) return 'warm'
  if (n.cpu10 !== null && n.cpu10 < r.coldCpuBelow) return 'cold'
  return 'ok'
}
