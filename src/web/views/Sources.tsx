import type { SourceStatus, WallState } from '../../shared/types.ts'
import { agoText } from '../lib/format.ts'
import { Chip, Empty } from '../components/ui.tsx'
import { href } from '../lib/route.ts'
import { quietText, sourceLabel, SOURCES_LINE } from '../lib/sources.ts'

const STATE: Record<string, string> = { ok: 'Answering', stale: 'Not answering', error: 'Last poll failed', idle: 'Waiting for the first poll' }

/** A skipped source's line: the engine's reason (`missing <ENV>`) becomes the action it asks for. */
const skippedLine = (reason: string): string =>
  reason.startsWith('missing ') ? `Not started on this host. Set ${reason.slice('missing '.length)} to start it.` : `Not started on this host: ${reason}.`

/** The kinds whose cells carry assertions (a probe, a heartbeat, an expiry, this machine's thresholds): only they can read as unverified. A Grafana rule or a pushed webhook answers with text and carries none. */
const ASSERTION_KINDS = new Set<string>(['http-probe', 'tcp-probe', 'heartbeat', 'domain-expiry', 'host'])

function SourceRow({ s, nowMs }: { s: SourceStatus; nowMs: number }) {
  return (
    <div className="row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
      <span>
        <span className="row__title">{s.id}</span>
        <br />
        <span className="row__sub">
          {sourceLabel(s)}.{' '}
          {s.skipped !== undefined
            ? skippedLine(s.skipped)
            : `${s.kind === 'webhook' ? 'Pushed to it, never polled.' : `${s.rules} ${s.rules === 1 ? 'rule' : 'rules'}, ${s.firing} firing.`} ${quietText(s)}`}
        </span>
        {s.error && (
          <>
            <br />
            <span className="row__sub">{s.error}</span>
          </>
        )}
      </span>
      <span className="row__aside">
        {s.skipped === undefined && ASSERTION_KINDS.has(s.kind) && s.asserted === 0 && (
          <span className="badge" title="No cell of this source asserts more than that it answered: nothing here is known to go red.">
            unverified
          </span>
        )}
        {s.discovered && (
          <span className="badge" title={`Found at ${s.discovered.foundAt}${s.discovered.read ? `: ${s.discovered.read}` : ''}`}>
            traced
          </span>
        )}
        {s.skipped !== undefined ? <Chip muted>skipped</Chip> : <Chip muted={s.state === 'ok'}>{STATE[s.state]}</Chip>}
        {s.skipped === undefined && <span className="num">{s.lastOk ? `heard ${agoText(s.lastOk, nowMs)}` : 'never heard'}</span>}
      </span>
    </div>
  )
}

export function Sources({ state, nowMs }: { state: WallState; nowMs: number }) {
  const webhooks = state.sources.filter((s) => s.kind === 'webhook')
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Sources</h1>
          <p className="statusline">{SOURCES_LINE}</p>
        </div>
      </div>
      {state.sources.length === 0 ? (
        <Empty sentence="No sources are configured." action={<a className="btn" href={href({ view: 'wall' })}>Back to the wall</a>} />
      ) : (
        <div className="rows">
          {state.sources.map((s) => (
            <SourceRow key={s.id} s={s} nowMs={nowMs} />
          ))}
        </div>
      )}
      {webhooks.length > 0 && (
        <div className="section">
          <h2 className="section__title">Send alerts to Watch</h2>
          <p className="note">
            Point an Alertmanager or Grafana webhook receiver at one of these addresses with an Authorization header of Bearer and the token held in the host environment.
          </p>
          <dl className="kv">
            {webhooks.map((w) => (
              <div key={w.id} style={{ display: 'contents' }}>
                <dt>{w.id}</dt>
                <dd>{`${location.origin}/ingest/${w.id}`}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </>
  )
}
