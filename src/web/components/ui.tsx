import { CircleCheck, CirclePause, Info, OctagonAlert, TriangleAlert } from 'lucide-react'
import { useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { Badge } from '../../shared/story.ts'
import type { RuleCell, Severity, SourceKind, Tier } from '../../shared/types.ts'
import { CELL_LEGEND, cellLine, cellOrigin, okText, openText, splitCells } from '../lib/cells.ts'
import { breakSegments, fitWords } from '../lib/title.ts'

export const SEVERITY_TEXT: Record<Severity, string> = { page: 'Page', warning: 'Warning', info: 'Info' }

/** Severity is never carried by colour alone: each tier has its own shape. */
export function Glyph({ severity, quiet }: { severity: Severity | null; quiet?: boolean }) {
  if (quiet || severity === null) return <CircleCheck aria-hidden="true" className="glyph" />
  if (severity === 'page') return <OctagonAlert aria-hidden="true" className="glyph" />
  if (severity === 'warning') return <TriangleAlert aria-hidden="true" className="glyph" />
  return <Info aria-hidden="true" className="glyph" />
}

/** A parked incident's mark: a pause in a circle, the shape family of the other glyphs, in the parked hue (wall.css). Never the severity's shape, and never a check. */
export function ParkedGlyph() {
  return <CirclePause aria-hidden="true" className="glyph" />
}

/**
 * A tile title that wraps only between words (and inside a CamelCase name or a hostname only at its own joints, never through a
 * letter: a zero-width space marks each joint). Past the tile's line limit it ends after a whole word with an ellipsis. The full
 * text is the link's aria-label, and its title (the hover text) when the tile had to cut it. Its text is written here, after layout and before paint, so React never reconciles it: it runs
 * after every render, which is after every resize, poll and change of the tile's box.
 */
export function FitTitle({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const span = ref.current
    const box = span?.closest<HTMLElement>('.tile__title')
    if (!span || !box) return
    const limit = Number.parseInt(getComputedStyle(box).getPropertyValue('-webkit-line-clamp'), 10)
    const write = (value: string): void => {
      span.textContent = value
        .split(' ')
        .map((word) => breakSegments(word).join('\u200b'))
        .join(' ')
    }
    write(text)
    if (!Number.isFinite(limit)) return
    const fits = (candidate: string): boolean => {
      write(candidate)
      return span.getClientRects().length <= limit && box.scrollWidth <= box.clientWidth + 1
    }
    const shown = fitWords(text, fits)
    write(shown)
    // a title that had to end early says the whole of it on hover (the sheet and the link's accessible name already do)
    const link = box.querySelector('a')
    if (shown !== text) link?.setAttribute('title', text)
    else link?.removeAttribute('title')
  })
  return <span ref={ref} className="tile__title-text" />
}

/**
 * Text that may wrap only at the joints of its words (after a dot, dash, underscore, slash or colon, and between the words of a
 * CamelCase name): a zero-width space marks each joint, so a long path or hostname breaks between its parts and not through one.
 */
export function jointed(text: string): string {
  return text
    .split(' ')
    .map((word) => breakSegments(word).join('\u200b'))
    .join(' ')
}

/** The small neutral badge that says where an alert came from: its host, else its environment, else the system that raised it. */
export function HostBadge({ badge }: { badge: Badge }) {
  return (
    <span className="badge" data-kind={badge.kind} data-badge>
      {jointed(badge.text)}
    </span>
  )
}

export function tierText(tier: Tier, severity: Severity): string {
  return tier === 'quiet' && severity !== 'info' ? 'Quiet' : SEVERITY_TEXT[severity]
}

/**
 * The proof of watch of one service: a cell for every rule that is not ok, then ONE count for the rest ("99 ok", or "All 15 ok" when no
 * cell is drawn), so a service with 122 rules does not paint 122 cells and the few that need a look are never the ones clipped. Each
 * drawn cell says its state in the words of its source, with the source's own reason (`cellLine`). A tile too small for the strip lets
 * `useFit` set `data-fit`: 'bare' drops the count, 'text' swaps the cells for one line, "23 not ok". Nothing is ever cut through.
 */
export function Cells({ cells, kinds, shed }: { cells: RuleCell[]; kinds: Readonly<Record<string, SourceKind>>; shed?: string }) {
  const split = splitCells(cells)
  if (split.total === 0) return null
  const ok = okText(split)
  const label =
    split.open.length === 0 ? `${split.total} ${split.total === 1 ? 'rule' : 'rules'}, all ok` : `${split.total} ${split.total === 1 ? 'rule' : 'rules'}, ${split.open.length} not ok${split.ok > 0 ? `, ${split.ok} ok` : ''}`
  return (
    <div className="cells" data-fit-strip data-shed={shed} role="group" aria-label={label}>
      {split.open.map((c) => {
        const line = `${c.name}: ${cellLine(c, cellOrigin(c, kinds))}`
        return <span key={c.id} className="cell" data-state={c.state} role="img" aria-label={line} title={line} />
      })}
      {ok && (
        <span className="cells__ok" title={`${split.ok} ${split.ok === 1 ? 'rule' : 'rules'} evaluating normally`}>
          <span className="cell" data-state="ok" aria-hidden="true" />
          {ok}
        </span>
      )}
      {split.open.length > 0 && <span className="cells__text">{openText(split)}</span>}
    </div>
  )
}

/** One line under the wall's status line: what the four shapes of a cell say. Each item draws its own cell before its words. */
export function CellLegend() {
  return (
    <p className="legend">
      {CELL_LEGEND.map((l) => (
        <span key={l.state} className="legend__item">
          <span className="legend__key">
            <span className="cell" data-state={l.state} aria-hidden="true" />
            {l.shape}:
          </span>{' '}
          {l.text}{' '}
        </span>
      ))}
    </p>
  )
}

export function Chip({ children, muted, parked, icon }: { children: ReactNode; muted?: boolean; parked?: boolean; icon?: ReactNode }) {
  return (
    <span className="chip" data-tone={parked ? 'parked' : muted ? 'muted' : undefined}>
      {icon}
      {children}
    </span>
  )
}

export function Empty({ sentence, action }: { sentence: string; action: ReactNode }) {
  return (
    <div className="empty">
      <p>{sentence}</p>
      {action}
    </div>
  )
}

/** Loading is the wall's own shape: skeleton tiles, never a lone line of text. */
export function SkeletonWall() {
  const rows = Array.from({ length: 9 }, (_, i) => i)
  return (
    <div className="skel-wall" role="status" aria-label="Loading the wall">
      {rows.map((i) => (
        <div key={i} className="tile" data-tier="quiet" aria-hidden="true">
          <div className="skeleton skel-line" style={{ width: '60%' }} />
          <div className="skeleton skel-line" style={{ width: '90%' }} />
          <div className="skeleton skel-line" style={{ width: '40%' }} />
        </div>
      ))}
    </div>
  )
}

export function SkeletonRows({ n = 6 }: { n?: number }) {
  return (
    <div className="rows" role="status" aria-label="Loading">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="row" aria-hidden="true">
          <div className="skeleton skel-line" style={{ width: '100%' }} />
          <div className="skeleton skel-line" style={{ width: '70%' }} />
          <div className="skeleton skel-line" style={{ width: '4ch' }} />
        </div>
      ))}
    </div>
  )
}
