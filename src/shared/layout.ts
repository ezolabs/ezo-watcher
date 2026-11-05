// Wall layout. Two rules, one per wall:
//
// THE TIER RULE (`opt.tier` given, every wall in the app): the wall is a grid of small cells, and a tile's footprint in cells is set by its
// severity, so tile area scales with severity and a page dominates, a warning is compact and a healthy service recedes (docs/design.md, "The wall").
// A page is a block half the columns wide and three cells tall (an acknowledged one two tall), a warning, an acknowledged or a silenced incident a
// block of two by two cells, a healthy service one cell, wider only when it has more dots than one cell holds. The tiles are placed in order, page
// first, then the unattended warnings by weight, then the acknowledged ones, then the healthy services that need a look, then the rest, each into
// the first free space of the grid (the dense packing of a CSS grid), so the problems lead and the small cells pack around them. Reach and age order
// the tiles of a tier and tint them; they never grow a warning past its tier. A row is as tall as the wall has room for, between the cell's minimum
// and its cap; when the cells need more rows than the wall has, the wall grows (`wallHeight`) and the page scrolls, never a cell shrinking.
//
// GROUPS (`opt.groups` given and `rule.head` above 0; the By service wall with the Group toggle on, docs/design.md "Wall groups"): the category grouping is for the
// FIRING tiles only. The incidents (pages, warnings, acknowledged, silenced) are split into sections, one per group that has an incident, each starting on a fresh row
// with a heading that is a full-width row of its own height (`rule.head`) on the same grid; the sections run worst first (pages, then warnings, acknowledged, silenced;
// the config's order between groups of one severity), each tile placed as above inside its section. The healthy services are ONE flat grid below the last section, on a
// fresh row, in the order they have always had, with no heading between them. Without `opt.groups` (the toggle off, the By host wall, the geometry tests) there are no
// sections: the healthy cells pack around the incidents, as they did before there were groups.
//
// PARKED: an incident the sweep has an open verdict for that is not due yet (`LayoutItem.parkedUntil`) is a firing tile that is in no group's section. With headings
// the sections run, then a section headed Parked (soonest end first), then the healthy cells; without them the parked tiles sit in a section under the whole grid. It
// is the quiet tier at the quiet footprint, like a silenced one, and never ahead of one that is live.
//
// THE TREEMAP (`opt.tier` omitted, as the geometry tests do; the app always gives the rule):
// - Squarified treemaps: Bruls, Huizing, van Wijk, "Squarified Treemaps", Joint Eurographics/IEEE TCVG
//   Symposium on Visualization 2000, https://www.win.tue.nl/~vanwijk/stm.pdf (retrieved 2026-10-14).
//   "comparison of the size of rectangles is easier when their aspect ratios are similar" (section 2).
// - Stability: Sondag, Speckmann, Verbeek, "Stable Treemaps via Local Moves", IEEE TVCG 24(1) 2018,
//   DOI 10.1109/TVCG.2017.2745140: "small changes in the data result only in small changes in the treemap".
//   Here stability comes from integer weights (only a real step moves anything) and a fixed sort key
//   (tier, unattended before acknowledged, weight descending, id), so the biggest problem is top-left and nothing else reshuffles on a poll.
// - Regions: an ordered squarify over the regions (page first), each region's area the sum of its tiles' weights (incident.ts tileWeight),
//   so every tile's area is proportional to its own weight before the minimum-size lift. Severity is a tier base, so it is never
//   out-bought by quantity or age. Squarify then runs inside each region.
//
// The healthy-service grid borrows the Supabase observability "Service Health" and Statuspage component grids: a dense grid of small cells, each with its
// status dots and a one-line summary, problems sized by severity.

import type { Tier } from './types.ts'
import { tileWeight } from './incident.ts'
import { PARKED_GROUP } from './wall-groups.ts'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface LayoutItem {
  id: string
  tier: Tier
  /** Integer weight inside the tier. */
  R: number
  /**
   * The narrowest this tile may be, in px, when its tier's own minimum is narrower: an incident tile that is no longer the loudest
   * thing on the wall (acked, silenced, below page) still has to hold its title. The tier's cells are then at least this wide, and
   * only a tier that holds such a tile changes.
   */
  minW?: number
  /**
   * The shortest this tile may be, in px, when its tier's own minimum is shorter: an incident tile's rows (host badge, a two-line
   * headline, the rule class) need a height of their own, or the last of them is cut. Like `minW`, only the tier that holds such
   * a tile changes.
   */
  minH?: number
  /**
   * Someone has this incident (acknowledged). Inside its tier it follows the unattended tiles, whatever its weight, so the tiles nobody has
   * come first and an acknowledged one never sits ahead of one that is still unattended.
   */
  attended?: boolean
  /**
   * An incident tile of any tier (a silenced one is the quiet tier). It is laid out with the incidents, never among the healthy services.
   * Omitted, a tile is an incident when its tier is page or warning.
   */
  firing?: boolean
  /** A healthy service with a rule that needs a look (not ok): it leads the healthy cells, so it is the first thing read there. */
  look?: boolean
  /** The dots a healthy service draws (its rules that are not ok): a cell wider than one column when they do not fit one. */
  marks?: number
  /** The wall group an incident is filed under (an id from `LayoutOptions.groups`); an id not listed there follows the listed groups. A healthy service has none: the cells are one grid. */
  group?: string
  /**
   * Epoch ms the park of this incident ends, set only on a parked incident. A parked incident is not in its group's section: the parked ones have a section of
   * their own, headed `Parked` (`PARKED_GROUP`), after every other incident and before the healthy cells, soonest end first.
   */
  parkedUntil?: number
}

export interface Size {
  w: number
  h: number
}

/**
 * The tier rule's numbers, read from tokens.css by the caller (the --wall-cell-*, --wall-warning-* and --wall-page-* tokens), so no design number lives here.
 */
export interface TierRule {
  /** One cell: the narrowest a column is and the shortest a row is, in px. */
  cell: Size
  /** The tallest a row is stretched to when the wall has room to spare. */
  cellMaxH: number
  /** What a healthy cell draws, so the rule can tell how many dots one holds: its padding and border across, one dot with its gap, the "N ok" count's width, the rows of dots, and the most columns a cell may take. */
  chromeW: number
  dotW: number
  okW: number
  dotRows: number
  maxSpan: number
  /** A warning's footprint (an acknowledged or silenced incident has the same), in cells. */
  warning: { cols: number; rows: number }
  /** A page's footprint: its rows (fewer once acknowledged), the share of the columns it spans, and the fewest columns. */
  page: { rows: number; rowsAttended: number; share: number; minCols: number }
  /** The height of a group's heading row, in px (tokens: --wall-group-head-h). Absent or 0: no headings. */
  head?: number
}

export interface LayoutOptions {
  width: number
  height: number
  gap: number
  /** Minimum tile sizes in px, read from CSS variables by the caller (tokens.css owns the numbers). */
  firingMin: Size
  quietMin: Size
  /** The tier rule. Given, the wall is laid out on the grid of cells (above). Omitted, as a treemap. */
  tier?: TierRule
  /** The wall groups in the config's order (ids). Given, with `tier.head`, the incidents sit in a section per group under a heading, and the healthy cells are one grid below them. */
  groups?: string[]
}

/** How the wall's room was divided. */
export interface Allotment {
  /** The fractions of the wall's area (its width times the height it is laid out in) the page tiles, the warning tiles (acknowledged and silenced ones too) and the healthy services hold. */
  pageShare: number
  warningShare: number
  healthyShare: number
  /** The grid of the tier rule: its columns, its rows (the heading rows included) and the height of a cell row. Zero for a treemap. */
  cols: number
  rows: number
  rowH: number
  /** How many of the rows are group headings. */
  heads: number
  /** Every tile holds its minimum. False when the wall is too small for them all: it must grow (`wallHeight`). */
  holds: boolean
}

export type Placed = Box & { id: string; tier: Tier }

/** The id a group's heading is placed under (`layoutWall` returns it beside the tiles), so a caller reads the heading's box from the same map. */
export const groupHeadId = (group: string): string => `group:${group}`

export { PARKED_GROUP }

type Region = 'page' | 'warning' | 'healthy'
const REGION_ORDER: Region[] = ['page', 'warning', 'healthy']
/** How many times a region that cannot hold its tiles has its share raised, and by how much. */
const FIT_PASSES = 8
const FIT_RAISE = 1.35

const isFiring = (it: LayoutItem): boolean => it.firing ?? it.tier !== 'quiet'
const isParked = (it: LayoutItem): boolean => it.parkedUntil !== undefined
/** The parked incidents in the order their section shows them: the park that ends first, then id. */
const byParkEnd = (a: LayoutItem, b: LayoutItem): number => (a.parkedUntil as number) - (b.parkedUntil as number) || byId(a, b)
/** An incident that is not a page (a warning, or a silenced one) shares the warning region: it follows the unattended tiles there. */
const regionOf = (it: LayoutItem): Region => (it.tier === 'page' ? 'page' : isFiring(it) ? 'warning' : 'healthy')
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The tiles of the wall, each at its place. A tile is never below the minimum its region holds, unless the wall is too small for them all (`wallHeight`). */
export function layoutWall(items: LayoutItem[], opt: LayoutOptions): Placed[] {
  return plan(items, opt).placed
}

/** How the wall's room was divided between the page tiles, the warning tiles and the healthy services (see the header). */
export function allotWall(items: LayoutItem[], opt: LayoutOptions): Allotment {
  return plan(items, opt).allot
}

/**
 * The height the wall needs, at least `opt.height`: the smallest at which every tile holds its minimum. A viewport too short for the cells makes the page
 * scroll, rather than squeezing a tile under its minimum. On the tier grid that is the rows the packing needs; as a treemap it adds one row of the smallest
 * tile at a time, so it ends after at most one row for each tile.
 */
export function wallHeight(items: LayoutItem[], opt: LayoutOptions): number {
  if (useTiers(items, opt)) {
    const { rows, heads } = gridOf(items, opt)
    return Math.max(opt.height, (rows - heads.length) * opt.tier.cell.h + heads.length * headH(opt.tier) + Math.max(0, rows - 1) * opt.gap)
  }
  const step = opt.quietMin.h + opt.gap
  let height = opt.height
  for (let row = 0; row <= items.length; row++, height += step) {
    if (plan(items, { ...opt, height }).allot.holds) return height
  }
  return opt.height
}

interface Plan {
  placed: Placed[]
  allot: Allotment
}

/** The tier rule applies to every wall that was given the rule; without it a wall is a treemap (the geometry tests). */
function useTiers(items: LayoutItem[], opt: LayoutOptions): opt is LayoutOptions & { tier: TierRule } {
  return !!opt.tier && opt.width > 0 && items.length > 0
}

// ---- the tier rule ---------------------------------------------------------------------------------------------------------------

/** A tile's footprint on the grid, in cells. */
export interface Footprint {
  cols: number
  rows: number
}

/** How many columns the grid has: as many as the width holds at the cell's minimum width, at least one. */
export function gridColumns(width: number, gap: number, cell: Size): number {
  return Math.max(1, Math.floor((width + gap) / (cell.w + gap)))
}

/**
 * How many columns a healthy cell takes for its dots: one while its dots and its "N ok" count fit the rows of dots one column holds, else the fewest
 * columns that hold them, at most `maxSpan` (past that its strip gives up its dots for a count). `colW` is the width of one column.
 */
export function healthySpan(marks: number, colW: number, gap: number, rule: TierRule): number {
  const okSlots = Math.ceil(rule.okW / rule.dotW)
  for (let span = 1; span < rule.maxSpan; span++) {
    const inner = span * colW + (span - 1) * gap - rule.chromeW
    if (marks <= Math.max(0, Math.floor(inner / rule.dotW)) * rule.dotRows - okSlots) return span
  }
  return rule.maxSpan
}

/** How many columns a page spans: its share of the grid, at least its minimum, never more than the grid has. */
export function pageColumns(cols: number, rule: TierRule): number {
  return Math.min(cols, Math.max(rule.page.minCols, Math.ceil(cols * rule.page.share)))
}

/**
 * THE TIER RULE: the footprint of one tile, in cells, set by its severity. A page spans `pageColumns` and `rule.page.rows` rows (`rowsAttended` once someone has
 * it), a warning, an acknowledged or a silenced incident `rule.warning`, a healthy service one cell, wider for its dots (`healthySpan`). So page > warning > healthy
 * in area, whatever the reach or the age: those order the tiles of a tier and tint them.
 */
export function footprintOf(it: LayoutItem, cols: number, colW: number, gap: number, rule: TierRule): Footprint {
  const region = regionOf(it)
  if (region === 'page') return { cols: pageColumns(cols, rule), rows: it.attended ? rule.page.rowsAttended : rule.page.rows }
  if (region === 'warning') return { cols: Math.min(cols, rule.warning.cols), rows: rule.warning.rows }
  return { cols: Math.min(cols, healthySpan(it.marks ?? 0, colW, gap, rule)), rows: 1 }
}

/** Unattended, then acknowledged, then silenced, then parked: a silenced incident is the quiet tier of firing ones, and a parked one follows it. */
const attention = (it: LayoutItem): number => (it.attended ? 1 : isParked(it) ? 3 : isFiring(it) && it.tier === 'quiet' ? 2 : 0)

/** The order the tiles are placed in: page, warning, healthy; inside a tier the unattended before the acknowledged, the healthy that need a look first, then weight, then id. */
function tierOrder(a: LayoutItem, b: LayoutItem): number {
  return (
    REGION_ORDER.indexOf(regionOf(a)) - REGION_ORDER.indexOf(regionOf(b)) ||
    attention(a) - attention(b) ||
    Number(!!b.look) - Number(!!a.look) ||
    b.R - a.R ||
    byId(a, b)
  )
}

interface Slot extends Footprint {
  id: string
  col: number
  row: number
}

/** A group's heading row, in px (0 when the rule has none). */
const headH = (rule: TierRule): number => rule.head ?? 0

/**
 * The groups that have an incident, in the order their sections run: the group of the most severe incident first (a page before a warning, an unattended one before
 * an acknowledged one before a silenced one), the config's order (`groups`) between groups whose worst incident is alike, and a group the list does not know after
 * the listed ones. Only firing items count; the wall reads this to draw the same sections in the same order the grid placed them.
 */
export function incidentGroupOrder(items: LayoutItem[], groups: readonly string[]): string[] {
  const worst = new Map<string, LayoutItem>()
  // a parked incident is in no group's section, so it neither makes a section nor sets its place
  for (const it of [...items].sort(tierOrder)) if (isFiring(it) && !isParked(it) && !worst.has(it.group ?? '')) worst.set(it.group ?? '', it)
  const place = (id: string): number => {
    const at = groups.indexOf(id)
    return at < 0 ? groups.length : at
  }
  return [...worst.keys()].sort((a, b) => {
    const x = worst.get(a) as LayoutItem
    const y = worst.get(b) as LayoutItem
    return REGION_ORDER.indexOf(regionOf(x)) - REGION_ORDER.indexOf(regionOf(y)) || attention(x) - attention(y) || place(a) - place(b) || (a < b ? -1 : 1)
  })
}

/**
 * The grid the items pack into: each item in order into the first free space, scanning rows then columns (the dense packing of a CSS grid). With groups, each group
 * that has an incident takes a fresh row for its heading and packs its incidents into the rows under it, so a section never shares a row with another; the healthy
 * cells then pack from the first row below the last section, one grid. Without groups everything packs from the top, the cells around the incidents.
 */
function gridOf(items: LayoutItem[], opt: LayoutOptions & { tier: TierRule }): { slots: Slot[]; rows: number; cols: number; colW: number; heads: Array<{ group: string; row: number }> } {
  const { tier, gap } = opt
  const cols = gridColumns(opt.width, gap, tier.cell)
  const colW = (opt.width - gap * (cols - 1)) / cols
  const taken: boolean[][] = []
  const free = (row: number, col: number, f: Footprint): boolean => {
    for (let r = row; r < row + f.rows; r++) for (let c = col; c < col + f.cols; c++) if (taken[r]?.[c]) return false
    return true
  }
  const slots: Slot[] = []
  const heads: Array<{ group: string; row: number }> = []
  let rows = 0
  const place = (it: LayoutItem, from: number): void => {
    const f = footprintOf(it, cols, colW, gap, tier)
    search: for (let row = from; ; row++) {
      for (let col = 0; col + f.cols <= cols; col++) {
        if (!free(row, col, f)) continue
        for (let r = row; r < row + f.rows; r++) for (let c = col; c < col + f.cols; c++) (taken[r] ??= [])[c] = true
        slots.push({ id: it.id, col, row, ...f })
        rows = Math.max(rows, row + f.rows)
        break search
      }
    }
  }
  const ordered = [...items].sort(tierOrder)
  const incidents = ordered.filter(isFiring)
  const live = incidents.filter((it) => !isParked(it))
  const parked = incidents.filter(isParked).sort(byParkEnd)
  // a section: its heading takes a fresh row and its tiles pack into the rows under it
  const section = (group: string, list: LayoutItem[]): void => {
    heads.push({ group, row: rows })
    rows += 1
    const start = rows
    for (const it of list) place(it, start)
  }
  if (opt.groups && headH(tier) > 0 && incidents.length > 0) {
    for (const group of incidentGroupOrder(live, opt.groups)) section(group, live.filter((it) => (it.group ?? '') === group))
    // the parked incidents follow every section, the silenced ones included
    if (parked.length > 0) section(PARKED_GROUP.id, parked)
    // the first row below the last section, read once: placing a cell moves `rows`, and the next cell starts on the same row, not the one after
    const below = rows
    for (const it of ordered) if (!isFiring(it)) place(it, below)
  } else {
    // without sections the live incidents and the cells pack from the top; the parked ones get their one section under all of it (when there are headings to draw)
    const headed = headH(tier) > 0 && parked.length > 0
    for (const it of ordered) if (!(headed && isParked(it))) place(it, 0)
    if (headed) section(PARKED_GROUP.id, parked)
  }
  return { slots, rows, cols, colW, heads }
}

function planTiers(items: LayoutItem[], opt: LayoutOptions & { tier: TierRule }): Plan {
  const { tier, gap } = opt
  items = [...items].sort(byId)
  const { slots, rows, cols, colW, heads } = gridOf(items, opt)
  const head = headH(tier)
  const isHead = new Set(heads.map((h) => h.row))
  const cellRows = rows - heads.length
  // a cell row is as tall as the wall has room for between the cell's minimum and its cap (the heading rows keep their own height); more rows than the wall holds and the wall grows instead
  const rowH = Math.min(tier.cellMaxH, Math.max(tier.cell.h, (opt.height - heads.length * head - (rows - 1) * gap) / Math.max(1, cellRows)))
  const holds = cellRows * tier.cell.h + heads.length * head + (rows - 1) * gap <= opt.height + 0.001
  const tops: number[] = []
  let top = 0
  for (let r = 0; r < rows; r++) {
    tops[r] = top
    top += (isHead.has(r) ? head : rowH) + gap
  }
  const total = cellRows * rowH + heads.length * head + Math.max(0, rows - 1) * gap
  const byItem = new Map(items.map((it) => [it.id, it]))
  const placed: Placed[] = slots.map((sl) => ({
    id: sl.id,
    tier: (byItem.get(sl.id) as LayoutItem).tier,
    x: sl.col * (colW + gap),
    y: tops[sl.row],
    w: sl.cols * colW + (sl.cols - 1) * gap,
    h: sl.rows * rowH + (sl.rows - 1) * gap
  }))
  const headings: Placed[] = heads.map((h) => ({ id: groupHeadId(h.group), tier: 'quiet', x: 0, y: tops[h.row], w: opt.width, h: head }))
  return { placed: [...placed, ...headings], allot: { ...sharesOf(placed, byItem, opt.width * Math.max(opt.height, total)), cols, rows, rowH, heads: heads.length, holds } }
}

/** The share of `total` area each severity holds. */
function sharesOf(placed: Placed[], byItem: Map<string, LayoutItem>, total: number): Pick<Allotment, 'pageShare' | 'warningShare' | 'healthyShare'> {
  const held: Record<Region, number> = { page: 0, warning: 0, healthy: 0 }
  for (const p of placed) held[regionOf(byItem.get(p.id) as LayoutItem)] += p.w * p.h
  return { pageShare: held.page / total, warningShare: held.warning / total, healthyShare: held.healthy / total }
}

function plan(items: LayoutItem[], opt: LayoutOptions): Plan {
  const wall: Box = { x: 0, y: 0, w: opt.width, h: opt.height }
  const idle = { pageShare: 0, warningShare: 0, healthyShare: 0, cols: 0, rows: 0, rowH: 0, heads: 0, holds: true }
  if (items.length === 0 || opt.width <= 0 || opt.height <= 0) return { placed: [], allot: idle }
  // A fixed order makes every floating-point sum below independent of the order the caller passed.
  items = [...items].sort(byId)
  if (useTiers(items, opt)) return planTiers(items, opt)
  const r = layoutRegions(items, wall, opt)
  const byItem = new Map(items.map((it) => [it.id, it]))
  return { placed: r.placed, allot: { ...idle, ...sharesOf(r.placed, byItem, wall.w * wall.h), holds: r.holds } }
}

/** The items of one box, in the ordered squarified treemap of their regions: the regions first (page first), then the tiles of each region. */
function layoutRegions(items: LayoutItem[], box: Box, opt: LayoutOptions): { placed: Placed[]; holds: boolean } {
  if (items.length === 0) return { placed: [], holds: true }
  if (box.w <= 0 || box.h <= 0) return { placed: [], holds: false }
  const total = box.w * box.h
  const byRegion = new Map<Region, LayoutItem[]>()
  for (const it of items) {
    const list = byRegion.get(regionOf(it)) ?? []
    list.push(it)
    byRegion.set(regionOf(it), list)
  }
  const present = REGION_ORDER.filter((r) => byRegion.has(r))

  // Region shares: the sum of tile weights per region, then lifted so each region can hold the minimum tile area of every tile in it
  // (the quiet floor of the drilled design is this lift).
  const weightOf = (it: LayoutItem): number => tileWeight(it.tier, it.R)
  const shares = new Map<Region, number>()
  const budgetSum = items.reduce((s, it) => s + weightOf(it), 0)
  for (const r of present) shares.set(r, (byRegion.get(r) as LayoutItem[]).reduce((s, it) => s + weightOf(it), 0) / budgetSum)
  // Pages hold the larger floor; the other regions share the smaller one, so a crowded wall still leaves the pages the room to dominate.
  // A tile's own title room widens its region's minimum.
  const minOf = (r: Region): Size => {
    const list = byRegion.get(r) ?? []
    const base = r === 'page' ? opt.firingMin : opt.quietMin
    return { w: list.reduce((m, it) => Math.max(m, it.minW ?? 0), base.w), h: list.reduce((m, it) => Math.max(m, it.minH ?? 0), base.h) }
  }
  const cellOf = (r: Region): Size => ({ w: minOf(r).w + opt.gap, h: minOf(r).h + opt.gap })
  const floorShare = (r: Region): number => {
    const cell = cellOf(r)
    return Math.min(1, ((byRegion.get(r)?.length ?? 0) * cell.w * cell.h) / total)
  }
  for (let pass = 0; pass < present.length; pass++) {
    let deficit = 0
    const slack: Region[] = []
    for (const r of present) {
      const have = shares.get(r) as number
      const need = floorShare(r)
      if (have < need) {
        deficit += need - have
        shares.set(r, need)
      } else slack.push(r)
    }
    if (deficit === 0) break
    const slackSum = slack.reduce((s, r) => s + (shares.get(r) as number), 0)
    if (slackSum <= deficit || slack.length === 0) break
    for (const r of slack) {
      const have = shares.get(r) as number
      shares.set(r, Math.max(floorShare(r), have - (deficit * have) / slackSum))
    }
  }

  // The regions are themselves a small ordered squarified treemap (page first, so the page region takes the top-left), which keeps every
  // region a sensible shape: a lone warning never becomes a full-height strip.
  const regionsFor = (): Map<Region, Box> =>
    new Map(
      squarify(
        present.map((r) => ({ id: r, weight: shares.get(r) as number })),
        box
      ).map((b) => [b.id as Region, b])
    )
  // One region's tiles at their places: a weighted treemap, else, when any tile is under the minimum on either side, an even grid of
  // minimum-size cells, heaviest first (legible beats proportional). `fits` is false when not even the grid holds them.
  const fill = (r: Region, region: Box): { boxes: Array<Box & { id: string }>; list: LayoutItem[]; fits: boolean } => {
    const list = [...(byRegion.get(r) as LayoutItem[])].sort(
      (a, b) => Number(!!a.attended) - Number(!!b.attended) || b.R - a.R || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )
    const cell = cellOf(r)
    const short = (boxes: Box[]): boolean => boxes.some((b) => b.w < cell.w - 1 || b.h < cell.h - 1)
    let boxes = squarify(floorWeights(list.map((l) => ({ id: l.id, weight: weightOf(l) })), region, cell.w * cell.h), region)
    if (short(boxes)) boxes = evenGrid(list.map((l) => l.id), region, cell)
    return { boxes, list, fits: !short(boxes) }
  }
  let regions = regionsFor()
  for (let iter = 0; iter < FIT_PASSES; iter++) {
    let bumped = false
    for (const r of present) {
      if (!fill(r, regions.get(r) as Box).fits) {
        shares.set(r, (shares.get(r) as number) * FIT_RAISE)
        bumped = true
      }
    }
    if (!bumped) break
    regions = regionsFor()
  }
  const placed: Placed[] = []
  let holds = true
  for (const r of present) {
    const { boxes, list, fits } = fill(r, regions.get(r) as Box)
    if (!fits) holds = false
    const tierOf = new Map(list.map((l) => [l.id, l.tier]))
    for (const b of boxes) placed.push({ ...inset(b, opt.gap / 2), id: b.id, tier: tierOf.get(b.id) as Tier })
  }
  return { placed, holds }
}

/** Can an even grid of minimum-size cells fit this region? */
function canHold(region: Box, n: number, cell: { w: number; h: number }): boolean {
  const cols = Math.floor(region.w / cell.w)
  if (cols < 1 || region.h < cell.h) return false
  return Math.ceil(n / Math.min(cols, n)) * cell.h <= region.h
}

function evenGrid(ids: string[], region: Box, cell: { w: number; h: number }): Array<Box & { id: string }> {
  // as few rows as the width allows, then as few columns as those rows need: six tiles in a wide box are three by two, not five and one
  const widest = Math.max(1, Math.min(ids.length, Math.floor(region.w / cell.w)))
  const rows = Math.ceil(ids.length / widest)
  const cols = Math.max(1, Math.ceil(ids.length / rows))
  const w = region.w / cols
  const h = region.h / rows
  return ids.map((id, i) => ({ id, x: region.x + (i % cols) * w, y: region.y + Math.floor(i / cols) * h, w, h }))
}

/**
 * A weighted treemap makes light tiles very small. Lift every weight to the one that gives a tile its minimum
 * area, and repeat, because lifting some weights shrinks the share of the rest.
 */
function floorWeights(items: Weighted[], region: Box, minArea: number): Weighted[] {
  const regionArea = region.w * region.h
  if (items.length === 0 || regionArea <= 0 || minArea * items.length > regionArea) return items
  let out = items
  for (let i = 0; i < 8; i++) {
    const total = out.reduce((s, x) => s + x.weight, 0)
    const floor = (minArea / regionArea) * total
    const next = out.map((x) => ({ id: x.id, weight: Math.max(x.weight, floor) }))
    if (next.every((x, k) => Math.abs(x.weight - out[k].weight) < 1e-9)) break
    out = next
  }
  return out
}

function inset(b: Box, by: number): Box {
  const w = Math.max(0, b.w - by * 2)
  const h = Math.max(0, b.h - by * 2)
  return { x: b.x + by, y: b.y + by, w, h }
}

interface Weighted {
  id: string
  weight: number
}

/** Bruls et al. squarify over an already ordered list. Returns one box per item. */
export function squarify(items: Weighted[], rect: Box): Array<Box & { id: string }> {
  const sum = items.reduce((s, i) => s + i.weight, 0)
  if (sum <= 0 || items.length === 0) return []
  const scale = (rect.w * rect.h) / sum
  const areas = items.map((i) => ({ id: i.id, area: i.weight * scale }))
  const out: Array<Box & { id: string }> = []
  let free: Box = { ...rect }
  let row: typeof areas = []
  let idx = 0

  const worst = (r: typeof areas, side: number): number => {
    const s = r.reduce((a, b) => a + b.area, 0)
    const max = Math.max(...r.map((x) => x.area))
    const min = Math.min(...r.map((x) => x.area))
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min))
  }
  const flush = (): void => {
    if (row.length === 0) return
    const s = row.reduce((a, b) => a + b.area, 0)
    if (free.w >= free.h) {
      const w = s / free.h
      let y = free.y
      for (const r of row) {
        const h = r.area / w
        out.push({ id: r.id, x: free.x, y, w, h })
        y += h
      }
      free = { x: free.x + w, y: free.y, w: free.w - w, h: free.h }
    } else {
      const h = s / free.w
      let x = free.x
      for (const r of row) {
        const w = r.area / h
        out.push({ id: r.id, x, y: free.y, w, h })
        x += w
      }
      free = { x: free.x, y: free.y + h, w: free.w, h: free.h - h }
    }
    row = []
  }

  while (idx < areas.length) {
    const side = Math.min(free.w, free.h)
    const next = areas[idx]
    if (row.length === 0 || worst([...row, next], side) <= worst(row, side)) {
      row.push(next)
      idx++
    } else flush()
  }
  flush()
  return out
}
