// The proof-of-watch cells of a tile, as words. Pure, so the wall, the service sheet and the tests read one model.
//
// A quiet tile is not a strip of every rule. It draws every cell that is not ok (firing, error, stale, no data, pending, history-only)
// and ONE count for the rest, so 99 healthy rules cost one word and the 23 that need a look stay in sight at any cell count
// (docs/design.md, "The wall"). The legend says what each shape means; the service sheet says it per rule, in the words of the source.

import type { CellState, RuleCell, SourceKind, SourceStatus } from '../../shared/types.ts'
import { durationText, NBSP, unitText } from './format.ts'

/** Worst first: what is firing or cannot be read comes before what is only waiting, and a cell with no rule behind it comes last of the non-ok ones. */
const RANK: Record<CellState, number> = { firing: 0, error: 1, stale: 2, nodata: 3, pending: 4, inferred: 5, ok: 6 }

export interface CellSplit {
  /** Every cell that is not ok, worst first, each state in the order the source gave. */
  open: RuleCell[]
  /** How many cells are ok: they are counted, not drawn. */
  ok: number
  total: number
}

export function splitCells(cells: readonly RuleCell[]): CellSplit {
  const open = cells.filter((c) => c.state !== 'ok').sort((a, b) => RANK[a.state] - RANK[b.state])
  return { open, ok: cells.length - open.length, total: cells.length }
}

/** The whole list in the order a sheet reads it: the cells that need a look first, then the ok ones as the source gave them. */
export function orderCells(cells: readonly RuleCell[]): RuleCell[] {
  const { open } = splitCells(cells)
  return [...open, ...cells.filter((c) => c.state === 'ok')]
}

/** The count of the rest: "99 ok", "All 15 ok" when nothing else is drawn, "1 ok" for a lone cell, null when none is ok. */
export function okText(s: CellSplit): string | null {
  if (s.total === 0 || s.ok === 0) return null
  if (s.open.length === 0 && s.total > 1) return `All ${unitText(s.total, 'ok')}`
  return unitText(s.ok, 'ok')
}

/** The count of the cells a tile is too small to draw: one short line that always fits. */
export function openText(s: CellSplit): string {
  return `${s.open.length}${NBSP}not${NBSP}ok`
}

// ---- the source of a cell ---------------------------------------------------------------------------

export type CellOrigin = 'grafana' | 'vmalert' | 'netdata-cloud' | 'prober' | 'sweep' | 'check' | 'host' | 'other'

/** The senders of a pushed check list that this product knows by name (skills/ezo-watcher/references/sources.md, "A `checks` push"); any other sender is a plain "check". */
const CHECK_SENDERS: Record<string, CellOrigin> = { 'api-uptime': 'prober', 'sweep': 'sweep' }

/** Source id to source kind, for the polled sources: a rule cell names the source that read it, not its kind. */
export function sourceKinds(sources: ReadonlyArray<Pick<SourceStatus, 'id' | 'kind'>>): Record<string, SourceKind> {
  return Object.fromEntries(sources.map((s) => [s.id, s.kind]))
}

export function cellOrigin(c: RuleCell, kinds: Readonly<Record<string, SourceKind>>): CellOrigin {
  // a cell that came from a pushed check list carries its check id; the sender says which kind of check it is
  if (c.checkId !== undefined) return CHECK_SENDERS[c.source] ?? 'check'
  const kind = kinds[c.source]
  // the fleet metrics source reads the same Netdata Cloud: its cells speak in the same words as the alert poll's
  if (kind === 'netdata-fleet') return 'netdata-cloud'
  if (kind === 'host') return 'host'
  return kind === 'grafana' || kind === 'vmalert' || kind === 'netdata-cloud' ? kind : 'other'
}

// ---- state in words ---------------------------------------------------------------------------------

const HISTORY = 'seen in the alert history only'

const POLLED: Record<CellState, string> = {
  ok: 'evaluating normally',
  pending: 'pending, inside its for-window',
  firing: 'firing',
  nodata: 'no data',
  error: 'evaluation error',
  stale: 'not evaluated recently',
  inferred: HISTORY
}

/** What a state means for each source: the same shape does not mean the same thing to a Grafana rule, a prober and a sweep. */
const WORDS: Record<CellOrigin, Record<CellState, string>> = {
  grafana: POLLED,
  vmalert: POLLED,
  'netdata-cloud': { ...POLLED, ok: 'no alert raised', pending: 'pending, waiting before declaring a node unreachable', nodata: 'no data, no node answered', stale: 'not polled recently' },
  prober: { ok: 'last check passed', pending: 'pending, waiting before declaring down', firing: 'failing', nodata: 'skipped', error: 'failing', stale: 'not checked recently', inferred: HISTORY },
  sweep: { ok: 'last run passed', pending: 'pending, read in part', firing: 'failing', nodata: 'skipped', error: 'failing', stale: 'not run recently', inferred: HISTORY },
  check: { ok: 'last run passed', pending: 'pending, not yet declared', firing: 'failing', nodata: 'skipped', error: 'failing', stale: 'not run recently', inferred: HISTORY },
  host: { ok: 'within its threshold', pending: 'pending, waiting before declaring it', firing: 'over its threshold', nodata: 'skipped', error: 'over its threshold', stale: 'not read recently', inferred: HISTORY },
  other: { ...POLLED, ok: 'evaluating normally' }
}

const CHECKS = new Set<CellOrigin>(['prober', 'sweep', 'check', 'host'])

/** The state of one cell in the words of its source: "pending, inside its for-window", "skipped", "not run in the last 10 h". */
export function cellWords(c: RuleCell, origin: CellOrigin): string {
  // a check list names its own limit, so a stale check says how long it may be silent
  if (c.state === 'stale' && CHECKS.has(origin) && c.staleAfterSec !== undefined) return `not run in the last ${durationText(c.staleAfterSec)}`
  return WORDS[origin][c.state]
}

/** The state in words, then the reason when the source sent one: "skipped: no credential for Cloudflare analytics". */
export function cellLine(c: RuleCell, origin: CellOrigin): string {
  const words = cellWords(c, origin)
  return c.detail ? `${words}: ${c.detail}` : words
}

const SHORT: Record<CellState, string> = { ok: 'ok', pending: 'pending', firing: 'firing', nodata: 'no data', error: 'error', stale: 'stale', inferred: 'history' }

/** One or two words for the end of a row. */
export function cellShort(c: RuleCell, origin: CellOrigin): string {
  return c.state === 'nodata' && CHECKS.has(origin) ? 'skipped' : SHORT[c.state]
}

// ---- the legend -------------------------------------------------------------------------------------

/** One line under the wall's status line: the shape, then what it says. Each item draws its own cell before the words. */
export const CELL_LEGEND: ReadonlyArray<{ state: CellState; shape: string; text: string }> = [
  { state: 'ok', shape: 'Solid', text: 'evaluating.' },
  { state: 'pending', shape: 'Half', text: 'pending.' },
  { state: 'nodata', shape: 'Dashed', text: 'no data, error or stale.' },
  { state: 'inferred', shape: 'Dotted', text: `an alert with this name fired in the last 30${NBSP}days, but no rule reports on it now.` }
]

/** The legend as one string: what a screen reader reads and what the tests hold the copy to. */
export function legendText(): string {
  return CELL_LEGEND.map((l) => `${l.shape}: ${l.text}`).join(' ')
}
