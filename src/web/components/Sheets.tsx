import { ArrowLeft, X } from 'lucide-react'
import { useContext, useEffect, useId, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { evidenceLinks, incidentEvidence, instanceLabels, rankOf, statusText, worstFirst } from '../../shared/evidence-links.ts'
import { incidentTitle } from '../../shared/incident.ts'
import { incidentHeadline, storyOf, systemName } from '../../shared/story.ts'
import { eventSaying, reopenedOf, silenceReasonOf } from '../../shared/event-text.ts'
import { resolutionText } from '../../shared/agent.ts'
import type { AlertEvent, Incident, IncidentComment, ServiceHealth, SourceStatus, WallState } from '../../shared/types.ts'
import { acknowledge, silence, unacknowledge } from '../lib/act.ts'
import { useFetch } from '../lib/api.ts'
import { EmbedContext } from '../lib/embed.ts'
import { ackedParts, parkedDetail, parkedParts, silencedParts } from '../lib/ack.ts'
import type { Told } from '../lib/ack.ts'
import { linkParts } from '../../shared/link-parts.ts'
import { byPhrase, shownName } from '../../shared/who.ts'
import type { IncidentDetail } from '../lib/api.ts'
import { cellLine, cellOrigin, orderCells, sourceKinds } from '../lib/cells.ts'
import { agoDurationText, clockText, durationText, parkStampText, stampText } from '../lib/format.ts'
import { heroOf } from '../lib/hero.ts'
import { incidentRecheckText, standingScheduleText, withLiveAlert } from '../lib/recheck.ts'
import { outcomeWords, receiverWords } from '../lib/receivers.ts'
import { href } from '../lib/route.ts'
import { useAlertRechecks } from '../lib/use-recheck.ts'
import { AgentFold } from './AgentView.tsx'
import { ChatLine, InstanceLinks } from './Evidence.tsx'
import { AlertRecheckRow, RecheckButton, RecheckLine } from './Recheck.tsx'
import { ReferenceButton, referenceDrag, useReferenceable } from './Reference.tsx'
import { ErrorHero } from './SheetDetail.tsx'
import { Disclosures, Section, StoryBlocks } from './StorySheet.tsx'
import { Chip, Empty, Glyph, ParkedGlyph, SEVERITY_TEXT, SkeletonRows } from './ui.tsx'

/** The sheet's own way out. In the embed view the panel around the frame already has the Close, so this one says where it goes. */
function SheetExit({ to }: { to: string }) {
  const embedded = useContext(EmbedContext)
  return (
    <a className="btn" href={to}>
      {embedded ? <ArrowLeft aria-hidden="true" /> : <X aria-hidden="true" />}
      {embedded ? 'Back to wall' : 'Close'}
    </a>
  )
}

/** A drill sheet: a native modal dialog, so focus is trapped, Escape closes it and focus returns to the tile. */
export function Sheet({ open, onClose, titleId, children }: { open: boolean; onClose: () => void; titleId: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      {open ? children : null}
    </dialog>
  )
}

const EVENT_TEXT: Record<string, string> = {
  fired: 'Fired',
  resolved: 'Resolved',
  ack: 'Acknowledged',
  unack: 'Acknowledgement removed',
  silence: 'Silenced',
  park: 'Parked',
  unpark: 'Unparked',
  notify: 'Notified',
  'notify-failed': 'Notification failed',
  'source-stale': 'Source went quiet',
  'source-recovered': 'Source recovered',
  flapping: 'Flapping',
  reopened: 'Reopened',
  confirmed: 'Resolution confirmed'
}

/**
 * A manual resolve is written twice, against each alert it resolved and against the incident, so the list says it once: the incident's line stays
 * and the alerts' lines of the same instant go. (The incident's is the one that names who and why for the whole incident.)
 */
function withoutAlertCopies(events: AlertEvent[]): AlertEvent[] {
  const said = new Set(events.filter((e) => e.alertKey === null && e.kind === 'resolved' && e.detail.manual === true).map((e) => e.at))
  return events.filter((e) => !(e.alertKey !== null && e.kind === 'resolved' && e.detail.manual === true && said.has(e.at)))
}

export function Timeline({ events }: { events: AlertEvent[] }) {
  if (events.length === 0) return <p className="note">No events recorded yet.</p>
  return (
    <ol className="timeline">
      {withoutAlertCopies([...events]).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id)).slice(0, 30).map((e) => (
        <li key={e.id}>
          <time dateTime={e.at}>{stampText(e.at)}</time>
          <span>
            {eventSaying(e, { stamp: parkStampText }) ?? (
              <>
                {EVENT_TEXT[e.kind] ?? e.kind}
                {e.alertKey ? '' : ' (incident)'}
                {typeof e.detail.by === 'string' ? byPhrase(e.detail.by) : ''}
              </>
            )}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** Who has the incident, in two parts: the time stays whole (`nowrap`) when the chip wraps on a phone, so "at 15:25" never splits. */
function attentionTold(i: Incident): Told | null {
  if (i.state.attention === 'acked') return ackedParts(i.ackedBy, i.ackedAt)
  if (i.state.attention === 'silenced') return silencedParts(i.silencedBy, i.silencedUntil, i.silenceCarried, true)
  // the chip says when it ends; why, the ticket and the sender's line are the note under it
  if (i.state.park) return { who: parkedParts(i.state.park).who, when: '' }
  return null
}

/**
 * The comments of an incident, oldest first, each with who wrote it and when. An agent's name reads "agent: <who>". The text is shown as
 * written, with its web addresses linked. An incident with no comment has no section: an empty list would need an action of its own.
 */
export function Comments({ comments }: { comments: IncidentComment[] }) {
  if (comments.length === 0) return null
  return (
    <Section title={`Comments (${comments.length})`}>
      <ol className="comments">
        {comments.map((c) => (
          <li key={c.id} className="comment">
            <div className="comment__head">
              {shownName(c.by) !== null && <span className="comment__by">{shownName(c.by)}</span>}
              <time className="comment__time" dateTime={c.createdAt}>
                {stampText(c.createdAt)}
              </time>
            </div>
            <p className="comment__text">
              {linkParts(c.text).map((part, k) =>
                part.href ? (
                  <a key={k} className="link" href={part.href} target="_blank" rel="noopener noreferrer">
                    {part.text}
                  </a>
                ) : (
                  part.text
                )
              )}
            </p>
          </li>
        ))}
      </ol>
    </Section>
  )
}

export function IncidentSheet({
  incidentKey,
  alertKey,
  from,
  onChanged,
  nowMs,
  agentOpen = false
}: {
  incidentKey: string
  alertKey: string | null
  from: Parameters<typeof href>[0]
  onChanged: () => void
  nowMs: number
  /** Open on what an agent reads for this incident (the route's `agent` flag). */
  agentOpen?: boolean
}) {
  const { data, error, reload } = useFetch<IncidentDetail>(`/api/incidents/${encodeURIComponent(incidentKey)}`, 5000)
  // A re-check polls the source again; the sheet's own refresh and the wall's then show what that changed.
  const rc = useAlertRechecks(() => {
    reload()
    onChanged()
  })
  const recheckId = useId()
  const referenceable = useReferenceable()
  const inc = data?.incident ?? null
  // Worst first: severity, then the most urgent value (the shortest ETA), then the oldest. The title, the story and
  // the instance list all read this one order, so they always name the same instance.
  const firing = useMemo(() => worstFirst(data?.alerts.filter((a) => !a.resolvedAt) ?? [], rankOf), [data])
  // An alert this sheet saw clear stays in the list, saying so, until the sheet closes: a row that vanished would hide the answer.
  // (An alert only a pusher reports clears when the pusher next sends, after the press: one this sheet pressed stays too.)
  const cleared = useMemo(() => worstFirst(data?.alerts.filter((a) => a.resolvedAt && (rc.cleared.has(a.key) || rc.results.has(a.key))) ?? [], rankOf), [data, rc.cleared, rc.results])
  const rows = useMemo(() => [...firing, ...cleared], [firing, cleared])
  const shown = alertKey ? data?.alerts.find((a) => a.key === alertKey) ?? null : rows.length === 1 && firing.length === 1 ? firing[0] : null
  // The incident's control asks again about the alert on the page, or about every alert still firing.
  const recheckKeys = shown ? [shown.key] : firing.map((a) => a.key)
  const lead = shown ?? firing[0] ?? data?.alerts[0] ?? null
  // What a pushing sender says about the alerts on the page, always: when it runs next and when the alert clears on its own if it stops sending it.
  const standing = useMemo(() => standingScheduleText(shown ? [shown] : firing, nowMs), [shown, firing, nowMs])
  // The answers of the last press, with each pusher's request as the sheet's own refresh has it now: a request moves on after the press.
  const batchWords = useMemo(() => {
    if (!rc.batch) return null
    const byKey = new Map((data?.alerts ?? []).map((a) => [a.key, a]))
    return incidentRecheckText(rc.batch.map((r) => withLiveAlert(r, byKey.get(r.key))), nowMs)
  }, [rc.batch, data, nowMs])
  const more = shown ? 0 : Math.max(0, firing.length - 1)
  const links = useMemo(() => {
    if (!data) return []
    if (shown) return evidenceLinks(shown)
    return incidentEvidence(firing.length ? firing : data.alerts.slice(0, 1))
  }, [data, shown, firing])
  const story = useMemo(() => (lead ? storyOf(lead, links) : null), [lead, links])
  // A press only asks: the request names who (a prompt the first time) and waits behind the settle seam (lib/act.ts).
  const act = async (path: 'ack' | 'unack' | 'silence', minutes?: number): Promise<void> => {
    if (path === 'ack') await acknowledge(incidentKey)
    else if (path === 'unack') await unacknowledge(incidentKey)
    else await silence(incidentKey, minutes ?? 60)
    reload()
    onChanged()
  }
  const close = href(from)
  const title = story ? incidentHeadline(story, inc?.rule ?? lead?.rule ?? '', inc?.instance) : inc?.summary || 'Incident'
  // The error of the alert that speaks, read by source (lib/hero.ts); none when the source gave no error, and never the title said again.
  const hero = useMemo(() => (lead ? heroOf(lead, title) : null), [lead, title])
  // One label per row, told apart from the others and never the alertname the incident is already titled with.
  const names = useMemo(() => instanceLabels(rows, [inc?.rule ?? '']), [rows, inc])
  // One alert's page lists that alert's events and, whatever alert is open, what a person or an agent did to the incident (an acknowledgement,
  // a silence, a manual resolve, a reopen, a confirmation): those are written against the incident, not an alert, and are the point of the list.
  const events = data ? (shown ? data.events.filter((e) => e.alertKey === shown.key || (e.alertKey === null && eventSaying(e) !== null)) : data.events) : []
  const told = inc ? attentionTold(inc) : null
  const reopened = useMemo(() => (data?.incident ? reopenedOf(data.events) : null), [data])
  // Why a silence was set stays beside who set it: a silence hides a problem from the pager, so its reason is not left to the history list.
  const silenceReason = useMemo(() => (data?.incident?.state.attention === 'silenced' ? silenceReasonOf(data.events) : null), [data])

  return (
    <div className="sheet__body">
      <div className="sheet__head">
        <div className="sheet__bar">
          {alertKey && firing.length > 1 ? (
            <a className="btn" href={href({ ...from, incident: incidentKey })}>
              <ArrowLeft aria-hidden="true" />
              Back to the incident
            </a>
          ) : (
            <span className="sheet__lead">
              {inc && <Chip icon={<Glyph severity={inc.severity} />}>{SEVERITY_TEXT[inc.severity]}</Chip>}
              <span className="note">{inc ? `${systemName(lead?.origin) || inc.service}, ${incidentTitle(inc)}` : lead ? `${systemName(lead.origin)}, ${lead.rule}` : ''}</span>
            </span>
          )}
          <SheetExit to={close} />
        </div>
        <h2 className="sheet__title" id="sheet-title" {...(referenceable ? referenceDrag(incidentKey, title) : {})}>
          {title}
          {more > 0 && <span className="sheet__more"> +{more} more</span>}
        </h2>
        {data && (
          <div className="actions actions--state">
            {inc ? (
              <>
                {alertKey && firing.length > 1 && <Chip icon={<Glyph severity={inc.severity} />}>{SEVERITY_TEXT[inc.severity]}</Chip>}
                {reopened && <Chip muted>Reopened after a manual resolve</Chip>}
                {told && (
                  <Chip muted={!inc.state.park} parked={!!inc.state.park} icon={inc.state.park ? <ParkedGlyph /> : inc.state.attention === 'acked' ? <Glyph severity={null} /> : undefined}>
                    <span>
                      {told.who}
                      {told.when !== '' && (
                        <>
                          {' '}
                          <span className="chip__when">{told.when}</span>
                        </>
                      )}
                    </span>
                  </Chip>
                )}
                {inc.state.attention === 'none' || inc.state.attention === 'parked' ? (
                  <button type="button" className="btn" data-variant={inc.state.attention === 'none' ? 'primary' : undefined} onClick={() => void act('ack')}>
                    Acknowledge
                  </button>
                ) : (
                  <button type="button" className="btn" onClick={() => void act('unack')}>
                    {inc.state.attention === 'silenced' ? 'Remove silence' : 'Remove acknowledgement'}
                  </button>
                )}
                <button type="button" className="btn" onClick={() => void act('silence', 60)}>
                  Silence 1 h
                </button>
                <button type="button" className="btn" onClick={() => void act('silence', 240)}>
                  Silence 4 h
                </button>
                <RecheckButton
                  busy={recheckKeys.some((k) => rc.busy.has(k))}
                  label="Re-check"
                  name={shown ? 'Re-check this alert' : 'Re-check this incident'}
                  describedBy={recheckId}
                  onPress={() => rc.press(recheckKeys, true)}
                />
              </>
            ) : data.resolved ? (
              <>
                <Chip muted>
                  Resolved {stampText(data.resolved.resolvedAt)}, lasted {durationText(data.resolved.durationSec)}
                </Chip>
                {data.resolved.manual && <Chip muted>{resolutionText('resolved-manual', shownName(data.resolved.manual.by), data.resolved.manual.reason)}</Chip>}
                {data.resolved.confirmed && <Chip muted>{resolutionText('confirmed', shownName(data.resolved.confirmed.by), data.resolved.confirmed.note)}</Chip>}
              </>
            ) : (
              <Chip muted>Resolved</Chip>
            )}
            <ReferenceButton incidentKey={incidentKey} title={title} />
          </div>
        )}
        {silenceReason && <p className="note">{`Reason: ${silenceReason}`}</p>}
        {inc?.state.park && <p className="note">{parkedDetail(inc.state.park)}</p>}
        {data && (
          <RecheckLine
            id={recheckId}
            busy={recheckKeys.some((k) => rc.busy.has(k))}
            words={batchWords}
            failed={recheckKeys.some((k) => rc.failed.has(k))}
            standing={standing}
          />
        )}
        {data && hero && <ErrorHero hero={hero} severity={inc?.severity ?? lead?.severity ?? 'info'} />}
      </div>

      {!data && !error && <SkeletonRows />}
      {error && <p className="note">This incident could not be loaded. It may have been pruned after 30 days.</p>}

      {data && lead && story && <StoryBlocks story={story} alert={lead} nowMs={nowMs} />}

      {data && !shown && rows.length > 1 && (
        <Section title="What is firing, worst first">
          <ul className="insts" aria-label="Instances, worst first">
            {rows.map((a, k) => {
              const name = names[k]
              const done = !!a.resolvedAt
              // a row named by its summary already says it: the status line then holds only a value, if there is one
              const status = name.source === 'summary' || name.source === 'rule' ? (a.value ?? '') : statusText(name.text, a.annotations.summary, a.value)
              return (
                <li key={a.key} className="inst" data-tone={done ? undefined : a.severity} data-cleared={done || undefined}>
                  <a className="inst__head" href={href({ ...from, incident: incidentKey, alert: a.key })} title={name.text}>
                    <Glyph severity={done ? null : a.severity} />
                    <span className="inst__name">{name.text}</span>
                    <span className="inst__since num">{done && a.resolvedAt ? `cleared ${clockText(a.resolvedAt)}` : `since ${clockText(a.startsAt)}`}</span>
                  </a>
                  {status && <p className="inst__status">{status}</p>}
                  <InstanceLinks source={a} name={name.text} />
                  <div className="inst__recheck">
                    <AlertRecheckRow alertKey={a.key} who={name.text} rc={rc} nowMs={nowMs} live={a} />
                  </div>
                </li>
              )
            })}
          </ul>
        </Section>
      )}

      {data && lead && <Disclosures alert={lead} speaks={more > 0 ? names[0]?.text : undefined} />}

      {data && (
        <AgentFold
          incidentKey={incidentKey}
          asked={agentOpen}
          revision={inc ? `${inc.state.attention}|${inc.ackedBy ?? ''}|${inc.silencedUntil ?? ''}|${inc.state.park?.until ?? ''}` : 'gone'}
        />
      )}

      {data && <Comments comments={data.comments ?? []} />}

      {data && (
        <Section title="History">
          <Timeline events={events} />
        </Section>
      )}

      {data && inc && (
        <Section title="Notifications">
          {data.notifications.length === 0 ? (
            <p className="note">
              {inc.heldUntil
                ? `Held until ${clockText(inc.heldUntil)} for quiet hours.`
                : inc.state.attention === 'parked'
                  ? 'Nobody is notified while this is parked. It comes back unattended, and is paged as a new problem would be, when the park ends.'
                  : inc.state.attention !== 'none'
                  ? 'Nobody is notified while this is attended.'
                  : inc.wallOnly
                    ? 'Wall only, no notifications.'
                    : inc.severity === 'info'
                      ? 'Info alerts stay on the wall and notify nobody.'
                      : 'Nothing sent yet. The first notification goes out when the wait period ends.'}
            </p>
          ) : (
            <div className="rows">
              {data.notifications.slice(0, 6).map((n, k) => (
                <div key={k} className="row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                  <span>
                    <span className="row__title" title={receiverWords(n.channel_id) === n.channel_id ? undefined : n.channel_id}>
                      {receiverWords(n.channel_id)}
                    </span>
                    <br />
                    <span className="row__sub">{n.kind}, route {n.route_id}</span>
                  </span>
                  <span className="row__aside">
                    <span className="num">{clockText(new Date(n.at).toISOString())}</span>
                    <span>{outcomeWords(n)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
          {inc.nextStep && inc.state.attention === 'none' && (
            <p className="note">
              Next: {inc.nextStep.channels.map(receiverWords).join(' and ')} at {clockText(inc.nextStep.at)} if nobody acts.
            </p>
          )}
        </Section>
      )}

      {story && <ChatLine links={story.links.chat} />}
    </div>
  )
}

export function HostSheet({ name, state, from }: { name: string; state: WallState; from: Parameters<typeof href>[0] }) {
  const incidents = state.incidents.filter((i) => i.alerts.some((a) => (a.host || 'No host label') === name))
  return (
    <div className="sheet__body">
      <div className="sheet__head">
        <div className="sheet__bar">
          <span className="note">Host</span>
          <SheetExit to={href(from)} />
        </div>
        <h2 className="sheet__title" id="sheet-title">
          {name}
        </h2>
      </div>
      <div className="section">
        <h3 className="section__title">What is firing here</h3>
        {incidents.length === 0 ? (
          <p className="note">Nothing is firing on this host now.</p>
        ) : (
          <div className="rows">
            {incidents.map((i) => (
              <a key={i.key} className="row" href={href({ ...from, incident: i.key })} data-tone={i.severity} style={{ textDecoration: 'none' }}>
                <Glyph severity={i.severity} />
                <span>
                  <span className="row__title">{incidentTitle(i)}</span>
                  <br />
                  <span className="row__sub">{i.service}</span>
                </span>
                <span className="row__aside">{SEVERITY_TEXT[i.severity]}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Every rule or check behind one service tile. Each row says its state in the words of its source ("pending, inside its for-window" for a
 * Grafana rule, "pending, waiting before declaring down" for a prober, "pending, read in part" for a sweep check) and, when the source sent
 * one, its reason after a colon ("skipped: no credential for Cloudflare analytics"). The rows that need a look come first.
 */
export function ServiceSheet({
  health,
  from,
  nowMs,
  sources
}: {
  health: ServiceHealth
  from: Parameters<typeof href>[0]
  nowMs: number
  sources: ReadonlyArray<Pick<SourceStatus, 'id' | 'kind'>>
}) {
  const kinds = sourceKinds(sources)
  return (
    <div className="sheet__body">
      <div className="sheet__head">
        <div className="sheet__bar">
          <span className="note">Service</span>
          <SheetExit to={href(from)} />
        </div>
        <h2 className="sheet__title" id="sheet-title">
          {health.service}
        </h2>
        <p className="note">Every rule or check that watches this service, what state it is in, and when it last ran.</p>
      </div>
      {health.cells.length === 0 && <Empty sentence="No rule or check reports on this service now." action={<a className="btn" href={href(from)}>Back to the wall</a>} />}
      <div className="rows">
        {orderCells(health.cells).map((c) => (
          <div key={c.id} className="row" style={{ gridTemplateColumns: 'var(--cell) minmax(0,1fr) auto' }}>
            <span className="cells">
              <span className="cell" data-state={c.state} />
            </span>
            <span>
              <span className="row__title">{c.name}</span>
              <br />
              <span className="row__sub">{cellLine(c, cellOrigin(c, kinds))}</span>
            </span>
            <span className="row__aside">
              <span className="num">{c.evaluatedAt ? agoDurationText((nowMs - Date.parse(c.evaluatedAt)) / 1000) : ''}</span>
              {c.url && (
                <a className="link" href={c.url} target="_blank" rel="noopener noreferrer">
                  Open rule
                </a>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
