// The Fleet strip: a quiet band above the wall, one cell per host (name, CPU now with a tiny 60 minute sparkline, and the disk % of its fullest
// mount), the whole band one link to the Fleet page. The lead cell labels the two rows, CPU and Disk, and stays at the left edge while a long band
// scrolls. A hot or warm node is tinted and its sparkline coloured, as on the page; a warm or hot disk is its own outlined, tinted figure; every
// other cell is neutral. The wall stays the one bold thing, so the strip is flat (no shadow, no card per cell) and keeps one height whether it
// shows cells, skeletons or its one sentence.
// In the chat panel (EmbedContext, views/Embed.tsx) it is the same band with three differences: the hottest host comes first at any width (the band
// scrolls there, so the one that matters is never off screen), the "Fleet" label carries a chevron that says it opens the Fleet view, and a sentence
// about missing metrics offers the action that works in a frame (SourcesAction). In the app it is exactly what it was.

import { ChevronRight } from 'lucide-react'
import { useContext } from 'react'
import type { ReactNode } from 'react'
import { useFleet } from '../lib/api.ts'
import type { FleetState } from '../lib/api.ts'
import { EmbedContext, framed } from '../lib/embed.ts'
import { diskPercentText, diskTakesColour, downsample, percentText, seriesWords, stripLabel, takesColour, tokenPx, worstMount } from '../lib/fleet.ts'
import { durationText } from '../lib/format.ts'
import { href } from '../lib/route.ts'
import type { FleetNode, FleetView } from '../../shared/types.ts'
import { Sparkline } from './Sparkline.tsx'

const SKELETON_CELLS = 10

/** A node's call on the eye: a hot CPU, memory or load first, then a hot disk, then a warm node, then a warm disk; a quiet node asks for nothing. */
const HEAT_CALL: Record<string, number> = { hot: 4, warm: 2 }
const DISK_CALL: Record<string, number> = { hot: 3, warm: 1 }
export const attentionOf = (n: Pick<FleetNode, 'heat' | 'diskHeat'>): number => Math.max(HEAT_CALL[n.heat] ?? 0, DISK_CALL[n.diskHeat] ?? 0)

/** The hosts in the order the frame shows them: the loudest first, the API's order inside a tier and for every quiet host (a stable sort). */
export function hottestFirst<T extends Pick<FleetNode, 'heat' | 'diskHeat'>>(nodes: readonly T[]): T[] {
  return nodes.map((n, i) => ({ n, i })).sort((a, b) => attentionOf(b.n) - attentionOf(a.n) || a.i - b.i).map((x) => x.n)
}

/**
 * The one action under a sentence that says the fleet is not there: the Sources page in the app; in the frame (whose panel header already opens the
 * full app) "Check again", or on a bare embed page the full app's Sources in a new tab, as the embed's own empty state does.
 */
export function SourcesAction({ onRetry }: { onRetry: () => void }) {
  const embedded = useContext(EmbedContext)
  if (!embedded) {
    return (
      <a className="btn" href={href({ view: 'sources' })}>
        Open sources
      </a>
    )
  }
  if (framed()) {
    return (
      <button type="button" className="btn" onClick={onRetry}>
        Check again
      </button>
    )
  }
  return (
    <a className="btn" href="/#/sources" target="_blank" rel="noopener noreferrer">
      Open full Watch
    </a>
  )
}

/** The lead's second word: how many hosts are hot or warm, on CPU, memory and load or on a disk. */
function lead(view: FleetView, old: boolean, nowMs: number): string {
  if (old) return `${durationText(Math.max(0, (nowMs - Date.parse(view.dataAt ?? view.generatedAt)) / 1000))} old`
  const hosts = view.nodes.filter((n) => n.group !== 'k8s')
  const hot = hosts.filter((n) => n.heat === 'hot' || n.diskHeat === 'hot').length
  const warm = hosts.filter((n) => n.heat === 'warm' || n.diskHeat === 'warm').length
  if (hot > 0) return `${hot} hot`
  if (warm > 0) return `${warm} warm`
  return 'none hot'
}

function Cell({ node, windowMin, old }: { node: FleetNode; windowMin: number; old: boolean }) {
  // one point for each pixel of the sparkline's width: all a strip that small can draw
  const series = downsample(node.series.cpu, Math.round(tokenPx('--fleet-strip-spark-w')))
  const disk = worstMount(node)
  const attn = takesColour(node.heat) || diskTakesColour(node.diskHeat)
  return (
    <span className="fstrip__cell" data-heat={node.heat} data-attn={attn ? 'true' : undefined} data-stale={old || node.stale ? 'true' : undefined}>
      <span className="fstrip__name" title={node.name}>
        {node.name}
      </span>
      <span className="fstrip__fig">
        <span className="num">{percentText(node.cpu)}</span>
        <Sparkline values={series} size="strip" label={seriesWords(`${node.name} CPU`, series, windowMin)} />
      </span>
      <span className="fstrip__fig fstrip__disk" data-disk-heat={node.diskHeat} data-none={disk ? undefined : 'true'}>
        {disk ? <span className="num">{diskPercentText(disk.usedPct)}</span> : 'no disk'}
      </span>
    </span>
  )
}

/** The strip's first cell: the name of the band, how many are hot, and the label of each row. It is the same cell while the cells load. */
function Lead({ sum, go }: { sum: ReactNode; go?: boolean }) {
  return (
    <span className="fstrip__lead">
      <span className="fstrip__head">
        <span className="fstrip__title">Fleet</span>
        {go && <ChevronRight className="fstrip__go" aria-hidden="true" />}
        {sum}
      </span>
      <span className="fstrip__row">CPU</span>
      <span className="fstrip__row">Disk</span>
    </span>
  )
}

export function FleetStrip({ nowMs }: { nowMs: number }) {
  const { state, offline, reload } = useFleet()
  return <FleetStripView state={state} offline={offline} reload={reload} nowMs={nowMs} />
}

/** The band for a given fleet state: the hook's answer, drawn. Split out so a test can draw each state without a network. */
export function FleetStripView({ state, offline, reload, nowMs }: { state: FleetState; offline: boolean; reload: () => void; nowMs: number }) {
  const embedded = useContext(EmbedContext)

  if (state.status === 'loading') {
    return (
      <div className="fstrip" role="status" aria-label="Loading the fleet" data-state="loading">
        <div className="fstrip__link" aria-hidden="true">
          <Lead sum={<span className="skeleton skel-line fstrip__skel-sum" />} go={embedded} />
          {Array.from({ length: SKELETON_CELLS }, (_, i) => (
            <span key={i} className="fstrip__cell">
              <span className="skeleton skel-line" style={{ width: 'var(--fleet-skel-name-w)' }} />
              <span className="skeleton skel-line" style={{ width: 'var(--env-skel-text-w)' }} />
              <span className="skeleton skel-line" style={{ width: 'var(--env-skel-text-w)' }} />
            </span>
          ))}
        </div>
      </div>
    )
  }

  if (state.status !== 'ready') {
    return (
      <div className="fstrip" data-state="empty">
        <div className="fstrip__empty">
          <p>{state.status === 'none' ? 'Fleet metrics are not set up on this host.' : 'Watch could not read the fleet just now.'}</p>
          {state.status === 'none' ? (
            <SourcesAction onRetry={reload} />
          ) : (
            <button type="button" className="btn" onClick={reload}>
              Try again
            </button>
          )}
        </div>
      </div>
    )
  }

  const view = state.view
  const old = view.stale || offline
  const all = view.nodes.filter((n) => n.group !== 'k8s')
  const hosts = embedded ? hottestFirst(all) : all
  if (hosts.length === 0) {
    return (
      <div className="fstrip" data-state="empty">
        <div className="fstrip__empty">
          <p>Netdata Cloud lists no servers in this room yet.</p>
          <SourcesAction onRetry={reload} />
        </div>
      </div>
    )
  }
  return (
    <div className="fstrip" data-state="ready" data-stale={old ? 'true' : undefined}>
      <a className="fstrip__link" href={href({ view: 'fleet' })} aria-label={stripLabel(view, nowMs)}>
        <Lead sum={<span className="fstrip__sum" title={lead(view, old, nowMs)}>{lead(view, old, nowMs)}</span>} go={embedded} />
        {hosts.map((n) => (
          <Cell key={n.name} node={n} windowMin={view.windowMin} old={old} />
        ))}
      </a>
    </div>
  )
}
