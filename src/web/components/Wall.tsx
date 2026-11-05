import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Attention, Incident, Park, RuleCell, ServiceHealth, Severity, SourceKind, Tier, WallState } from '../../shared/types.ts'
import { instanceLabels, rankOf, worstFirst } from '../../shared/evidence-links.ts'
import { incidentState, incidentTitle, isParked, quietWeight } from '../../shared/incident.ts'
import { groupHeadId, healthySpan, incidentGroupOrder, layoutWall, PARKED_GROUP, wallHeight } from '../../shared/layout.ts'
import type { TierRule } from '../../shared/layout.ts'
import { titleHolds } from '../../shared/title-room.ts'
import { groupLookup, groupsInOrder } from '../../shared/wall-groups.ts'
import type { GroupRef } from '../../shared/wall-groups.ts'
import { tileStory } from '../../shared/story.ts'
import type { CrumbPart } from '../../shared/story.ts'
import type { Placed } from '../../shared/layout.ts'
import { sourceKinds, splitCells } from '../lib/cells.ts'
import type { CellSplit } from '../lib/cells.ts'
import { clockText, parkStampText, sinceText } from '../lib/format.ts'
import { receiverWords, statusWords } from '../lib/receivers.ts'
import { href } from '../lib/route.ts'
import { useGrouped } from '../lib/wall-prefs.ts'
import { ackedLine, ackedParts, attendedRank, heroOf, isAcked, parkedDetail, parkedLine, parkedParts, silencedLine, silencedParts } from '../lib/ack.ts'
import { acknowledge, silence } from '../lib/act.ts'
import { holdPageHeight } from '../lib/hold-page.ts'
import { readMeters } from '../lib/title-measure.ts'
import type { Meters, TitleStyle } from '../lib/title-measure.ts'
import { Cells, FitTitle, Glyph, HostBadge, ParkedGlyph, SEVERITY_TEXT, jointed } from './ui.tsx'
import { ReferenceButton, referenceDrag, useReferenceable } from './Reference.tsx'

type Kinds = Readonly<Record<string, SourceKind>>

/** What a proof-of-watch strip gives up, in order, when its tile is too short for it: its count, then its cells for one line ("23 not ok"). */
const STRIP_FIT = ['bare', 'text'] as const

export type Group = 'service' | 'host'

/** The heading level of a tile's title: h3 under a group's h2 (or the healthy cells' own h2) when the wall has headings, h2 when it has none. */
type Level = 'h2' | 'h3'

/** What a By service wall with its category headings draws, in reading order: a group's heading with its incident counts, the healthy cells' own (screen reader only) heading, or a tile. */
export type Entry =
  | { kind: 'head'; group: GroupRef; counts: GroupCounts }
  | { kind: 'cells'; count: number }
  | { kind: 'tile'; tile: Tile }

/** What a group's heading says about its incidents: how many fire, and how many of those someone has acknowledged or silenced. The Parked section's heading has only `parked`. */
export interface GroupCounts {
  firing: number
  acknowledged: number
  silenced: number
  /** The incidents in the Parked section: set only on its heading, where it is the whole of what the heading says. */
  parked?: number
}

export interface Tile {
  id: string
  tier: Tier
  R: number
  kind: 'incident' | 'service' | 'host'
  /** A healthy service with a rule that is not ok: its cell leads the healthy ones, in a bolder name. */
  look?: boolean
  /** The dots a healthy service draws: its rules that are not ok. The tier rule gives a cell with more than one column holds a second column. */
  marks?: number
  /** What an incident or host tile calls itself, the text its title holds whole: the layout sizes the tile to it. */
  title?: string
  /** Someone has it (acknowledged): the tile follows the unattended ones of its tier. */
  attended?: boolean
  /** Epoch ms the park of a parked incident ends: the tile is in the Parked section, soonest end first. Absent on every tile that is live. */
  parkedUntil?: number
  /** The wall group an incident's service is filed under (config `wallGroups`): the incident sits in that group's section and its tile names it. Absent on a healthy cell and on the By host wall. */
  wallGroup?: GroupRef
  incident?: Incident
  health?: ServiceHealth
  host?: HostGroup
}

interface HostGroup {
  name: string
  incidents: Incident[]
  alerts: number
  severity: Severity
  startsAt: string
  attention: Attention
  state: ReturnType<typeof incidentState>
}

/** `cell` is a healthy service (name, dots, summary), `compact` a warning, `lg` an unattended page and `md` an acknowledged one (docs/design.md, The wall). */
type Size = 'md' | 'lg' | 'cell' | 'compact'

interface Metrics {
  gap: number
  firingMin: { w: number; h: number }
  quietMin: { w: number; h: number }
  /** The tier rule's numbers (shared/layout.ts): the cell, what it draws, and the footprint of each severity. */
  tier: TierRule
  /** The rows around a page's title (its padding, badge row, caption and the larger tile's extras): the title's own width is the tile less `chromeW`. */
  room: { chromeW: number; chromeH: number; lineH: number }
  /** How many title lines a page shows. */
  lines: number
  /** The tallest an unattended page tile is on a stacked wall (a phone, a chat app's side panel): a share of the visible height, never under its floor. */
  stackPageMaxH: number
  /** What the roomy page tile needs: a cap under it makes the stacked wall dense (the age on one row with its word, two title lines, the cells at their own height). */
  stackPageRoomyH: number
  meters: Meters
  /** The two lines that say who has an acknowledged or silenced incident and since when. */
  ackH: number
  /** What a large tile adds under its title (the age and the footer). */
  lgExtraH: number
  stack: boolean
  /** The phone breakpoint as a width: a wall narrower than this is stacked, whatever the window is (a window at 200% zoom is 720 px wide, and its wall less than 500). */
  phoneW: number
}

/** Resolve a token-derived CSS length (a calc of other tokens) to pixels, so no design number lives in code. */
function readPx(name: string): number {
  const probe = document.createElement('div')
  probe.style.cssText = `position:absolute;visibility:hidden;width:var(${name});height:0`
  document.body.appendChild(probe)
  const px = probe.getBoundingClientRect().width
  probe.remove()
  return px
}

/** A unitless token (a count of lines, of incidents). */
function readCount(name: string): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name))
}

function readMetrics(): Metrics {
  const quietMin = { w: readPx('--wall-quiet-min-w'), h: readPx('--wall-quiet-min-h') }
  return {
    gap: readPx('--wall-gap'),
    firingMin: { w: readPx('--wall-firing-min-w'), h: readPx('--wall-firing-min-h') },
    quietMin,
    tier: {
      cell: { w: readPx('--wall-cell-min-w'), h: readPx('--wall-cell-min-h') },
      cellMaxH: readPx('--wall-cell-max-h'),
      chromeW: readPx('--wall-cell-chrome-w'),
      dotW: readPx('--wall-cell-dot-w'),
      okW: readPx('--wall-cell-ok-w'),
      dotRows: readCount('--wall-cell-dot-rows'),
      maxSpan: readCount('--wall-cell-max-span'),
      warning: { cols: readCount('--wall-warning-cols'), rows: readCount('--wall-warning-rows') },
      page: { rows: readCount('--wall-page-rows'), rowsAttended: readCount('--wall-page-rows-attended'), share: readCount('--wall-page-share'), minCols: readCount('--wall-page-min-cols') },
      head: readPx('--wall-group-head-h')
    },
    room: { chromeW: readPx('--wall-title-chrome-w'), chromeH: readPx('--wall-title-chrome-h'), lineH: readPx('--text-title--line-height') },
    lines: readCount('--wall-title-lines'),
    stackPageMaxH: readPx('--stack-page-max-h'),
    stackPageRoomyH: readPx('--stack-page-roomy-h'),
    meters: readMeters(),
    ackH: readPx('--wall-ack-h'),
    lgExtraH: readPx('--wall-lg-extra-h'),
    stack: getComputedStyle(document.documentElement).getPropertyValue('--wall-stack').trim() === '1',
    phoneW: readPx('--bp-phone')
  }
}

/** When a park ends, as the epoch ms the layout and the order read; undefined for an incident that is live. */
const parkEndMs = (park: Park | null): number | undefined => (park ? Date.parse(park.until) : undefined)

function buildTiles(state: WallState, group: Group, nowMs: number): Tile[] {
  const tiles: Tile[] = []
  // By service the wall files every service under a category (config `wallGroups`); By host it stays as it was
  const filed = group === 'service' && state.wallGroups ? groupLookup(state.wallGroups) : null
  if (group === 'service') {
    // Every incident tile, a page, a warning, an acked or a silenced one, is sized to hold its own title (the layout reads `title`).
    for (const i of state.incidents) {
      const title = tileStory(worstFirst(i.alerts, rankOf), { rule: i.rule, instance: i.instance }).headline
      tiles.push({ id: `i:${i.key}`, tier: i.state.tier, R: i.state.R, kind: 'incident', incident: i, attended: isAcked(i), parkedUntil: parkEndMs(i.state.park), title, wallGroup: filed?.(i.service) })
    }
  } else {
    // a host's parked incidents are a tile of their own, in the Parked section: they never make the host's live tile louder or older
    const byHost = new Map<string, { name: string; parked: boolean; incidents: Incident[] }>()
    for (const i of state.incidents) {
      for (const h of new Set(i.alerts.map((a) => a.host || 'No host label'))) {
        const parked = isParked(i)
        const entry = byHost.get(`${parked ? 'parked' : 'live'}:${h}`) ?? { name: h, parked, incidents: [] }
        entry.incidents.push(i)
        byHost.set(`${parked ? 'parked' : 'live'}:${h}`, entry)
      }
    }
    for (const { name, parked, incidents } of byHost.values()) {
      const alerts = incidents.flatMap((i) => i.alerts.filter((a) => (a.host || 'No host label') === name))
      const severity = alerts.some((a) => a.severity === 'page') ? 'page' : alerts.some((a) => a.severity === 'warning') ? 'warning' : 'info'
      const startsAt = alerts.reduce((m, a) => (a.startsAt < m ? a.startsAt : m), alerts[0].startsAt)
      const acked = incidents.every((i) => i.state.attention === 'acked')
      const silenced = incidents.every((i) => i.state.attention === 'silenced')
      // the park that ends first speaks for a parked host tile, read from the incidents' own states (the state function decided each of them)
      const park = parked ? incidents.map((i) => i.state.park).filter((p): p is Park => p !== null).sort((a, b) => (a.until < b.until ? -1 : 1))[0] ?? null : null
      const st = incidentState({
        severity,
        instances: alerts.length,
        startsAtMs: Date.parse(startsAt),
        nowMs,
        ackedAtMs: acked ? nowMs : null,
        silencedUntilMs: silenced ? nowMs + 1 : null,
        park
      })
      const group: HostGroup = { name, incidents, alerts: alerts.length, severity, startsAt, attention: st.attention, state: st }
      tiles.push({ id: `${parked ? 'hp' : 'h'}:${name}`, tier: st.tier, R: st.R, kind: 'host', host: group, attended: st.attention === 'acked', parkedUntil: parkEndMs(st.park), title: name })
    }
  }
  const firingServices = new Set(state.incidents.map((i) => i.service))
  for (const s of state.health) {
    if (firingServices.has(s.service) && group === 'service') continue
    const open = splitCells(s.cells).open.length
    tiles.push({ id: `s:${s.service}`, tier: 'quiet', R: quietWeight(s.cells.length), kind: 'service', health: s, look: open > 0, marks: open })
  }
  return tiles
}

export function Wall({
  state,
  nowMs,
  group,
  onReload
}: {
  state: WallState
  nowMs: number
  group: Group
  onReload: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  // `box` is the room the page gives the wall: its width, and the height it has before it grows to hold its tiles (below), so the wall
  // never measures its own growth and can shrink back.
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [active, setActive] = useState<string | null>(null)

  useLayoutEffect(() => {
    const el = hostRef.current
    if (!el) return
    const measure = (): void => {
      const grown = el.style.minHeight
      // The page is held at its height for the read (lib/hold-page.ts): a wall taller than the room is what makes it scroll, and a page that is as
      // short as the room for that moment has its scroll position clamped and kept.
      const next = holdPageHeight(document.documentElement, () => {
        el.style.minHeight = ''
        const room = { w: el.clientWidth, h: el.clientHeight }
        el.style.minHeight = grown
        return room
      })
      setBox((prev) => (prev.w === next.w && prev.h === next.h ? prev : next))
      setMetrics(readMetrics())
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Stacked when the window is a phone's or the wall itself is narrower than a phone: the treemap cannot give every tile its minimum in a
  // box that small, and a tile squeezed to a badge hides what it is (found at 200% browser zoom). Width only: a stacked wall grows taller,
  // so its height can never be what decides.
  const stack = !!metrics && (metrics.stack || (box.w > 0 && box.w < metrics.phoneW))
  // The Group toggle (lib/wall-prefs.ts): the incidents sit in a section per category under a heading, the healthy cells stay one grid. Off, or on the By host wall, the
  // incident band is flat as it was before there were groups (a tile still names its group). The panel, which draws no toolbar, follows the stored choice.
  const [groupOn] = useGrouped()
  const grouped = groupOn && group === 'service' && !!state.wallGroups && state.incidents.length > 0
  // a stacked wall whose page cap is under what the roomy page needs (a panel under about 760 px tall) goes dense (wall.css, "The dense page")
  const dense = stack && !!metrics && metrics.stackPageMaxH < metrics.stackPageRoomyH
  const tiles = useMemo(() => buildTiles(state, group, nowMs), [state, group, nowMs])
  // a rule cell names the source that read it, not its kind: the words of a cell's state depend on the kind
  const kinds = useMemo(() => sourceKinds(state.sources), [state.sources])

  // The wall is the tier rule's grid (shared/layout.ts): a page, a warning and a healthy service each take the footprint of their severity, so a short wall
  // holds warnings that are compact and healthy cells that keep their dots and summary, and a wall with nothing firing is the cells alone. When the room the
  // page gives is too small, the wall grows and the page scrolls.
  const items = useMemo(() => tiles.map((t) => ({ id: t.id, tier: t.tier, R: t.R, attended: t.attended, firing: t.kind !== 'service', look: t.look, marks: t.marks, group: t.wallGroup?.id, parkedUntil: t.parkedUntil })), [tiles])
  // the group ids in the config's order: the incident sections run worst first and take the config's order between groups of one severity
  const groupIds = useMemo(() => (grouped ? groupsInOrder(state.wallGroups).map((g) => g.id) : null), [grouped, state.wallGroups])
  const laid = useMemo(() => {
    if (!metrics || stack || box.w === 0) return { placed: new Map<string, Placed>(), height: box.h }
    const opt = { width: box.w, height: box.h, gap: metrics.gap, firingMin: metrics.firingMin, quietMin: metrics.quietMin, tier: metrics.tier, groups: groupIds ?? undefined }
    const height = wallHeight(items, opt)
    return { placed: new Map(layoutWall(items, { ...opt, height }).map((p) => [p.id, p])), height }
  }, [items, metrics, box, stack, groupIds])
  const placed = laid.placed
  useLayoutEffect(() => {
    const el = hostRef.current
    if (el) el.style.minHeight = !stack && laid.height > box.h ? `${laid.height}px` : ''
  }, [laid.height, box.h, stack])

  // The dominant tile gets the display treatment: the largest page tile, or the largest warning when none pages.
  const leadId = useMemo(() => {
    const firing = tiles.filter((t) => t.tier !== 'quiet' || (t.kind !== 'service' && t.R > 1))
    const best = firing.sort((a, b) => b.R - a.R || (a.id < b.id ? -1 : 1))[0]
    return best && best.tier !== 'quiet' ? best.id : null
  }, [tiles])

  // Firing before healthy inside the quiet tier too: a silenced incident follows the unattended ones and comes before the healthy services.
  const order = useMemo(
    () =>
      [...tiles].sort(
        (a, b) =>
          tierRank(a.tier) - tierRank(b.tier) ||
          Number(a.kind === 'service') - Number(b.kind === 'service') ||
          parkRank(a, b) ||
          attendedRank(a.attended ? 'acked' : 'none') - attendedRank(b.attended ? 'acked' : 'none') ||
          b.R - a.R ||
          (a.id < b.id ? -1 : 1)
      ),
    [tiles]
  )

  // The reading order of a wall with its category headings: each group's heading and its incidents (the worst group first), then the healthy cells, one grid, in the order the
  // layout gives them. Tab, the screen reader and the arrow keys all read the page in this order, so a heading is met before the tiles it holds.
  const entries = useMemo<Entry[]>(() => {
    if (!groupIds) return flatEntries(stack ? order : tiles, stack)
    return wallEntries(order, incidentGroupOrder(items, groupIds), groupsInOrder(state.wallGroups))
  }, [groupIds, stack, order, tiles, items, state.wallGroups])
  const reading = useMemo(() => entries.flatMap((e) => (e.kind === 'tile' ? [e.tile] : [])), [entries])

  useEffect(() => {
    if (reading.length && (!active || !reading.some((t) => t.id === active))) setActive(reading[0].id)
  }, [reading, active])

  const move = useCallback(
    (dir: 'left' | 'right' | 'up' | 'down') => {
      const root = hostRef.current
      if (!root || !active) return
      const els = [...root.querySelectorAll<HTMLElement>('[data-tile-id]')]
      const cur = els.find((e) => e.dataset.tileId === active)
      if (!cur) return
      // Left and Right read the grouped wall in its reading order (the page's own order), so they cross from a row to the next and from a group to the next group
      if (grouped && (dir === 'left' || dir === 'right')) {
        const next = els[els.indexOf(cur) + (dir === 'right' ? 1 : -1)]
        if (next) {
          setActive(next.dataset.tileId ?? null)
          next.querySelector<HTMLElement>('.tile__open')?.focus()
        }
        return
      }
      const c = cur.getBoundingClientRect()
      const cx = c.left + c.width / 2
      const cy = c.top + c.height / 2
      // On the grouped wall Up and Down go to the next row above or below (the nearest edge, whichever group it is in), then to the tile in it nearest across, so a press
      // never skips a row: from the last row of one group the next press is the first row of the next group, however wide the tiles of that row are
      if (grouped) {
        const down = dir === 'down'
        const pool = els
          .filter((el) => el !== cur)
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ r }) => (down ? r.top >= c.bottom - 1 : r.bottom <= c.top + 1))
        if (pool.length === 0) return
        const edge = (x: { r: DOMRect }): number => (down ? x.r.top : x.r.bottom)
        const near = down ? Math.min(...pool.map(edge)) : Math.max(...pool.map(edge))
        const row = pool.filter((x) => Math.abs(edge(x) - near) < 1)
        const across = (x: { r: DOMRect }): number => Math.abs(x.r.left + x.r.width / 2 - cx)
        const target = row.reduce((a, b) => (across(b) < across(a) ? b : a)).el
        setActive(target.dataset.tileId ?? null)
        target.querySelector<HTMLElement>('.tile__open')?.focus()
        return
      }
      let best: { el: HTMLElement; score: number } | null = null
      for (const el of els) {
        if (el === cur) continue
        const r = el.getBoundingClientRect()
        const dx = r.left + r.width / 2 - cx
        const dy = r.top + r.height / 2 - cy
        const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy
        if (along <= 0) continue
        const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx)
        const score = along + across * 2
        if (!best || score < best.score) best = { el, score }
      }
      const target = best?.el
      if (target) {
        setActive(target.dataset.tileId ?? null)
        target.querySelector<HTMLElement>('.tile__open')?.focus()
      }
    },
    [active, grouped]
  )

  // The press only asks; acknowledge() names who (a prompt the first time) and queues the request behind the settle seam.
  const ack = useCallback(
    async (key: string) => {
      await acknowledge(key)
      onReload()
    },
    [onReload]
  )

  const onKey = (e: KeyboardEvent<HTMLUListElement>): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const map: Record<string, 'left' | 'right' | 'up' | 'down'> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }
    if (map[e.key]) {
      e.preventDefault()
      move(map[e.key])
      return
    }
    const t = tiles.find((x) => x.id === active)
    if (e.key === 'a' && t?.incident) void ack(t.incident.key)
    if (e.key === 's' && t?.incident) void silence(t.incident.key, 60).then(onReload)
  }

  // a stacked column is 2 wide: a healthy cell with more dots than a half-width cell holds takes the whole row
  const stackCol = metrics ? (box.w - metrics.gap) / 2 : 0

  return (
    <div className="wall-host" ref={hostRef}>
      <ul className="wall" data-stack={stack ? 'true' : undefined} data-dense={dense ? 'true' : undefined} data-grouped={grouped ? 'true' : undefined} onKeyDown={onKey} aria-label="Alert wall">
        {entries.map((e) => {
          if (e.kind === 'cells') {
            // the healthy cells are one grid with no heading of their own on the page; a screen reader still gets one, so the tiles' h3 titles sit under an h2
            return (
              <li key="cells" className="sr-only">
                <h2>{`Healthy services, ${e.count}`}</h2>
              </li>
            )
          }
          if (e.kind === 'head') {
            const hp = placed.get(groupHeadId(e.group.id))
            if (!stack && !hp) return null
            return <GroupHead key={`head:${e.group.id}`} group={e.group} counts={e.counts} style={stack || !hp ? undefined : { transform: `translate(${hp.x}px, ${hp.y}px)`, width: hp.w, height: hp.h }} />
          }
          const t = e.tile
          const p = placed.get(t.id)
          if (!stack && !p) return null
          let size: Size = tileSize(t, stack)
          // a large tile shows the age and a footer under its title, which are never shed: a tile whose title leaves them no room stays medium
          if (!stack && size === 'lg' && metrics && t.title !== undefined) {
            const m = metrics
            const holds = titleHolds(t.title, { w: p?.w ?? 0, h: p?.h ?? 0 }, { measure: m.meters.measure.title, lineH: m.meters.lineH.title }, { chromeW: m.room.chromeW, chromeH: m.room.chromeH + m.lgExtraH }, m.lines)
            if (!holds) size = 'md'
          }
          // a healthy cell with more dots than one column holds takes a wider cell: on the grid the rule's footprint, on a phone the whole row
          const wide = stack && metrics && t.kind === 'service' ? healthySpan(t.marks ?? 0, stackCol, metrics.gap, metrics.tier) > 1 : false
          const style = stack || !p ? undefined : { transform: `translate(${p.x}px, ${p.y}px)`, width: p.w, height: p.h }
          // a stacked page is at most --stack-page-max-h tall (a share of the visible height), so its title stays at the title step (wall.css clamps it to
          // --stack-page-title-lines lines; the whole text is the link's name and its hover title); every other tile sets its title in the largest size that holds
          const room = stack ? { w: box.w, h: Number.POSITIVE_INFINITY } : { w: p?.w ?? 0, h: p?.h ?? 0 }
          const titleStyle = metrics && !(stack && t.tier === 'page') ? titleStyleOf(t, t.id === leadId, size, room, metrics, metrics.lines) : 'title'
          return (
            <TileView
              key={t.id}
              tile={t}
              size={size}
              wide={wide}
              style={style}
              nowMs={nowMs}
              kinds={kinds}
              titleStyle={titleStyle}
              level={grouped || t.parkedUntil !== undefined ? 'h3' : 'h2'}
              active={t.id === active}
              onFocus={() => setActive(t.id)}
              onAck={ack}
            />
          )
        })}
      </ul>
    </div>
  )
}

/** What a group's heading says besides its name: how many of its incidents fire, and of those how many someone has acknowledged or silenced ("3 firing, 1 acknowledged"). */
export function groupCountText(c: GroupCounts): string {
  // the Parked section's heading: how many wait, and nothing about firing, which they are not
  if (c.parked !== undefined) return `${c.parked} waiting`
  const parts = [`${c.firing} firing`]
  if (c.acknowledged > 0) parts.push(`${c.acknowledged} acknowledged`)
  if (c.silenced > 0) parts.push(`${c.silenced} silenced`)
  return parts.join(', ')
}

/**
 * The entries of a wall with its category headings, in reading order (`order` is the wall's own order, incidents first): for each group that has an incident, in the order
 * the sections run, its heading with its counts and its incidents; then the healthy cells, one grid, the ones that need a look first, then heaviest, then by name, the order
 * the layout gives them, under a heading only a screen reader meets. Pure: `groups` names the groups' labels.
 */
export function wallEntries(order: Tile[], sections: readonly string[], groups: readonly GroupRef[]): Entry[] {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const incidents = order.filter((t) => t.kind !== 'service')
  // a parked incident is in no group's section: the parked ones follow the last section, soonest end first, under a heading of their own
  const live = incidents.filter((t) => t.parkedUntil === undefined)
  const parked = incidents.filter((t) => t.parkedUntil !== undefined).sort(byParkEnd)
  const out: Entry[] = []
  for (const id of sections) {
    const mine = live.filter((t) => (t.wallGroup?.id ?? '') === id)
    if (mine.length === 0) continue
    const group = byId.get(id) ?? { id, label: id, order: groups.length }
    const attention = (t: Tile): string | undefined => t.incident?.state.attention
    out.push({ kind: 'head', group, counts: { firing: mine.length, acknowledged: mine.filter((t) => attention(t) === 'acked').length, silenced: mine.filter((t) => attention(t) === 'silenced').length } })
    for (const tile of mine) out.push({ kind: 'tile', tile })
  }
  out.push(...parkedEntries(parked))
  const cells = order.filter((t) => t.kind === 'service').sort((a, b) => Number(!!b.look) - Number(!!a.look) || b.R - a.R || (a.id < b.id ? -1 : 1))
  if (cells.length > 0) out.push({ kind: 'cells', count: cells.length })
  for (const tile of cells) out.push({ kind: 'tile', tile })
  return out
}

/** A live tile before a parked one, and a parked tile before one whose park ends later; 0 between two live tiles, so the rest of the wall's order decides. */
const parkRank = (a: Tile, b: Tile): number => (a.parkedUntil ?? 0) - (b.parkedUntil ?? 0)

/** The parked tiles in the order their section shows them: the park that ends first, then id. */
const byParkEnd = (a: Tile, b: Tile): number => parkRank(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The Parked section: its heading (the same row of the grid as a group's) and its tiles, or nothing when none is parked. `parked` is already in section order. */
function parkedEntries(parked: Tile[]): Entry[] {
  if (parked.length === 0) return []
  const group: GroupRef = { id: PARKED_GROUP.id, label: PARKED_GROUP.label, order: Number.MAX_SAFE_INTEGER }
  return [{ kind: 'head', group, counts: { firing: 0, acknowledged: 0, silenced: 0, parked: parked.length } }, ...parked.map((tile) => ({ kind: 'tile' as const, tile }))]
}

/**
 * The entries of a wall with no category headings (the Group toggle off, the By host wall, a phone's stack): the tiles as given, except that the parked ones leave
 * their place for a section of their own under a Parked heading, soonest end first. On the grid that section is the last thing on the wall, under the cells; on the
 * phone's stack (`beforeCells`, the list already has the incidents first) it follows the last incident and comes before the healthy cells.
 */
export function flatEntries(list: Tile[], beforeCells: boolean): Entry[] {
  const parked = list.filter((t) => t.parkedUntil !== undefined).sort(byParkEnd)
  const rest = list.filter((t) => t.parkedUntil === undefined)
  const firstCell = rest.findIndex((t) => t.kind === 'service')
  const cut = beforeCells && firstCell >= 0 ? firstCell : rest.length
  const tile = (t: Tile): Entry => ({ kind: 'tile', tile: t })
  return [...rest.slice(0, cut).map(tile), ...parkedEntries(parked), ...rest.slice(cut).map(tile)]
}

/**
 * A group's heading: a full-width row of the grid (a heading is the grid's own row, not a card around the tiles under it), the group's name and, in the mono face, its
 * incident counts. A real h2, so a screen reader lists the groups and jumps between them; the tiles' titles are h3 under it.
 */
export function GroupHead({ group, counts, style }: { group: GroupRef; counts: GroupCounts; style: React.CSSProperties | undefined }) {
  return (
    <li className="wall__group" data-group={group.id} style={style}>
      <h2 className="wall__group-title">
        <span className="wall__group-label">{group.label}</span> <span className="wall__group-count">{groupCountText(counts)}</span>
      </h2>
    </li>
  )
}

/**
 * The presentation of one tile. The tier decides it: a page is large (medium once someone has it), a warning, acknowledged or silenced incident compact, a
 * healthy service a cell; the footprint (shared/layout.ts) already gave each its room.
 */
function tileSize(t: Tile, stack: boolean): Size {
  if (t.kind === 'service') return 'cell'
  if (t.tier !== 'page') return 'compact'
  return t.attended && !stack ? 'md' : 'lg'
}

const tierRank = (t: Tier): number => (t === 'page' ? 0 : t === 'warning' ? 1 : 2)

/**
 * The size an incident tile's title is set in: the display size for the lead tile, the headline size for any other page or warning tile
 * that is large, else the plain size. Each only when it holds the whole title in the tile (shared/title-room.ts `titleHolds`), so a bigger
 * face never costs a line of the title.
 */
function titleStyleOf(t: Tile, lead: boolean, size: Size, box: { w: number; h: number }, m: Metrics, lines: number): TitleStyle {
  if (t.title === undefined) return 'title'
  const wanted: TitleStyle[] = lead ? (size === 'lg' ? ['display', 'headline'] : []) : size === 'lg' && t.tier !== 'quiet' ? ['headline'] : []
  // the rows around the title: a large tile adds the age and the footer, an acknowledged or silenced one the lines that say who has it
  const told = t.incident !== undefined && t.incident.state.attention !== 'none'
  const room = { chromeW: m.room.chromeW, chromeH: m.room.chromeH + (size === 'lg' ? m.lgExtraH : 0) + (told ? m.ackH : 0) }
  const holds = (style: TitleStyle): boolean => titleHolds(t.title as string, box, { measure: m.meters.measure[style], lineH: m.meters.lineH[style] }, room, lines)
  return wanted.find(holds) ?? 'title'
}

/**
 * The tile footer's one line, written to fit the narrowest tile that shows a footer next to its Acknowledge button
 * (a 240 px tile leaves about 120 px, 20 characters of 12 px text): a sentence never spans two lines.
 * The reason, the latency and the next escalation step live in the drill-down and in the footer's `title`.
 */
function receiptText(i: Incident): string {
  // a parked incident is not paged, whatever it was sent before the park: the footer says what Watch does meanwhile
  if (i.state.attention === 'parked') return i.wallOnly ? 'No notifications' : 'Notifications paused'
  if (i.receipt) {
    const r = i.receipt
    const where = receiverWords(r.channel)
    if (r.ok) return `Sent to ${where} at ${clockText(r.at)}`
    // a send that was skipped, given up on or held back is not a failure of the receiver: the footer says which
    if (r.status.startsWith('coalesced into ')) return `In a summary at ${clockText(r.at)}`
    if (r.status.startsWith('skipped:')) return `Skipped: ${where} at ${clockText(r.at)}`
    if (r.status.startsWith('abandoned:')) return `Gave up: ${where} at ${clockText(r.at)}`
    return `Failed: ${where} at ${clockText(r.at)}`
  }
  if (i.wallOnly) return 'No notifications'
  if (i.heldUntil) return `Held until ${clockText(i.heldUntil)}`
  // the tile's own line says who and when; the footer says what Watch does meanwhile
  if (i.state.attention === 'acked') return 'Notifications paused'
  if (i.state.attention === 'silenced') return 'Silenced'
  return 'Notification pending'
}

/** The footer's full text, for the `title`: the receipt with its latency and the next escalation step. */
function receiptTitle(i: Incident): string {
  const parts = [receiptText(i)]
  if (i.state.attention === 'parked' && !i.wallOnly) parts[0] = 'Parked, no notifications until the park ends'
  else if (i.receipt?.ok) parts[0] = `${parts[0]}, ${(i.receipt.latencyMs / 1000).toFixed(1)} s`
  else if (i.receipt && i.receipt.status !== '') parts[0] = `${parts[0]}, ${statusWords(i.receipt.status)}`
  else if (!i.receipt && i.wallOnly) parts[0] = 'Wall only, no notifications'
  else if (!i.receipt && i.heldUntil) parts[0] = `Held until ${clockText(i.heldUntil)} for quiet hours`
  else if (!i.receipt && i.state.attention === 'silenced') parts[0] = 'Silenced, no notifications'
  if (i.nextStep && i.state.attention === 'none') parts.push(`Next: ${i.nextStep.channels.map(receiverWords).join(' and ')} at ${clockText(i.nextStep.at)} if nobody acts`)
  return parts.join('. ')
}

/**
 * Keep the footer whole. A tile is a fixed box, so when its content is taller than the box the optional rows are shed
 * whole, in order (the rows marked `data-shed`, the highest number first: the instance rows from the last, the rule
 * cells, the evidence line, the time since, the rule class, the breadcrumb), until the footer fits. Nothing is ever cut through a line, and the footer,
 * the age and the title are never shed. It runs after every render, so a resize,
 * a poll or a label change measures again from the full content.
 *
 * The proof-of-watch strip is shed in steps, not at once (`STRIP_FIT`): first its "N ok" count, then its cells for the one line that
 * counts them ("23 not ok"). A quiet service tile never sheds the strip whole, so it still says how many rules need a look; the rule list
 * of a large tile sheds its rows from the last, and its "N ok" row before any of them.
 */
function useFit(ref: React.RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !el.lastElementChild) return
    // the row that closes the tile as it stands: the last child that is drawn (a shed evidence line, or a caption whose parts are all shed, must not read as "fits")
    const lastShown = (): HTMLElement | undefined => ([...el.children] as HTMLElement[]).reverse().find((c) => !c.hidden && c.getClientRects().length > 0)
    // The breadcrumb is one line that sheds whole parts, the highest `data-shed-x` first, until it fits: a name is shown whole or not at all,
    // never clipped to its first letter. It sits beside the badge when at least one part fits there; when none does (a narrow tile) it takes
    // the next line and sheds from the full width instead.
    const where = el.querySelector<HTMLElement>('.tile__where')
    const crumbs = el.querySelector<HTMLElement>('.tile__crumbs')
    if (where && crumbs) {
      const tokens = [...crumbs.querySelectorAll<HTMLElement>('[data-shed-x]')].sort((a, b) => Number(b.dataset.shedX) - Number(a.dataset.shedX))
      const shedToFit = (): void => {
        for (const t of tokens) t.hidden = false
        for (const t of tokens) {
          if (crumbs.scrollWidth <= crumbs.clientWidth + 0.5) break
          t.hidden = true
        }
      }
      where.dataset.crumbs = 'inline'
      shedToFit()
      // a tile that names its group keeps the breadcrumb beside the badge (the group is the part that never sheds, so it is never pushed to a row of its own)
      if (tokens.length > 0 && tokens.every((t) => t.hidden) && !crumbs.querySelector('.tile__crumb--group')) {
        where.dataset.crumbs = 'below'
        shedToFit()
      }
    }
    // a host badge longer than the row it sits in is the one token that may wrap, and only between the parts of its own name
    const badge = el.querySelector<HTMLElement>('[data-badge]')
    const row = badge?.parentElement
    if (badge && row) {
      delete badge.dataset.wrap
      if (row.scrollWidth > row.clientWidth + 0.5) badge.dataset.wrap = 'true'
    }
    const parts = [...el.querySelectorAll<HTMLElement>('[data-shed]')].sort((a, b) => Number(b.dataset.shed) - Number(a.dataset.shed))
    const strip = el.querySelector<HTMLElement>('.cells[data-fit-strip]')
    if (strip) delete strip.dataset.fit
    // The instance list says how many rows it dropped: its last item is the "+N more" line, empty until a row is shed.
    // The rule list of a quiet service tile does the same for its non-ok rows; its "N ok" row is shed without being counted.
    const more = el.querySelector<HTMLElement>('[data-more]')
    const rows = new Set(el.querySelectorAll<HTMLElement>('.tile__instances > li[data-shed], .tile__rules > li[data-shed]:not([data-count])'))
    let dropped = Number(more?.dataset.more ?? 0)
    for (const p of parts) {
      p.hidden = false
      delete p.dataset.tight
    }
    if (more) more.hidden = dropped === 0
    // the footer may borrow half of the tile's bottom padding, never more: it stays whole and clear of the border
    const limit = el.clientHeight - parseFloat(getComputedStyle(el).paddingBottom) / 2
    const fits = (): boolean => {
      const last = lastShown()
      return !last || last.offsetTop + last.offsetHeight <= limit + 0.5
    }
    // a strip gives up its count, then its cells for one line, before it is shed whole (or, on a quiet service tile, ever)
    const shrinkStrip = (): void => {
      if (!strip) return
      for (const level of STRIP_FIT) {
        strip.dataset.fit = level
        if (fits()) return
      }
    }
    for (const p of parts) {
      if (fits()) break
      // the summary gives up a line before it gives up everything
      if (p.classList.contains('tile__summary')) {
        p.dataset.tight = 'true'
        if (fits()) break
      }
      if (p === strip) {
        shrinkStrip()
        if (fits()) break
      }
      p.hidden = true
      if (more && rows.has(p)) {
        dropped += 1
        more.textContent = `+${dropped} more`
        // a "+N more" with no row above it says nothing (the count badge already does) and must not take room the next check measures
        more.hidden = [...rows].every((r) => r.hidden)
      }
    }
    // a "+N more" with no row above it says nothing: the count badge already does
    if (more && [...rows].every((r) => r.hidden)) more.hidden = true
    // the strip of a quiet service tile is never shed, so once every optional row is gone it shrinks as far as it must
    if (strip && !strip.hasAttribute('data-shed') && !fits()) shrinkStrip()
  })
}

function TileView({
  tile,
  size,
  wide,
  style,
  nowMs,
  kinds,
  titleStyle,
  level,
  active,
  onFocus,
  onAck
}: {
  tile: Tile
  size: Size
  wide: boolean
  style: React.CSSProperties | undefined
  nowMs: number
  kinds: Kinds
  titleStyle: TitleStyle
  level: Level
  active: boolean
  onFocus: () => void
  onAck: (key: string) => void
}) {
  if (tile.kind === 'service' && tile.health) return <ServiceTile tile={tile} health={tile.health} wide={wide} style={style} active={active} onFocus={onFocus} kinds={kinds} level={level} />
  if (tile.kind === 'host' && tile.host) return <HostTile tile={tile} host={tile.host} size={size} style={style} nowMs={nowMs} titleStyle={titleStyle} active={active} onFocus={onFocus} level={level} />
  return <IncidentTile tile={tile} i={tile.incident as Incident} size={size} style={style} nowMs={nowMs} kinds={kinds} titleStyle={titleStyle} level={level} active={active} onFocus={onFocus} onAck={onAck} />
}

/** The order a breadcrumb sheds its parts on a narrow tile: the system first, then the component, the service last. */
const CRUMB_SHED: Record<CrumbPart, number> = { system: 3, component: 2, service: 1 }

export function IncidentTile({
  tile,
  i,
  size,
  style,
  nowMs,
  kinds,
  titleStyle,
  level: Heading = 'h2',
  active,
  onFocus,
  onAck
}: {
  tile: Tile
  i: Incident
  size: Size
  style: React.CSSProperties | undefined
  nowMs: number
  kinds: Kinds
  titleStyle: TitleStyle
  level?: Level
  active: boolean
  onFocus: () => void
  onAck: (key: string) => void
}) {
  const ref = useRef<HTMLLIElement>(null)
  useFit(ref)
  const referenceable = useReferenceable()
  const n = i.state.instances
  const sev = SEVERITY_TEXT[i.severity]
  // The story is told by the worst instance (the same one the sheet's title names): a host badge and a breadcrumb that say
  // where it came from, the headline that says what broke, the rule class, and one line of proof.
  const alerts = useMemo(() => worstFirst(i.alerts, rankOf), [i.alerts])
  const story = useMemo(() => tileStory(alerts, { rule: i.rule, instance: i.instance }), [alerts, i.rule, i.instance])
  // One line per instance, named by host, instance, service, workload, summary, and only last by the alertname. A lone instance is
  // already the badge and the headline, so only a group is listed.
  const names = useMemo(() => instanceLabels(alerts, [i.rule]), [alerts, i.rule])
  const listed = n > 1
  const acked = isAcked(i)
  // The same one line says who has it: an acknowledgement by name and time, or a silence by name and end (and that it was set before this episode), or when a park ends and why.
  const park = i.state.park
  const told = acked ? ackedParts(i.ackedBy, i.ackedAt) : i.state.attention === 'silenced' && i.silencedUntil ? silencedParts(i.silencedBy, i.silencedUntil, i.silenceCarried) : park ? parkedParts(park) : null
  const ackText = told ? (acked ? ackedLine(i.ackedBy, i.ackedAt) : park ? parkedLine(park) : silencedLine(i.silencedBy, i.silencedUntil, i.silenceCarried)) : null
  const hero = heroOf(i, nowMs)
  const small = size === 'compact'
  // the group the wall files this incident's service under, named on the tile (the first part of its breadcrumb) and in its accessible name
  const group = tile.wallGroup?.label
  const where = [story.badge.text, ...story.crumbs.map((c) => c.text)].join(', ')
  const label = `${story.headline}${story.more > 0 ? ` and ${story.more} more` : ''}. ${where}.${group ? ` In ${group}.` : ''} ${i.rule}. ${sev}, ${n} ${n === 1 ? 'instance' : 'instances'}, ${sinceText(i.startsAt, nowMs)}${i.state.attention === 'acked' ? `. ${ackedLine(i.ackedBy, i.ackedAt)}` : (i.state.attention === 'silenced' || i.state.attention === 'parked') && ackText ? `. ${ackText}` : i.state.attention !== 'none' ? `, ${i.state.attention}` : ''}`
  return (
    <li
      ref={ref}
      className="tile"
      data-tile-id={tile.id}
      data-tier={tile.tier}
      data-band={i.state.band}
      data-attention={i.state.attention}
      data-size={size}
      data-title-style={titleStyle === 'title' ? undefined : titleStyle}
      style={style}
      {...(referenceable ? referenceDrag(i.key, story.headline) : {})}
    >
      <div className="tile__story">
        <div className="tile__where">
          {park ? <ParkedGlyph /> : <Glyph severity={acked ? null : i.severity} />}
          <HostBadge badge={story.badge} />
          {(story.crumbs.length > 0 || group) && (
            <span className="tile__crumbs" data-shed={group ? undefined : '5'}>
              {group && (
                <span className="tile__crumb tile__crumb--group" data-group={tile.wallGroup?.id} title={`Group: ${group}`}>
                  {group}
                </span>
              )}
              {story.crumbs.map((c) => (
                <span key={c.part} className="tile__crumb" data-shed-x={CRUMB_SHED[c.part]}>
                  {c.text}
                </span>
              ))}
            </span>
          )}
          <span className="tile__count" aria-hidden="true">{n}</span>
        </div>
        <Heading className="tile__title">
          <a className="tile__open" href={href({ incident: i.key })} tabIndex={active ? 0 : -1} aria-label={label} onFocus={onFocus}>
            <FitTitle text={story.headline} />
          </a>
        </Heading>
        {ackText && told && (
          <p className="tile__ack" title={park ? `${ackText}. ${parkedDetail(park)}` : ackText}>
            <span className="tile__ack-who">{told.who}</span>
            {told.when !== '' && <span className="tile__ack-when">{told.when}</span>}
          </p>
        )}
        <p className="tile__meta tile__caption" title={`${story.caption}, ${sinceText(i.startsAt, nowMs)}`}>
          <span className="tile__rule" data-shed="6">
            {jointed(story.caption)}
          </span>
          {(size !== 'lg' || acked) && !(small && told === null) && (
            <span className="tile__time" data-shed="7">
              {park?.since ? `Parked since ${parkStampText(park.since)}` : sinceText(i.startsAt, nowMs)}
            </span>
          )}
        </p>
        {park?.note ? (
          // a parked tile's proof line is the sender's own note on the park (it sheds first, like the line it replaces; the hover and the sheet always carry it)
          <p className="tile__summary tile__line" data-kind="note" data-shed="8" title={park.note}>
            {jointed(park.note)}
          </p>
        ) : (
          story.line && (
            <p className="tile__summary tile__line" data-kind={story.line.kind} data-shed="8" title={story.line.text}>
              {jointed(story.line.text)}
            </p>
          )
        )}
      </div>
      {size === 'lg' && listed && (
        <ul className="tile__instances" aria-label="Instances">
          {alerts.slice(0, 8).map((a, k) => (
            <li key={a.key} data-shed={10 + k} data-label={names[k].source} title={names[k].text}>
              <span>{names[k].text}</span>
              {a.value && <span>{a.value}</span>}
            </li>
          ))}
          <li className="tile__more" data-more={Math.max(0, alerts.length - 8)} hidden />
        </ul>
      )}
      {(size === 'md' || size === 'lg') && i.cells.length > 0 && <Cells cells={i.cells} kinds={kinds} shed="9" />}
      {small && told === null && (
        <p className="tile__hero tile__hero--small" data-shed="4">
          <span className="tile__age">{hero.value}</span>
          <span className="tile__age-label">{hero.label}</span>
        </p>
      )}
      {size === 'lg' && (
        <p className="tile__hero">
          <span className="tile__age">{hero.value}</span>
          <span className="tile__age-label">{hero.label}</span>
        </p>
      )}
      {(size === 'md' || size === 'lg' || small) && (
        <div className="tile__foot">
          <span className="tile__receipt" title={receiptTitle(i)}>
            {receiptText(i)}
          </span>
          <ReferenceButton incidentKey={i.key} title={story.headline} />
          {size === 'lg' && i.state.attention === 'none' && (
            <button type="button" className="btn" onClick={() => onAck(i.key)}>
              Acknowledge
            </button>
          )}
        </div>
      )}
    </li>
  )
}

/** The one line a service tile says about its rules, told the same way as its strip: how many need a look, or that all are evaluating. */
function serviceMeta(split: CellSplit, cells: RuleCell[]): string {
  const rules = `${cells.length} ${cells.length === 1 ? 'rule' : 'rules'}`
  if (cells.every((c) => c.state === 'inferred')) return `${rules} seen in the alert history`
  const bad = cells.filter((c) => c.state === 'error' || c.state === 'stale').length
  if (bad > 0) return `${bad} of ${rules} not answering`
  return split.open.length > 0 ? `${rules}, ${split.open.length} not ok` : `${rules} evaluating`
}

/**
 * A healthy service, one cell of the wall (the tier rule, shared/layout.ts): its name, then one proof-of-watch strip, a dot for every rule that is not ok and
 * one count for the rest ("All 70 ok", "107 ok"), so it reads at any rule count. `useFit` sheds what does not fit, whole: the count, then the dots for one line.
 */
export function ServiceTile({
  tile,
  health,
  wide = false,
  style,
  active,
  onFocus,
  kinds,
  level: Heading = 'h2'
}: {
  tile: Tile
  health: ServiceHealth
  wide?: boolean
  style: React.CSSProperties | undefined
  active: boolean
  onFocus: () => void
  kinds: Kinds
  level?: Level
}) {
  const ref = useRef<HTMLLIElement>(null)
  useFit(ref)
  const cells: RuleCell[] = health.cells
  const split = useMemo(() => splitCells(cells), [cells])
  const meta = serviceMeta(split, cells)
  // A cell (a healthy service on a wall that holds incidents): its name, then the dots and the summary it has always had (one dot for each rule that is not ok,
  // worst first, then "All 70 ok" or "107 ok"). One that needs a look keeps a stronger border and a bolder name, so it stands apart with no hue of its own.
  return (
    <li ref={ref} className="tile" data-tile-id={tile.id} data-tier="quiet" data-kind="service" data-size="cell" data-look={split.open.length > 0 ? 'true' : undefined} data-wide={wide ? 'true' : undefined} style={style}>
      <Heading className="tile__title">
        <a className="tile__open" href={href({ service: health.service })} tabIndex={active ? 0 : -1} aria-label={`${health.service}. ${meta}`} title={health.service} onFocus={onFocus}>
          <FitTitle text={health.service} />
        </a>
      </Heading>
      <Cells cells={cells} kinds={kinds} />
    </li>
  )
}

function HostTile({
  tile,
  host,
  size,
  style,
  nowMs,
  titleStyle,
  level: Heading = 'h2',
  active,
  onFocus
}: {
  tile: Tile
  host: HostGroup
  size: Size
  style: React.CSSProperties | undefined
  nowMs: number
  titleStyle: TitleStyle
  level?: Level
  active: boolean
  onFocus: () => void
}) {
  const rules = [...new Set(host.incidents.map((i) => i.rule))]
  const park = host.state.park
  const label = `${host.name}. ${SEVERITY_TEXT[host.severity]}, ${host.alerts} ${host.alerts === 1 ? 'instance' : 'instances'} across ${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}${park ? `. ${parkedLine(park)}` : ''}`
  return (
    <li
      className="tile"
      data-tile-id={tile.id}
      data-tier={tile.tier}
      data-band={host.state.band}
      data-attention={host.attention}
      data-size={size}
      data-title-style={titleStyle === 'title' ? undefined : titleStyle}
      style={style}
    >
      <div className="tile__head">
        {park ? <ParkedGlyph /> : <Glyph severity={host.attention === 'acked' ? null : host.severity} />}
        <Heading className="tile__title">
          <a className="tile__open" href={href({ host: host.name })} tabIndex={active ? 0 : -1} aria-label={label} onFocus={onFocus}>
            <FitTitle text={host.name} />
          </a>
        </Heading>
        <span className="tile__count" aria-hidden="true">{host.alerts}</span>
      </div>
      {park && (
        <p className="tile__ack" title={`${parkedLine(park)}. ${parkedDetail(park)}`}>
          <span className="tile__ack-who">{parkedParts(park).who}</span>
          <span className="tile__ack-when">{parkedParts(park).when}</span>
        </p>
      )}
      <p className="tile__meta">{`${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}, ${sinceText(host.startsAt, nowMs)}`}</p>
      {size === 'lg' && (
        <ul className="tile__instances" aria-label="Rules firing on this host">
          {rules.slice(0, 4).map((r) => (
            <li key={r}>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}
