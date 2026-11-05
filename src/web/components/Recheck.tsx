// The re-check controls: one for the whole wall (the header, beside the freshness line) and one per alert (the incident sheet and each
// alert row in it). A control only acknowledges a press: the pressed state and a spinner, with a sentence beside it. The request is queued
// behind the settle seam by the hooks in lib/use-recheck.ts, and the answer arrives in words, never as a silent spinner.

import { RefreshCw } from 'lucide-react'
import { useId } from 'react'
import type { PushedSender } from '../../shared/recheck.ts'
import type { SourceStatus, WallState } from '../../shared/types.ts'
import { RECHECK_BUSY, RECHECK_FAILED, alertRecheckText, freshnessText, wallRecheckText, withLiveAlert } from '../lib/recheck.ts'
import type { RecheckWords } from '../lib/recheck.ts'
import { useWallRecheck } from '../lib/use-recheck.ts'
import type { AlertRechecks } from '../lib/use-recheck.ts'

/**
 * The control itself. The visible label never changes while busy (so the control does not move); the spinner and `aria-busy` say it is working,
 * and the sentence beside it says what it is doing. `name` is the accessible name at rest and starts with the visible label. A press during
 * a check is ignored by the hook rather than disabling the button, so keyboard focus is never dropped from it.
 */
export function RecheckButton({
  busy,
  label,
  name,
  describedBy,
  onPress
}: {
  busy: boolean
  label: string
  name?: string
  describedBy?: string
  onPress: () => void
}) {
  return (
    <button
      type="button"
      className="btn recheck__btn"
      data-slot="recheck"
      aria-busy={busy}
      aria-label={name && !busy ? name : undefined}
      aria-describedby={describedBy}
      onClick={onPress}
    >
      <RefreshCw aria-hidden="true" />
      {label}
      {name && busy ? <span className="sr-only">{`, checking`}</span> : null}
    </button>
  )
}

/**
 * What a check found, in a live region that exists before it is filled, so a screen reader announces the answer when it arrives. The finding
 * is the line; the one quieter sentence under it (who did not answer) is its note. `standing` is a sentence that is always true of what the
 * control is about (when a pushing sender runs next and when its alert clears on its own): it stays under the finding while a check runs and
 * before there is one, and sits outside the live region because it is not an answer.
 */
export function RecheckLine({ id, busy, words, failed, standing }: { id: string; busy: boolean; words: RecheckWords | null; failed?: boolean; standing?: string | null }) {
  const line = busy ? RECHECK_BUSY : failed ? RECHECK_FAILED : (words?.line ?? '')
  const note = busy || failed ? null : (words?.note ?? null)
  return (
    <div className="recheck__text" id={id}>
      <p className="recheck__line" role="status" aria-live="polite">
        {line}
      </p>
      {note && <p className="recheck__note">{note}</p>}
      {standing && <p className="recheck__note">{standing}</p>}
    </div>
  )
}

/** How fresh the polled sources are, from the wall's own state: "Checked 40 s ago", the age of the oldest answer. */
function Freshness({ sources, nowMs }: { sources: ReadonlyArray<Pick<SourceStatus, 'kind' | 'lastOk'>>; nowMs: number }) {
  const text = freshnessText(sources, nowMs)
  return text ? <p className="recheck__fresh num">{text}</p> : null
}

/** The wall header's control: "Re-check now", the freshness line, and under it what the last check found ("3 sources checked, 1 alert cleared"). */
export function WallRecheck({ state, nowMs, onDone }: { state: WallState; nowMs: number; onDone: () => void }) {
  const rc = useWallRecheck(onDone)
  const textId = useId()
  const words = rc.result ? wallRecheckText(rc.result, nowMs) : null
  return (
    <div className="recheck" data-scope="wall">
      <RecheckButton busy={rc.busy} label="Re-check now" describedBy={textId} onPress={rc.press} />
      <div className="recheck__stack">
        <Freshness sources={state.sources} nowMs={nowMs} />
        <RecheckLine id={textId} busy={rc.busy} words={words} failed={rc.failed} />
      </div>
    </div>
  )
}

/** One alert's control with its answer beside it: "Re-check", then "Still firing, checked just now" or "Cleared at 14:52". */
export function AlertRecheckRow({
  alertKey,
  who,
  rc,
  nowMs,
  live
}: {
  alertKey: string
  who: string
  rc: AlertRechecks
  nowMs: number
  /** The alert as the sheet last fetched it: a pushing sender's request moves after the press, and the row says where it stands now. */
  live?: { resolvedAt: string | null; pushed?: PushedSender[] }
}) {
  const textId = useId()
  const result = rc.results.get(alertKey)
  const busy = rc.busy.has(alertKey)
  // an instance named by its summary is long: the accessible name of the control keeps the first words of it
  const name = who.length > 40 ? `${who.slice(0, 37)}...` : who
  return (
    <div className="recheck" data-scope="alert">
      <RecheckButton busy={busy} label="Re-check" name={`Re-check ${name}`} describedBy={textId} onPress={() => rc.press([alertKey])} />
      <RecheckLine id={textId} busy={busy} words={result ? alertRecheckText(withLiveAlert(result, live), nowMs) : null} failed={rc.failed.has(alertKey)} />
    </div>
  )
}
