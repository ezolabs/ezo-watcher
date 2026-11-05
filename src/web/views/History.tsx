import { useState } from 'react'
import type { HistoryRow } from '../../shared/types.ts'
import { useFetch } from '../lib/api.ts'
import { durationText, stampText } from '../lib/format.ts'
import { href } from '../lib/route.ts'
import { incidentTitle } from '../../shared/incident.ts'
import { ackedLine } from '../lib/ack.ts'
import { resolutionText } from '../../shared/agent.ts'
import { shownName } from '../../shared/who.ts'
import { Empty, Glyph, SEVERITY_TEXT, SkeletonRows } from '../components/ui.tsx'

const RANGES = [
  { hours: 24, label: '24 hours' },
  { hours: 24 * 7, label: '7 days' },
  { hours: 24 * 30, label: '30 days' }
]

/** One incident that resolved: its title, where it came from and who had it, when it resolved and how long it lasted. */
function IncidentRow({ r }: { r: HistoryRow }) {
  return (
    <a className="row" data-stacked href={href({ view: 'history', incident: r.incidentKey })} data-tone={r.severity} style={{ textDecoration: 'none' }}>
      <Glyph severity={r.severity} />
      <span>
        <span className="row__title">{incidentTitle(r)}</span>
        <br />
        <span className="row__sub">
          {r.service}, {SEVERITY_TEXT[r.severity]}, from {r.source}
          {r.ackedBy !== undefined || r.ackedAt ? `. ${ackedLine(r.ackedBy, r.ackedAt)}` : ''}
          {r.manual ? `. ${resolutionText('resolved-manual', shownName(r.manual.by), undefined)}` : ''}
          {r.confirmed ? `. ${resolutionText('confirmed', shownName(r.confirmed.by), undefined)}` : ''}
        </span>
      </span>
      <span className="row__aside">
        <span className="num">{stampText(r.resolvedAt)}</span>
        <span className="num">lasted {durationText(r.durationSec)}</span>
      </span>
    </a>
  )
}

export function History({ nowMs: _nowMs }: { nowMs: number }) {
  const [hours, setHours] = useState(RANGES[0].hours)
  const { data } = useFetch<{ hours: number; rows: HistoryRow[] }>(`/api/history?hours=${hours}`, 15000)
  const range = RANGES.find((r) => r.hours === hours) as (typeof RANGES)[number]
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">History</h1>
          <p className="statusline">Incidents that resolved in the last {range.label}. The Watcher keeps 30 days.</p>
        </div>
        <div className="seg" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r.hours} type="button" aria-pressed={hours === r.hours} onClick={() => setHours(r.hours)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {!data && <SkeletonRows />}
      {data && data.rows.length === 0 && (
        <Empty
          sentence={`Nothing resolved in the last ${range.label}.`}
          action={
            hours < RANGES[2].hours ? (
              <button type="button" className="btn" onClick={() => setHours(RANGES[2].hours)}>
                Show the last 30 days
              </button>
            ) : (
              <a className="btn" href={href({ view: 'wall' })}>
                Back to the wall
              </a>
            )
          }
        />
      )}
      {data && data.rows.length > 0 && (
        <div className="rows">
          {data.rows.map((r) => (
            <IncidentRow key={`${r.incidentKey}${r.resolvedAt}`} r={r} />
          ))}
        </div>
      )}
    </>
  )
}
