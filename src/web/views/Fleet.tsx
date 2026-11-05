// The Fleet page: one row per server with its CPU and memory now and as a 60 minute sparkline, its load, its fullest disk (used %, what is free, a
// 60 minute sparkline, and one line under the row for each other mount that matters) and Netdata page, grouped Servers and Watch only. It reads
// GET /api/fleet (src/shared/fleet.ts) at the feed's own pollSec. Only a hot or warm row, or a warm or hot disk cell, takes colour; every
// other row and cell is neutral. A press only acknowledges itself: a column header marks itself sorted at once and the rows reorder behind the settle
// seam (lib/settle.ts), the re-check is the wall's own control (lib/use-recheck.ts), unchanged.
// In the chat panel (EmbedContext, views/Embed.tsx) it is the same page, set in the frame: its title is the second heading (the frame's own
// "EZO Watcher" is the first), a firing rule opens its incident over the wall (the frame's sheet says "Back to wall" and means it), a row that
// stacks puts a figure's name beside it, and "Open sources" is the action that works in a frame (SourcesAction).

import { ChevronDown, ChevronUp, Flame, Thermometer } from 'lucide-react'
import { useContext, useEffect, useId, useRef, useState } from 'react'
import type { FleetMount, FleetNode, FleetView, WallState } from '../../shared/types.ts'
import { SourcesAction } from '../components/FleetStrip.tsx'
import { Sparkline } from '../components/Sparkline.tsx'
import { RecheckButton, RecheckLine } from '../components/Recheck.tsx'
import { Empty } from '../components/ui.tsx'
import { useFleet } from '../lib/api.ts'
import { EmbedContext } from '../lib/embed.ts'
import {
  bytesText,
  diskFreeText,
  diskPercentText,
  diskTakesColour,
  diskWord,
  fleetHeadline,
  groupHosts,
  heatWord,
  incidentFor,
  loadText,
  nextSort,
  nodeStaleText,
  percentText,
  perCoreText,
  ruleName,
  seriesWords,
  sortNodes,
  takesColour,
  updatedText,
  worstMount
} from '../lib/fleet.ts'
import type { Sort, SortKey } from '../lib/fleet.ts'
import { clockText, durationText } from '../lib/format.ts'
import { wallRecheckText } from '../lib/recheck.ts'
import { href } from '../lib/route.ts'
import { afterSettle } from '../lib/settle.ts'
import { useWallRecheck } from '../lib/use-recheck.ts'

const COLUMNS: Array<{ key: SortKey | null; label: string; area: string }> = [
  { key: 'name', label: 'Server', area: 'name' },
  { key: 'cpu', label: 'CPU', area: 'cpu' },
  { key: 'mem', label: 'Memory', area: 'mem' },
  { key: 'load', label: 'Load', area: 'load' },
  { key: 'disk', label: 'Disk', area: 'disk' },
  { key: 'heat', label: 'Status', area: 'status' },
  { key: null, label: 'Netdata', area: 'link' }
]

const SKELETON_ROWS = 8

/** The id of the page's title, so the frame can name the region that holds it. */
export const FLEET_TITLE_ID = 'fleet-title'

function ariaSort(sort: Sort | null, key: SortKey | null): 'ascending' | 'descending' | 'none' | undefined {
  if (!key) return undefined
  if (!sort || sort.key !== key) return 'none'
  return sort.dir === 'asc' ? 'ascending' : 'descending'
}

/** The column headers: a button per sortable column while the table is live, plain labels while it loads. */
function Head({ sort, onSort }: { sort: Sort | null; onSort?: (key: SortKey) => void }) {
  return (
    <div role="rowgroup">
      <div role="row" className="fleet__head">
        {COLUMNS.map((c) => (
          <div key={c.area} role="columnheader" className="fleet__th" data-area={c.area} aria-sort={ariaSort(sort, c.key)}>
            {c.key && onSort ? (
              <button type="button" className="fleet__sort" onClick={() => onSort(c.key as SortKey)}>
                {c.label}
                {sort?.key === c.key && (sort.dir === 'asc' ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />)}
              </button>
            ) : (
              c.label
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function HeatChip({ node }: { node: FleetNode }) {
  const tone = takesColour(node.heat) ? undefined : 'muted'
  return (
    <span className="chip fleet__chip" data-tone={tone} data-heat={node.heat}>
      {node.heat === 'hot' && <Flame aria-hidden="true" />}
      {node.heat === 'warm' && <Thermometer aria-hidden="true" />}
      {heatWord(node.heat)}
    </span>
  )
}

function Metric({ label, tag, value, series, windowMin, mark }: { label: string; tag: string; value: number | null; series: Array<number | null>; windowMin: number; mark: number | null }) {
  return (
    <div className="fleet__metric">
      <span className="fleet__tag" aria-hidden="true">
        {tag}
      </span>
      <span className="fleet__fig num">
        {value === null ? (
          <>
            <span aria-hidden="true">-</span>
            <span className="sr-only">{label}, no data</span>
          </>
        ) : (
          percentText(value)
        )}
      </span>
      <Sparkline values={series} size="page" mark={mark} label={seriesWords(label, series, windowMin)} />
    </div>
  )
}

/** The fullest mount of a node, in the cell: its used % and a 60 minute sparkline, the path when it is not `/`, and what is free of its size. */
function DiskCell({ node, view }: { node: FleetNode; view: FleetView }) {
  const m = worstMount(node)
  if (!m) {
    return (
      <div role="cell" className="fleet__cell fleet__disk" data-area="disk">
        <span className="fleet__label" aria-hidden="true">
          Disk
        </span>
        <span className="fleet__sub">no disk data</span>
      </div>
    )
  }
  const free = diskFreeText(m)
  return (
    <div role="cell" className="fleet__cell fleet__disk" data-area="disk" data-disk-heat={m.heat}>
      <span className="fleet__label" aria-hidden="true">
        Disk
      </span>
      <span className="fleet__metric">
        <span className="fleet__fig num">
          {m.usedPct === null ? (
            <>
              <span aria-hidden="true">-</span>
              <span className="sr-only">{node.name} disk, no data</span>
            </>
          ) : (
            diskPercentText(m.usedPct)
          )}
        </span>
        <Sparkline values={m.series} size="disk" mark={view.thresholds.disk.warmAt} label={seriesWords(`${node.name} disk ${m.path}`, m.series, view.windowMin)} />
      </span>
      {m.path !== '/' && <span className="fleet__sub fleet__path">{m.path}</span>}
      {free && <span className="fleet__sub num fleet__free">{free}</span>}
      {diskTakesColour(m.heat) && <span className="sr-only">{`Disk ${diskWord(m.heat)}`}</span>}
    </div>
  )
}

/** One compact line under the row for each mount after the fullest: path, used %, what is free. Only a warm or hot one takes colour. */
function MoreMounts({ node }: { node: FleetNode }) {
  const rest: FleetMount[] = node.mounts.slice(1)
  if (rest.length === 0) return null
  return (
    <div role="cell" className="fleet__cell fleet__more" data-area="more">
      <ul className="fleet__mounts" aria-label={`Other disks of ${node.name}`}>
        {rest.map((m) => (
          <li key={m.path} className="fleet__mount" data-disk-heat={m.heat}>
            <span className="fleet__mount-path" title={m.path}>
              {m.path}
            </span>
            <span className="fleet__fig num">{diskPercentText(m.usedPct)}</span>
            <span className="fleet__sub num">{m.freeBytes === null ? '' : `${bytesText(m.freeBytes)} free`}</span>
            {diskTakesColour(m.heat) && <span className="sr-only">{`Disk ${diskWord(m.heat)}`}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Row({ node, view, wall, nowMs }: { node: FleetNode; view: FleetView; wall: WallState | null; nowMs: number }) {
  const embedded = useContext(EmbedContext)
  const stale = nodeStaleText(node, nowMs)
  const sub = [node.version, node.cores ? `${node.cores} ${node.cores === 1 ? 'core' : 'cores'}` : ''].filter(Boolean).join(', ')
  return (
    <div role="row" className="fleet__row" data-heat={node.heat} data-stale={stale ? 'true' : undefined}>
      <div role="rowheader" className="fleet__cell fleet__name" data-area="name">
        <span className="fleet__title">{node.name}</span>
        {sub && <span className="fleet__sub">{sub}</span>}
      </div>
      <div role="cell" className="fleet__cell" data-area="cpu">
        <Metric label={`${node.name} CPU`} tag="CPU" value={node.cpu} series={node.series.cpu} windowMin={view.windowMin} mark={view.thresholds.cpu.warnAbove} />
      </div>
      <div role="cell" className="fleet__cell" data-area="mem">
        <Metric label={`${node.name} memory`} tag="Mem" value={node.mem} series={node.series.mem} windowMin={view.windowMin} mark={view.thresholds.memory.warnAbove} />
      </div>
      <div role="cell" className="fleet__cell fleet__load" data-area="load">
        <span className="fleet__label" aria-hidden="true">
          Load
        </span>
        <span className="fleet__fig num">{loadText(node.load5)}</span>
        <span className="fleet__sub num">{perCoreText(node.loadPerCore)}</span>
      </div>
      <DiskCell node={node} view={view} />
      <div role="cell" className="fleet__cell fleet__status" data-area="status">
        <HeatChip node={node} />
        {stale && <span className="fleet__sub">{stale}</span>}
        {node.rules.map((r) => {
          const key = wall ? incidentFor(r, node, wall.incidents) : null
          return (
            <span key={r.id} className="fleet__alert">
              {key ? (
                <a className="link" href={href({ view: embedded ? 'wall' : 'fleet', incident: key })}>
                  {ruleName(r)}
                </a>
              ) : (
                <span>{ruleName(r)}</span>
              )}
              <span className="fleet__sub num">{r.value}</span>
            </span>
          )
        })}
      </div>
      <div role="cell" className="fleet__cell fleet__link" data-area="link">
        {node.url ? (
          <a className="link" href={node.url} target="_blank" rel="noreferrer noopener" aria-label={`Open ${node.name} in Netdata Cloud, in a new tab`}>
            Netdata
          </a>
        ) : (
          <span className="fleet__sub">no page</span>
        )}
      </div>
      <MoreMounts node={node} />
    </div>
  )
}

/** Loading is the table's own shape: the real header and rows that carry the row's anatomy as static blocks, never a lone line of text. */
function SkeletonRows() {
  return (
    <div role="status" aria-label="Loading the fleet">
      <div className="fleet__group" aria-hidden="true">
        <div className="skeleton skel-line" style={{ width: 'var(--env-skel-group-w)' }} />
      </div>
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <div key={i} className="fleet__row" data-skeleton aria-hidden="true">
          <div className="fleet__cell fleet__name" data-area="name">
            <span className="skeleton skel-line" style={{ width: 'var(--fleet-skel-name-w)' }} />
            <span className="skeleton skel-line" style={{ width: 'var(--env-skel-label-w)' }} />
          </div>
          {(['cpu', 'mem'] as const).map((a) => (
            <div key={a} className="fleet__cell" data-area={a}>
              <div className="fleet__metric">
                <span className="skeleton skel-line" style={{ width: 'var(--fleet-skel-fig-w)' }} />
                <span className="skeleton fleet__skel-spark" />
              </div>
            </div>
          ))}
          <div className="fleet__cell" data-area="load">
            <span className="skeleton skel-line" style={{ width: 'var(--fleet-skel-fig-w)' }} />
          </div>
          <div className="fleet__cell" data-area="disk">
            <div className="fleet__metric">
              <span className="skeleton skel-line" style={{ width: 'var(--fleet-skel-fig-w)' }} />
              <span className="skeleton fleet__skel-spark" data-size="disk" />
            </div>
            <span className="skeleton skel-line" style={{ width: 'var(--env-skel-text-w)' }} />
          </div>
          <div className="fleet__cell" data-area="status">
            <span className="skeleton skel-line" style={{ width: 'var(--fleet-skel-chip-w)' }} />
          </div>
          <div className="fleet__cell" data-area="link">
            <span className="skeleton skel-line" style={{ width: 'var(--fleet-skel-fig-w)' }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export function Fleet({ wall, nowMs }: { wall: WallState | null; nowMs: number }) {
  const embedded = useContext(EmbedContext)
  const Title = embedded ? 'h2' : 'h1'
  const { state, offline, reload } = useFleet()
  const rc = useWallRecheck(reload)
  const textId = useId()
  // the header marks itself sorted on the press; the rows follow behind the settle seam
  const [sort, setSort] = useState<Sort | null>(null)
  const [applied, setApplied] = useState<Sort | null>(null)
  const cancel = useRef<(() => void) | null>(null)
  useEffect(() => () => cancel.current?.(), [])
  const press = (key: SortKey): void => {
    const next = nextSort(sort, key)
    setSort(next)
    cancel.current?.()
    cancel.current = afterSettle(() => setApplied(next))
  }

  const words = rc.result ? wallRecheckText(rc.result, nowMs) : null
  const recheck = (
    <div className="recheck" data-scope="wall">
      <RecheckButton busy={rc.busy} label="Re-check now" describedBy={textId} onPress={rc.press} />
      <div className="recheck__stack">
        {state.status === 'ready' && <p className="recheck__fresh num">{updatedText(state.view, nowMs)}</p>}
        <RecheckLine id={textId} busy={rc.busy} words={words} failed={rc.failed} />
      </div>
    </div>
  )

  if (state.status !== 'ready') {
    return (
      <>
        <div className="page-head">
          <div>
            <Title className="page-title" id={embedded ? FLEET_TITLE_ID : undefined}>
              Fleet
            </Title>
            {state.status === 'loading' && <div className="skeleton skel-line fleet__skel-head" aria-hidden="true" />}
          </div>
        </div>
        {state.status === 'loading' && (
          <div className="fleet" role="table" aria-label="Fleet servers" aria-busy="true">
            <Head sort={null} />
            <SkeletonRows />
          </div>
        )}
        {state.status === 'none' && <Empty sentence="Watch is not reading fleet metrics on this host." action={<SourcesAction onRetry={reload} />} />}
        {state.status === 'error' && <Empty sentence="Watch could not read the fleet just now." action={recheck} />}
      </>
    )
  }

  const view = state.view
  const head = fleetHeadline(view)
  const { groups, collectors } = groupHosts(view.nodes)
  const old = view.stale || offline
  const sinceText = view.dataAt ? clockText(view.dataAt) : null
  return (
    <>
      <div className="page-head">
        <div>
          <Title className="page-title" id={embedded ? FLEET_TITLE_ID : undefined}>
            Fleet
          </Title>
          {old ? (
            <p className="statusline" data-stale="true">
              <strong>The fleet figures are {view.dataAt ? `${durationText((nowMs - Date.parse(view.dataAt)) / 1000)} old` : 'not in yet'}.</strong>{' '}
              {offline ? `Watch lost its connection${sinceText ? `, so these are the figures from ${sinceText}` : ''}.` : `Netdata Cloud has not answered${sinceText ? ` since ${sinceText}` : ''}, so a quiet fleet cannot be trusted.`}
            </p>
          ) : (
            <p className="statusline">
              <strong>{head.lead}</strong> {head.detail}
            </p>
          )}
        </div>
        <div className="tools">{recheck}</div>
      </div>

      {groups.length === 0 ? (
        <Empty sentence="Netdata Cloud lists no servers in this room yet." action={<SourcesAction onRetry={reload} />} />
      ) : (
        <div className="fleet" role="table" aria-label="Fleet servers" data-stale={old ? 'true' : undefined}>
          <Head sort={sort} onSort={press} />
          {groups.map((g) => (
            <div key={g.id} role="rowgroup" aria-label={g.title}>
              <div role="row" className="fleet__group">
                <div role="rowheader" aria-colspan={COLUMNS.length}>
                  <span className="fleet__group-title">{g.title}</span> <span className="fleet__sub num">{g.nodes.length}</span>
                </div>
              </div>
              {sortNodes(g.nodes, applied).map((n) => (
                <Row key={n.name} node={n} view={view} wall={wall} nowMs={nowMs} />
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="fleet__notes">
        <p className="note">
          Each sparkline is the last {view.windowMin} min on a 0 to 100% scale. The hairline across CPU is the alert line, {view.thresholds.cpu.warnAbove}%, across memory {view.thresholds.memory.warnAbove}%, and across disk {view.thresholds.disk.warmAt}%, where a disk turns warm (hot from {view.thresholds.disk.hotAt}%).
        </p>
        <p className="note">
          Disk is the fullest mount of a node: the root, or a real filesystem of at least 50 GiB. Used is used / (used + available), as Netdata reads it; the size counts what is reserved for root.
        </p>
        {collectors.length > 0 && (
          <p className="note">
            {collectors.map((c) => c.name).join(' and ')} {collectors.length === 1 ? 'is' : 'are'} the Kubernetes state collector and carry{collectors.length === 1 ? 's' : ''} no host metrics, so{' '}
            {collectors.length === 1 ? 'it has' : 'they have'} no row.
          </p>
        )}
      </div>
    </>
  )
}
