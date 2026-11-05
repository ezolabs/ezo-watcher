// Pure helpers of the fleet view: the words, the sort, the grouping and the sparkline geometry. No React, no DOM except `tokenPx`.
// The contract is src/shared/fleet.ts; GET /api/fleet answers it (skills/ezo-watcher/references/netdata.md, Fleet load).

import type { FleetDiskHeat, FleetHeat, FleetMount, FleetNode, FleetNodeRule, FleetView, Incident } from '../../shared/types.ts'
import { durationText, unitText } from './format.ts'

/** Percent figures (cpu, memory, disk) run 0 to 100, so a sparkline's vertical axis is that one scale on every row: a cold node is a flat line low down. */
export const PERCENT_SCALE = 100

/** The service the three fleet rules raise their alerts on (src/server/sources/fleet-rules.ts). */
export const FLEET_SERVICE = 'Fleet load'

export type SortKey = 'name' | 'cpu' | 'mem' | 'load' | 'disk' | 'heat'
export interface Sort {
  key: SortKey
  dir: 'asc' | 'desc'
}

/** Read a token-derived length as pixels once, so a sparkline's width and height attributes are the tokens' and no number lives in code. */
const px = new Map<string, number>()
export function tokenPx(name: string): number {
  const held = px.get(name)
  if (held !== undefined) return held
  const probe = document.createElement('div')
  probe.style.cssText = `position:absolute;visibility:hidden;width:var(${name});height:0`
  document.body.appendChild(probe)
  const value = probe.getBoundingClientRect().width
  probe.remove()
  if (value > 0) px.set(name, value)
  return value
}

// ---- figures ---------------------------------------------------------------------------------------------------------------------------

export function percentText(v: number | null): string {
  return v === null ? '-' : `${Math.round(v)}%`
}

/** A disk's used percent to one decimal, as Netdata's own alert text says it ("86.0%"), so the figure and the 80 and 90 lines it is judged by never disagree. */
export function diskPercentText(v: number | null): string {
  return v === null ? '-' : `${v.toFixed(1)}%`
}

const GIB = 1024 ** 3
const TIB = 1024 ** 4

/** Bytes the way Netdata says a disk: binary units, "915 GiB", "9.4 GiB", "3.3 TiB". The number and its unit never part. */
export function bytesText(b: number | null): string {
  if (b === null) return ''
  if (b >= TIB) return unitText((b / TIB).toFixed(1), 'TiB')
  if (b >= 10 * GIB) return unitText(Math.round(b / GIB), 'GiB')
  if (b >= GIB) return unitText((b / GIB).toFixed(1), 'GiB')
  return unitText(Math.round(b / 1024 ** 2), 'MiB')
}

/** "122 GiB free of 915 GiB": what is left to a user, then the size `df` counts (the figure Netdata's alert text uses). Empty with no reading. */
export function diskFreeText(m: Pick<FleetMount, 'freeBytes' | 'sizeBytes'>): string {
  if (m.freeBytes === null) return ''
  return m.sizeBytes === null ? `${bytesText(m.freeBytes)} free` : `${bytesText(m.freeBytes)} free of ${bytesText(m.sizeBytes)}`
}

/** The mount the page and the strip show for a node: its fullest. */
export const worstMount = (node: Pick<FleetNode, 'mounts'>): FleetMount | null => node.mounts[0] ?? null

const DISK_WORD: Record<FleetDiskHeat, string> = { ok: 'normal', warm: 'warm', hot: 'hot', unknown: 'no reading' }
export const diskWord = (h: FleetDiskHeat): string => DISK_WORD[h]

/** A warm or hot disk is the only one that takes colour. */
export const diskTakesColour = (h: FleetDiskHeat): boolean => h === 'warm' || h === 'hot'

/** What a screen reader hears for a node's disk: "node-4 disk 86.0% on /, warm, 122 GiB free of 915 GiB". */
export function diskWords(node: Pick<FleetNode, 'name' | 'mounts'>): string {
  const m = worstMount(node)
  if (!m || m.usedPct === null) return `${node.name} disk, no reading`
  const free = diskFreeText(m)
  return `${node.name} disk ${diskPercentText(m.usedPct)} on ${m.path}, ${diskWord(m.heat)}${free ? `, ${free}` : ''}`
}

export function loadText(v: number | null): string {
  return v === null ? '-' : v.toFixed(1)
}

export function perCoreText(v: number | null): string {
  return v === null ? '' : `${v.toFixed(2)} per core`
}

const HEAT_WORD: Record<FleetHeat, string> = { hot: 'Hot', warm: 'Warm', ok: 'Normal', cold: 'Cold', unknown: 'No data' }
export const heatWord = (h: FleetHeat): string => HEAT_WORD[h]
const HEAT_RANK: Record<FleetHeat, number> = { hot: 4, warm: 3, ok: 2, cold: 1, unknown: 0 }
export const heatRank = (h: FleetHeat): number => HEAT_RANK[h]

/** A hot or warm node is the only one that takes colour. */
export const takesColour = (h: FleetHeat): boolean => h === 'hot' || h === 'warm'

// ---- series ----------------------------------------------------------------------------------------------------------------------------

/** Average consecutive points into `n` buckets (a bucket with no reading stays a gap), so a tiny sparkline draws what it can show. */
export function downsample(values: ReadonlyArray<number | null>, n: number): Array<number | null> {
  if (n <= 0 || values.length <= n) return [...values]
  const out: Array<number | null> = []
  for (let b = 0; b < n; b++) {
    const from = Math.floor((b * values.length) / n)
    const to = Math.floor(((b + 1) * values.length) / n)
    let sum = 0
    let count = 0
    for (let i = from; i < to; i++) {
      const v = values[i]
      if (v !== null && v !== undefined) {
        sum += v
        count++
      }
    }
    out.push(count > 0 ? sum / count : null)
  }
  return out
}

/** An SVG path over the series in a `(n - 1) x PERCENT_SCALE` box, y flipped. A missing minute breaks the line; a lone point is a zero-length segment (a dot under a round cap). */
export function sparkPath(values: ReadonlyArray<number | null>): string {
  const runs: string[][] = []
  let run: string[] | null = null
  values.forEach((v, i) => {
    if (v === null || v === undefined) {
      run = null
      return
    }
    const y = Number((PERCENT_SCALE - Math.min(PERCENT_SCALE, Math.max(0, v))).toFixed(2))
    if (!run) {
      run = []
      runs.push(run)
    }
    run.push(`${i} ${y}`)
  })
  return runs.map((r) => (r.length === 1 ? `M${r[0]}L${r[0]}` : `M${r.join('L')}`)).join('')
}

/** "low 41%, high 55%, now 55%": what a sparkline says to a screen reader. */
export function seriesWords(name: string, values: ReadonlyArray<number | null>, windowMin: number): string {
  const seen = values.filter((v): v is number => v !== null)
  if (seen.length === 0) return `${name}, no readings in the last ${unitText(windowMin, 'min')}`
  const now = [...values].reverse().find((v) => v !== null) as number
  return `${name} over the last ${unitText(windowMin, 'min')}, low ${percentText(Math.min(...seen))}, high ${percentText(Math.max(...seen))}, now ${percentText(now)}`
}

// ---- grouping and sorting --------------------------------------------------------------------------------------------------------------

export interface FleetGroupView {
  id: 'servers' | 'watch only'
  title: string
  nodes: FleetNode[]
}

/** The hosts the table lists: servers, then the machines Watch only looks at. The Kubernetes state collector is not a host, so it is a footnote. */
export function groupHosts(nodes: readonly FleetNode[]): { groups: FleetGroupView[]; collectors: FleetNode[] } {
  const groups: FleetGroupView[] = [
    { id: 'servers', title: 'Servers', nodes: nodes.filter((n) => n.group === 'servers') },
    { id: 'watch only', title: 'Watch only', nodes: nodes.filter((n) => n.group === 'watch only') }
  ]
  return { groups: groups.filter((g) => g.nodes.length > 0), collectors: nodes.filter((n) => n.group === 'k8s') }
}

const SORT_VALUE: Record<Exclude<SortKey, 'name'>, (n: FleetNode) => number | null> = {
  cpu: (n) => n.cpu,
  mem: (n) => n.mem,
  load: (n) => n.loadPerCore,
  disk: (n) => worstMount(n)?.usedPct ?? null,
  heat: (n) => (n.live || n.heat !== 'unknown' ? heatRank(n.heat) : null)
}

/** A column header's first press sorts hottest or highest first (a name, A to Z), the second reverses, the third goes back to the API's order. */
export function nextSort(current: Sort | null, key: SortKey): Sort | null {
  const first: Sort['dir'] = key === 'name' ? 'asc' : 'desc'
  if (!current || current.key !== key) return { key, dir: first }
  if (current.dir === first) return { key, dir: first === 'asc' ? 'desc' : 'asc' }
  return null
}

/** Sort within one group (the group header rows stay put). A node with no reading goes last whichever way the column runs. */
export function sortNodes(nodes: readonly FleetNode[], sort: Sort | null): FleetNode[] {
  if (!sort) return [...nodes]
  const sign = sort.dir === 'asc' ? 1 : -1
  return [...nodes].sort((a, b) => {
    if (sort.key === 'name') return sign * a.name.localeCompare(b.name, undefined, { numeric: true })
    const va = SORT_VALUE[sort.key](a)
    const vb = SORT_VALUE[sort.key](b)
    if (va === null && vb === null) return 0
    if (va === null) return 1
    if (vb === null) return -1
    return sign * (va - vb) || a.name.localeCompare(b.name, undefined, { numeric: true })
  })
}

// ---- words -----------------------------------------------------------------------------------------------------------------------------

/** How long since the feed's newest point: "Updated 20 s ago". */
export function updatedText(view: Pick<FleetView, 'dataAt'>, nowMs: number): string {
  if (!view.dataAt) return 'No reading yet'
  return `Updated ${durationText(Math.max(0, (nowMs - Date.parse(view.dataAt)) / 1000))} ago`
}

/** Why a node's figures are old or absent, in words: "no data for 4 min", or "no data yet" when it never answered. */
export function nodeStaleText(node: Pick<FleetNode, 'updatedAt' | 'live' | 'stale' | 'state'>, nowMs: number): string | null {
  if (!node.stale && node.live) return null
  if (!node.updatedAt) return node.state && node.state !== 'reachable' ? `no data yet, Netdata says ${node.state}` : 'no data yet'
  return `no data for ${durationText(Math.max(0, (nowMs - Date.parse(node.updatedAt)) / 1000))}`
}

const NAMES_SHOWN = 3
/** "a and b", "a, b and c", and past three the rest as a count: "a, b, c and 2 more". */
const joinNames = (names: string[]): string =>
  names.length <= 2 ? names.join(' and ') : names.length <= NAMES_SHOWN ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : `${names.slice(0, NAMES_SHOWN).join(', ')} and ${names.length - NAMES_SHOWN} more`

/**
 * The page's header line from the summary, in plain words: "13 nodes, 1 hot: node-13 at 87% CPU, 2 disks warm: node-4 86.0% and print 85.7%". `detail` is the
 * sentence under it: the fleet's average, the cold count and, when nothing is hot, the busiest node. A disk is named only when it is warm or hot.
 */
export function fleetHeadline(view: FleetView): { lead: string; detail: string } {
  const s = view.summary
  const hosts = view.nodes.filter((n) => n.group !== 'k8s')
  const hot = hosts.filter((n) => n.heat === 'hot')
  const warm = hosts.filter((n) => n.heat === 'warm')
  const nodes = `${s.nodes} ${s.nodes === 1 ? 'node' : 'nodes'}`
  const at = (n: FleetNode): string => `${n.name} at ${percentText(n.cpu)} CPU`
  const parts: string[] = []
  if (hot.length > 0) parts.push(`${hot.length} hot: ${hot.length === 1 ? at(hot[0]!) : joinNames(hot.map((n) => n.name))}`)
  if (warm.length > 0) parts.push(`${warm.length} warm: ${warm.length === 1 ? at(warm[0]!) : joinNames(warm.map((n) => n.name))}`)
  const atDisk = (n: FleetNode): string => `${n.name} ${diskPercentText(worstMount(n)?.usedPct ?? null)}`
  const disks: string[] = []
  for (const heat of ['hot', 'warm'] as const) {
    const those = hosts.filter((n) => n.diskHeat === heat)
    if (those.length > 0) disks.push(`${those.length} ${those.length === 1 ? 'disk' : 'disks'} ${heat}: ${joinNames(those.map(atDisk))}`)
  }
  const lead = [parts.length > 0 ? `${nodes}, ${parts.join(', ')}` : `${nodes}, none hot`, ...disks].join(', ')
  const bits: string[] = []
  if (s.fleetCpuAvg !== null) bits.push(`The servers average ${percentText(s.fleetCpuAvg)} CPU.`)
  if (s.cold > 0) bits.push(`${s.cold} ${s.cold === 1 ? 'node is' : 'nodes are'} cold, under ${view.thresholds.coldCpuBelow}% CPU for 10 min.`)
  if (hot.length === 0 && warm.length === 0 && s.hottest) bits.push(`The busiest is ${at({ name: s.hottest.name, cpu: s.hottest.cpu } as FleetNode)}.`)
  return { lead: `${lead}.`, detail: bits.join(' ') }
}

/** The one sentence a screen reader gets for the strip: "Fleet, 13 nodes, 1 hot: node-13 at 87% CPU. Open the Fleet page." */
export function stripLabel(view: FleetView, nowMs: number): string {
  const head = fleetHeadline(view).lead
  const old = view.stale ? ` The figures are ${durationText(Math.max(0, (nowMs - Date.parse(view.dataAt ?? view.generatedAt)) / 1000))} old.` : ''
  return `Fleet, ${head}${old} Open the Fleet page.`
}

// ---- alerts ----------------------------------------------------------------------------------------------------------------------------

const RULE_TITLE: Record<string, string> = { 'cpu-hot': 'Host CPU hot', 'memory-hot': 'Host memory hot', 'load-high': 'Host load high' }

/** A firing rule's name in words ("Host CPU hot"): the incident title Watch gives it, minus the host. */
export const ruleName = (rule: FleetNodeRule): string => RULE_TITLE[rule.id] ?? rule.alertname

/** The Watch incident behind a firing fleet rule, when Watch has it on the wall (title `Host CPU hot (node-13)` on the Fleet load service). */
export function incidentFor(rule: FleetNodeRule, node: Pick<FleetNode, 'name'>, incidents: readonly Pick<Incident, 'key' | 'service' | 'rule'>[]): string | null {
  const title = `${ruleName(rule)} (${node.name})`
  return incidents.find((i) => i.service === FLEET_SERVICE && i.rule === title)?.key ?? null
}
