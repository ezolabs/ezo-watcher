// The words and the markup of the re-check controls, and the guards on how they are built: a press only acknowledges, the request waits behind
// the settle seam, the spinner is guarded for reduced motion, every number is a token, and no copy holds an em dash. The words for a sender that
// pushes are in two parts: the standing schedule sentence (`scheduleText`) and where the re-check request stands (`requestText`).
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RECHECK_GAP_SEC } from '../src/shared/recheck.ts'
import type { AlertRecheck, PushedRequest, PushedSender, RecheckSource, WallRecheck } from '../src/shared/recheck.ts'
import { RecheckButton, RecheckLine } from '../src/web/components/Recheck.tsx'
import { exactDurationText } from '../src/web/lib/format.ts'
import {
  alertRecheckText,
  checkedAgoText,
  freshnessText,
  incidentRecheckText,
  JUST_NOW_SEC,
  pushedText,
  RECHECK_FAILED,
  requestPhase,
  requestText,
  scheduleText,
  standingScheduleText,
  wallRecheckText,
  whenAhead,
  withLiveAlert
} from '../src/web/lib/recheck.ts'

// 14:52:30 on the reader's own clock, whatever zone the test runs in: the sentences name a time of day, and "today" and "tomorrow" are the reader's days
const NOW = new Date(2026, 9, 15, 14, 52, 30).getTime()
const iso = (offsetSec = 0): string => new Date(NOW + offsetSec * 1000).toISOString()
const clock = (s: string): string => new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
const text = (s: string): string => s.replace(/\u00a0/g, ' ')

const src = (over: Partial<RecheckSource> = {}): RecheckSource => ({ id: 'grafana', kind: 'grafana', ok: true, error: null, checkedAt: iso(-1), ran: true, shared: false, throttled: false, ...over })
const alert = (over: Partial<AlertRecheck> = {}): AlertRecheck => ({
  key: 'grafana:a1b2c3d4',
  at: iso(),
  before: 'firing',
  after: 'firing',
  startsAt: iso(-3600),
  resolvedAt: null,
  sources: [src()],
  pushed: [],
  clearsOnSweep: false,
  rule: 'DiskFull',
  ...over
})
const pusher = (over: Partial<PushedSender> = {}): PushedSender => ({
  source: 'sweep',
  sender: 'sweep',
  lastReportedAt: iso(-1800),
  atLeastEverySec: 43200,
  clearsAfterSec: 86400,
  nextReportAt: null,
  clearsAt: iso(-1800 + 86400),
  request: null,
  ...over
})
const request = (over: Partial<PushedRequest> = {}): PushedRequest => ({ pickupWithinSec: 90, id: 'rr_1', requestedAt: iso(-60), claimedAt: null, doneAt: null, expired: false, outcome: null, note: null, ...over })
/** A sweep that takes requests, with one in the state given. */
const asked = (over: Partial<PushedRequest> = {}, sender: Partial<PushedSender> = {}): PushedSender => pusher({ request: request(over), ...sender })

describe('one alert, in words', () => {
  it('still firing says when it was checked, and just now when it was seconds ago', () => {
    expect(text(alertRecheckText(alert(), NOW).line)).toBe('Still firing, checked just now')
    expect(text(alertRecheckText(alert({ sources: [src({ checkedAt: iso(-42) })] }), NOW).line)).toBe('Still firing, checked 42 s ago')
  })

  it('a clear says when, in the reader clock', () => {
    const r = alert({ after: 'resolved', resolvedAt: iso(-2) })
    expect(alertRecheckText(r, NOW).line).toBe(`Cleared at ${clock(iso(-2))}`)
  })

  it('an alert that was already clear says it is still clear, and one that came back says since when', () => {
    expect(text(alertRecheckText(alert({ before: 'resolved', after: 'resolved', resolvedAt: iso(-600) }), NOW).line)).toBe('Still clear, checked just now')
    expect(alertRecheckText(alert({ before: 'resolved', after: 'firing' }), NOW).line).toBe(`Firing again since ${clock(iso(-3600))}`)
  })

  it('a source that did not answer is named with its reason, and the wall is said to keep its last answer', () => {
    const r = alertRecheckText(alert({ sources: [src({ ok: false, error: 'grafana returned HTTP 502' })] }), NOW)
    expect(r.line).toBe('Could not check, grafana did not answer: grafana returned HTTP 502.')
    expect(r.note).toContain('last answer')
  })

  it('a click inside the gap says nothing new ran and when the last poll was', () => {
    const r = alertRecheckText(alert({ sources: [src({ ran: false, throttled: true, checkedAt: iso(-(JUST_NOW_SEC + 2)) })] }), NOW)
    expect(text(r.line)).toBe(`Still firing, checked ${JUST_NOW_SEC + 2} s ago`)
    expect(text(r.note ?? '')).toBe(`Last polled ${JUST_NOW_SEC + 2} s ago. A source is polled again at most every ${RECHECK_GAP_SEC} s.`)
  })

  it('a pushing sender that takes no requests says it reports on its own; its schedule is the sheet\'s standing sentence', () => {
    const r = alertRecheckText(alert({ sources: [], pushed: [pusher()] }), NOW)
    expect(text(r.line)).toBe('sweep reports on its own and cannot be asked to re-run this check.')
    expect(r.note).toBeNull()
    expect(`${r.line} ${r.note}`).not.toContain('so this can change next when it reports')
  })

  it('a pushing sender that was asked answers with where its request stands', () => {
    const r = alertRecheckText(alert({ sources: [], pushed: [asked()] }), NOW)
    expect(text(r.line)).toBe(`Asked sweep to re-run this check at ${clock(iso(-60))}. It picks requests up within 90 s.`)
    expect(r.note).toBeNull()
  })

  it('an alert both a poll and a pusher report leads with the poll and keeps the pusher as the note', () => {
    const r = alertRecheckText(alert({ pushed: [asked({ claimedAt: iso(-30) }, { sender: 'prod through webhook' })] }), NOW)
    expect(text(r.line)).toBe('Still firing, checked just now')
    expect(text(r.note ?? '')).toBe(`prod through webhook picked it up at ${clock(iso(-30))} and is re-running it.`)
  })

  it('a pushed alert that cleared after its sender re-ran the check says what the sender found', () => {
    const r = alertRecheckText(alert({ sources: [], before: 'firing', after: 'resolved', resolvedAt: iso(-5), pushed: [asked({ doneAt: iso(-5), outcome: 'ran' })] }), NOW)
    expect(text(r.line)).toBe(`sweep re-ran it at ${clock(iso(-5))}: cleared.`)
  })

  it('a pushed alert that is no longer firing says so and not what its sender promised', () => {
    expect(alertRecheckText(alert({ sources: [], pushed: [pusher()], after: 'resolved', resolvedAt: iso(-60) }), NOW).line).toBe(`Not firing, resolved at ${clock(iso(-60))}`)
  })

  it('an alert nothing can be asked about says so', () => {
    expect(alertRecheckText(alert({ sources: [], pushed: [] }), NOW).line).toBe('No source can be asked about this alert now.')
  })

  it('a time on another day carries its date', () => {
    const r = alertRecheckText(alert({ sources: [], pushed: [asked({ requestedAt: iso(-3 * 86400) })] }), NOW)
    expect(r.line).toMatch(/at [A-Z][a-z]{2} \d+ \d{2}:\d{2}\./)
  })

  it('never holds an em dash, a middle dot or a trailing arrow', () => {
    const all = [
      alert(),
      alert({ after: 'resolved', resolvedAt: iso(-2) }),
      alert({ sources: [src({ ok: false, error: 'x' })] }),
      alert({ sources: [], pushed: [pusher()] }),
      alert({ sources: [], pushed: [asked()] }),
      alert({ sources: [src({ throttled: true, ran: false })], pushed: [pusher()], clearsOnSweep: true })
    ].flatMap((a) => {
      const w = alertRecheckText(a, NOW)
      return [w.line, w.note ?? '']
    })
    for (const s of all) expect(s).not.toMatch(/[\u2014\u00b7\u2192]/)
  })
})

describe('an incident, in words', () => {
  it('one alert reads as that alert', () => {
    expect(incidentRecheckText([alert()], NOW)).toEqual(alertRecheckText(alert(), NOW))
  })

  it('several read as a count', () => {
    const cleared = alert({ key: 'grafana:b', after: 'resolved', resolvedAt: iso(-2) })
    expect(incidentRecheckText([alert(), cleared], NOW).line).toBe('1 of 2 alerts cleared, 1 still firing')
    expect(incidentRecheckText([cleared, { ...cleared, key: 'grafana:c' }], NOW).line).toBe('All 2 alerts cleared')
    expect(text(incidentRecheckText([alert(), alert({ key: 'grafana:b' })], NOW).line)).toBe('2 alerts still firing, checked just now')
  })

  it('names a source that failed beside the ones that answered', () => {
    const r = incidentRecheckText([alert(), alert({ key: 'vmalert:b', sources: [src({ id: 'vmalert', ok: false, error: 'x' })] })], NOW)
    expect(r.note).toContain('vmalert did not answer.')
  })

  it('beside a polled source, a pusher that cannot be asked is named in a note', () => {
    const r = incidentRecheckText([alert(), alert({ key: 'sweep:b', sources: [], pushed: [pusher()] })], NOW)
    expect(r.note).toBe('sweep reports on its own and cannot be asked to re-run this check.')
  })

  it('beside a polled source, a pusher that was asked says where its request stands under the poll\'s finding', () => {
    const r = incidentRecheckText([alert(), alert({ key: 'sweep:b', sources: [], pushed: [asked()] })], NOW)
    expect(text(r.line)).toBe('2 alerts still firing, checked just now')
    expect(text(r.note ?? '')).toContain('Asked sweep to re-run this check at')
  })

  it('several alerts of one sender that was asked read as one sentence about them, and the old wording is gone', () => {
    const both = (over: Partial<PushedRequest>): AlertRecheck[] => [
      alert({ key: 'sweep:a', sources: [], pushed: [asked(over)] }),
      alert({ key: 'sweep:b', sources: [], pushed: [asked(over)] })
    ]
    const r = incidentRecheckText(both({}), NOW)
    expect(text(r.line)).toBe(`Asked sweep to re-run 2 checks at ${clock(iso(-60))}. It picks requests up within 90 s.`)
    expect(r.note).toBeNull()
    expect(text(incidentRecheckText(both({ claimedAt: iso(-20) }), NOW).line)).toBe(`sweep picked them up at ${clock(iso(-20))} and is re-running them.`)
    for (const w of [r, incidentRecheckText([alert(), alert({ key: 'sweep:b', sources: [], pushed: [pusher()] })], NOW)]) {
      expect(`${w.line} ${w.note}`).not.toContain('come from a sender that pushes')
      expect(`${w.line} ${w.note}`).not.toContain('can change next when it reports')
    }
  })
})

describe('the whole wall, in words', () => {
  const wall = (over: Partial<WallRecheck> = {}): WallRecheck => ({
    at: iso(),
    sources: [src(), src({ id: 'netdata-cloud', kind: 'netdata-cloud' }), src({ id: 'vmalert', kind: 'vmalert' })],
    cleared: 1,
    stillFiring: 4,
    pushed: ['webhook', 'sweep'],
    ...over
  })

  it('counts the sources checked and the alerts cleared', () => {
    expect(wallRecheckText(wall(), NOW).line).toBe('3 sources checked, 1 alert cleared')
    expect(wallRecheckText(wall({ cleared: 2 }), NOW).line).toBe('3 sources checked, 2 alerts cleared')
    expect(wallRecheckText(wall({ cleared: 0 }), NOW).line).toBe('3 sources checked, none cleared, 4 still firing')
    expect(wallRecheckText(wall({ cleared: 0, stillFiring: 0 }), NOW).line).toBe('3 sources checked, nothing firing')
  })

  it('says the pushing senders push on their own schedule, truthfully for the ones that cannot be asked', () => {
    expect(wallRecheckText(wall(), NOW).note).toBe('webhook and sweep push on their own schedule, so their alerts change when they report.')
    expect(wallRecheckText(wall({ sources: [] }), NOW).note).toBe('webhook and sweep push on their own schedule, so their alerts change when they report.')
  })

  it('names the senders that take requests apart: an alert\'s Re-check asks them, the wall\'s does not', () => {
    const n = wallRecheckText(wall({ requestable: ['sweep'] }), NOW).note
    expect(n).toBe('webhook pushes on its own schedule, so its alerts change when it reports. sweep pushes on its own schedule. Re-check one of its alerts to ask it to run again.')
    expect(wallRecheckText(wall({ pushed: ['sweep'], requestable: ['sweep'] }), NOW).note).not.toContain('so their alerts change when they report')
    expect(wallRecheckText(wall({ sources: [], pushed: ['sweep'], requestable: ['sweep'] }), NOW).note).toContain('to ask it to run again')
  })

  it('names a source that did not answer and does not count it as checked', () => {
    const r = wallRecheckText(wall({ sources: [src(), src({ id: 'vmalert', ok: false, error: 'x' })] }), NOW)
    expect(r.line).toBe('1 source checked, 1 alert cleared')
    expect(r.note).toContain('vmalert did not answer.')
    expect(wallRecheckText(wall({ sources: [src({ ok: false, error: 'x' })] }), NOW).line).toBe('Could not check, grafana did not answer')
  })

  it('says nothing new ran when every source was inside the gap', () => {
    const r = wallRecheckText(wall({ sources: [src({ ran: false, throttled: true, checkedAt: iso(-(JUST_NOW_SEC + 1)) })], pushed: [] }), NOW)
    expect(text(r.note ?? '')).toBe(`Last polled ${JUST_NOW_SEC + 1} s ago. A source is polled again at most every ${RECHECK_GAP_SEC} s.`)
  })

  it('has no em dash', () => {
    for (const w of [wallRecheckText(wall(), NOW), wallRecheckText(wall({ sources: [] }), NOW)]) expect(`${w.line} ${w.note ?? ''}`).not.toMatch(/[\u2014\u00b7\u2192]/)
    expect(RECHECK_FAILED).not.toMatch(/\u2014/)
  })
})

describe('freshness', () => {
  it('is the age of the oldest answer of a polled source and ignores the senders that push', () => {
    const sources = [
      { kind: 'grafana' as const, lastOk: iso(-10) },
      { kind: 'netdata-cloud' as const, lastOk: iso(-40) },
      { kind: 'webhook' as const, lastOk: iso(-86400) }
    ]
    expect(text(freshnessText(sources, NOW) ?? '')).toBe('Checked 40 s ago')
    expect(freshnessText([{ kind: 'webhook' as const, lastOk: iso(-5) }], NOW)).toBeNull()
    expect(freshnessText([{ kind: 'grafana' as const, lastOk: iso(-1) }], NOW)).toBe('Checked just now')
    expect(checkedAgoText(null, NOW)).toBe('not yet')
  })

  it('pushedText is where the request stands, and for a sender that takes none, that it reports on its own', () => {
    expect(text(pushedText(asked({ outcome: 'ran', doneAt: iso(-10) }), NOW, 'resolved'))).toBe(`sweep re-ran it at ${clock(iso(-10))}: cleared.`)
    expect(pushedText(pusher({ request: null, sender: 'prod through webhook' }), NOW)).toBe('prod through webhook reports on its own and cannot be asked to re-run this check.')
  })
})

describe('the standing sentence: when the sender runs next and when the alert falls off', () => {
  // the sweep reported 29 min ago (it clears 24 h after that: 14:23 tomorrow) and says it runs again in 1 h 35 min
  const next = (sec: number): string => iso(sec)
  const clears = clock(iso(-1800 + 86400))

  it('a next run in the future: when, in how long, and when the alert clears on its own', () => {
    const w = text(scheduleText([pusher({ nextReportAt: next(95 * 60) })], NOW))
    expect(w).toBe(`sweep runs next at ${clock(next(95 * 60))}, in 1 h 35 min. If it stops sending this alert, it clears on its own at ${clears} tomorrow.`)
  })

  it('a next run on another day says tomorrow, and a later one says the date', () => {
    expect(text(scheduleText([pusher({ nextReportAt: next(20 * 3600) })], NOW))).toContain(`runs next at ${clock(next(20 * 3600))} tomorrow, in 20 h.`)
    expect(text(scheduleText([pusher({ nextReportAt: next(3 * 86400) })], NOW))).toMatch(/runs next at [A-Z][a-z]{2} \d+ \d{2}:\d{2}, in 3 d\./)
  })

  it('no next run: when it last reported and how often it promised to, and when the alert clears', () => {
    expect(text(scheduleText([pusher()], NOW))).toBe(`sweep last reported it at ${clock(iso(-1800))} and reports at least every 12 h. If it stops sending this alert, it clears on its own at ${clears} tomorrow.`)
  })

  it('no next run and no promise: the middle clause is dropped', () => {
    expect(text(scheduleText([pusher({ atLeastEverySec: null })], NOW))).toBe(`sweep last reported it at ${clock(iso(-1800))}. If it stops sending this alert, it clears on its own at ${clears} tomorrow.`)
  })

  it('a next run that has passed is overdue, not a time to wait for', () => {
    expect(text(scheduleText([pusher({ nextReportAt: next(-300) })], NOW))).toBe(
      `sweep was due to report at ${clock(next(-300))} and has not yet. If it stops sending this alert, it clears on its own at ${clears} tomorrow.`
    )
  })

  it('the clear time is today when it is, and the sender is named as the alert\'s own sender', () => {
    const w = text(scheduleText([pusher({ sender: 'prod through webhook', atLeastEverySec: null, clearsAt: iso(3 * 3600) })], NOW))
    expect(w).toBe(`prod through webhook last reported it at ${clock(iso(-1800))}. If it stops sending this alert, it clears on its own at ${clock(iso(3 * 3600))}.`)
  })

  it('a sender that has not reported the alert yet says so, with what clears an alert it stops sending', () => {
    expect(text(scheduleText([pusher({ lastReportedAt: null, clearsAt: null })], NOW))).toBe('sweep has not reported it yet. An alert it stops sending clears after 24 h.')
  })

  it('several alerts of one sender read as one sentence, clearing by the last of them', () => {
    const a = pusher({ nextReportAt: next(95 * 60), clearsAt: iso(-1800 + 86400) })
    const b = pusher({ nextReportAt: next(95 * 60), clearsAt: iso(-600 + 86400) })
    expect(text(scheduleText([a, b], NOW))).toBe(
      `sweep runs next at ${clock(next(95 * 60))}, in 1 h 35 min. If it stops sending these alerts, they clear on their own by ${clock(iso(-600 + 86400))} tomorrow.`
    )
  })

  it('the sheet states it for the firing alerts on the page, one sentence per sender, and for a resolved alert nothing', () => {
    const firing = { resolvedAt: null, pushed: [pusher({ nextReportAt: next(95 * 60) })] }
    const other = { resolvedAt: null, pushed: [pusher({ source: 'webhook', sender: 'prod through webhook', atLeastEverySec: null })] }
    const done = { resolvedAt: iso(-10), pushed: [pusher()] }
    expect(standingScheduleText([firing], NOW)).toBe(scheduleText([firing.pushed[0]], NOW))
    expect(text(standingScheduleText([firing, other], NOW) ?? '')).toContain('sweep runs next at')
    expect(text(standingScheduleText([firing, other], NOW) ?? '')).toContain('prod through webhook last reported it at')
    expect(standingScheduleText([done], NOW)).toBeNull()
    expect(standingScheduleText([{ resolvedAt: null }, { resolvedAt: null, pushed: [] }], NOW)).toBeNull()
    // two alerts of the sweep are one sentence, not two
    expect(standingScheduleText([firing, firing], NOW)).toBe(scheduleText([firing.pushed[0], firing.pushed[0]], NOW))
  })

  it('whenAhead says a clock time today, tomorrow after it, and the date after that', () => {
    expect(whenAhead(iso(3600), NOW)).toBe(clock(iso(3600)))
    expect(whenAhead(iso(86400), NOW)).toBe(`${clock(iso(86400))} tomorrow`)
    expect(whenAhead(iso(3 * 86400), NOW)).toMatch(/^[A-Z][a-z]{2} \d+ \d{2}:\d{2}$/)
  })

  it('a wait reads to the minute: 90 s, 35 min, 1 h 35 min, 2 h, then days', () => {
    expect(text(exactDurationText(90))).toBe('90 s')
    expect(text(exactDurationText(35 * 60))).toBe('35 min')
    expect(text(exactDurationText(95 * 60))).toBe('1 h 35 min')
    expect(text(exactDurationText(120 * 60))).toBe('2 h')
    expect(text(exactDurationText(9 * 3600 + 5 * 60))).toBe('9 h 5 min')
    expect(text(exactDurationText(3 * 86400))).toBe('3 d')
  })
})

describe('after Re-check: where the request to the sender stands', () => {
  const at = (sec: number): string => clock(iso(sec))
  const one = (over: Partial<PushedRequest>, state: 'firing' | 'resolved' = 'firing', sender: Partial<PushedSender> = {}): string | null =>
    requestText([{ p: asked(over, sender), state }], NOW)
  const sentence = (over: Partial<PushedRequest>, state: 'firing' | 'resolved' = 'firing', sender: Partial<PushedSender> = {}): string => text(one(over, state, sender) ?? '')

  it('asked and not picked up: when, and how soon the sender picks requests up', () => {
    expect(sentence({})).toBe(`Asked sweep to re-run this check at ${at(-60)}. It picks requests up within 90 s.`)
    expect(sentence({ pickupWithinSec: 600 })).toContain('within 10 min.')
  })

  it('picked up and not answered', () => {
    expect(sentence({ claimedAt: iso(-30) })).toBe(`sweep picked it up at ${at(-30)} and is re-running it.`)
  })

  it('dispatched: what it is waiting on, in its own words', () => {
    expect(sentence({ claimedAt: iso(-30), outcome: 'dispatched', note: 'CI run 38915925999' })).toBe('sweep is waiting on CI run 38915925999.')
    expect(sentence({ claimedAt: iso(-30), outcome: 'dispatched', note: 'CI run 38915925999.' })).toBe('sweep is waiting on CI run 38915925999.')
    expect(sentence({ claimedAt: iso(-30), outcome: 'dispatched' })).toBe('sweep has started a run and is waiting on it.')
  })

  it('ran: when, and what it found from the alert\'s state', () => {
    expect(sentence({ claimedAt: iso(-30), outcome: 'ran', doneAt: iso(-20) }, 'firing')).toBe(`sweep re-ran it at ${at(-20)}: still firing.`)
    expect(sentence({ claimedAt: iso(-30), outcome: 'ran', doneAt: iso(-20) }, 'resolved')).toBe(`sweep re-ran it at ${at(-20)}: cleared.`)
  })

  it('failed: why', () => {
    expect(sentence({ outcome: 'failed', doneAt: iso(-20), note: 'intake.sh exited 2' })).toBe('sweep could not re-run it: intake.sh exited 2.')
    expect(sentence({ outcome: 'failed', doneAt: iso(-20) })).toBe('sweep could not re-run it.')
  })

  it('unsupported: that it cannot, and when it runs next, or the promise when it did not say', () => {
    const done = { outcome: 'unsupported' as const, doneAt: iso(-20) }
    expect(text(requestText([{ p: asked(done, { nextReportAt: iso(95 * 60) }), state: 'firing' }], NOW) ?? '')).toBe(`sweep cannot re-run this check on demand. It runs next at ${at(95 * 60)}.`)
    expect(sentence(done)).toBe('sweep cannot re-run this check on demand. It reports at least every 12 h.')
    expect(sentence(done, 'firing', { atLeastEverySec: null })).toBe('sweep cannot re-run this check on demand. It reports when an alert changes.')
    expect(text(requestText([{ p: asked(done, { nextReportAt: iso(-300) }), state: 'firing' }], NOW) ?? '')).toBe(`sweep cannot re-run this check on demand. It was due to report at ${at(-300)} and has not yet.`)
  })

  it('expired: never picked up within 30 min', () => {
    expect(sentence({ expired: true, requestedAt: iso(-31 * 60) })).toBe('sweep did not pick the request up within 30 min.')
  })

  it('picked up and then silent for 30 min is not "did not pick it up"', () => {
    expect(sentence({ expired: true, requestedAt: iso(-31 * 60), claimedAt: iso(-30 * 60) })).toBe(`sweep picked it up at ${at(-30 * 60)} and has not reported back.`)
    expect(sentence({ expired: true, requestedAt: iso(-31 * 60), claimedAt: iso(-30 * 60), outcome: 'dispatched', note: 'CI run 5' })).toBe('sweep was waiting on CI run 5 and has not reported back.')
  })

  it('names the sender as the alert\'s own sender', () => {
    expect(sentence({}, 'firing', { sender: 'prod through webhook' })).toMatch(/^Asked prod through webhook to re-run this check at/)
  })

  it('no request, or a source that takes none, has no sentence', () => {
    expect(requestText([{ p: pusher(), state: 'firing' }], NOW)).toBeNull()
    expect(requestText([{ p: pusher({ request: request({ id: null }) }), state: 'firing' }], NOW)).toBeNull()
    expect(requestPhase(null)).toBe('none')
    expect(requestPhase(request({ id: null }))).toBe('none')
  })

  it('every state is told once and no sentence of it holds an em dash, a middle dot or an arrow', () => {
    const states: Array<Partial<PushedRequest>> = [
      {},
      { claimedAt: iso(-30) },
      { claimedAt: iso(-30), outcome: 'dispatched', note: 'CI run 1' },
      { claimedAt: iso(-30), outcome: 'ran', doneAt: iso(-20) },
      { outcome: 'failed', doneAt: iso(-20), note: 'x' },
      { outcome: 'unsupported', doneAt: iso(-20) },
      { expired: true },
      { expired: true, claimedAt: iso(-20) }
    ]
    const phases = states.map((o) => requestPhase(request(o)))
    expect(phases).toEqual(['asked', 'claimed', 'dispatched', 'ran', 'failed', 'unsupported', 'expired', 'lost'])
    for (const o of states) for (const st of ['firing', 'resolved'] as const) expect(one(o, st) ?? '').not.toMatch(/[\u2014\u00b7\u2192]/)
  })

  it('several alerts asked of one sender read as one sentence with a count, in the state of the one still moving', () => {
    const ps = (over: Array<Partial<PushedRequest>>, states: Array<'firing' | 'resolved'> = []) => over.map((o, i) => ({ p: asked({ id: `rr_${i}`, ...o }), state: states[i] ?? ('firing' as const) }))
    expect(text(requestText(ps([{}, {}]), NOW) ?? '')).toBe(`Asked sweep to re-run 2 checks at ${at(-60)}. It picks requests up within 90 s.`)
    expect(text(requestText(ps([{ claimedAt: iso(-30) }, { claimedAt: iso(-30) }]), NOW) ?? '')).toBe(`sweep picked them up at ${at(-30)} and is re-running them.`)
    // one has run, one is still going: the one still going is told
    expect(text(requestText(ps([{ claimedAt: iso(-30), outcome: 'ran', doneAt: iso(-20) }, { claimedAt: iso(-30) }]), NOW) ?? '')).toContain('picked them up')
    const done = { claimedAt: iso(-30), outcome: 'ran' as const, doneAt: iso(-20) }
    expect(text(requestText(ps([done, done], ['resolved', 'firing']), NOW) ?? '')).toBe(`sweep re-ran 2 checks at ${at(-20)}: 1 cleared, 1 still firing.`)
    expect(text(requestText(ps([done, done], ['resolved', 'resolved']), NOW) ?? '')).toBe(`sweep re-ran 2 checks at ${at(-20)}: all cleared.`)
    expect(text(requestText(ps([done, done]), NOW) ?? '')).toBe(`sweep re-ran 2 checks at ${at(-20)}: all still firing.`)
    expect(text(requestText(ps([{ outcome: 'failed', doneAt: iso(-20), note: 'no token' }, { outcome: 'failed', doneAt: iso(-20), note: 'no token' }]), NOW) ?? '')).toBe('sweep could not re-run them: no token.')
    expect(text(requestText(ps([{ expired: true }, { expired: true }]), NOW) ?? '')).toBe('sweep did not pick the requests up within 30 min.')
  })

  it('the sheet overlays what it fetched since the press, unless the fetch is older than the press', () => {
    const pressed = alert({ sources: [], pushed: [asked({ id: 'rr_2', requestedAt: iso(-10) })] })
    // a refresh that caught up: the request has moved on and the alert cleared
    const fresh = { resolvedAt: iso(-1), pushed: [asked({ id: 'rr_2', requestedAt: iso(-10), claimedAt: iso(-8), outcome: 'ran', doneAt: iso(-1) })] }
    const live = alertRecheckText(withLiveAlert(pressed, fresh), NOW)
    expect(text(live.line)).toBe(`sweep re-ran it at ${at(-1)}: cleared.`)
    // a refresh that started before the press still holds the older request: the answer's own stays
    const stale = { resolvedAt: null, pushed: [asked({ id: 'rr_1', requestedAt: iso(-3600), outcome: 'ran', doneAt: iso(-3500) })] }
    expect(text(alertRecheckText(withLiveAlert(pressed, stale), NOW).line)).toBe(`Asked sweep to re-run this check at ${at(-10)}. It picks requests up within 90 s.`)
    // nothing fetched yet, or an alert a polled source reports: the answer stands, and its poll's finding is not rewritten
    expect(withLiveAlert(pressed, undefined)).toBe(pressed)
    const polled = alert({ pushed: [asked()] })
    expect(withLiveAlert(polled, { resolvedAt: iso(-1), pushed: [] })).toMatchObject({ after: 'firing', resolvedAt: null })
  })
})

describe('the markup', () => {
  it('a button has a visible label, an accessible name that starts with it, and says it is busy without moving', () => {
    const rest = renderToStaticMarkup(createElement(RecheckButton, { busy: false, label: 'Re-check', name: 'Re-check node-4 disk', onPress: () => undefined }))
    expect(rest).toContain('aria-label="Re-check node-4 disk"')
    expect(rest).toContain('aria-busy="false"')
    expect(rest).toContain('type="button"')
    expect(rest).toContain('>Re-check<')
    const busy = renderToStaticMarkup(createElement(RecheckButton, { busy: true, label: 'Re-check', name: 'Re-check node-4 disk', onPress: () => undefined }))
    expect(busy).toContain('aria-busy="true"')
    expect(busy).not.toContain('aria-label=')
    expect(busy).toContain('>Re-check<')
    expect(busy).toContain(', checking')
    expect(busy).toContain('aria-hidden="true"')
  })

  it('the wall button needs no aria-label: its visible words are its name', () => {
    expect(renderToStaticMarkup(createElement(RecheckButton, { busy: false, label: 'Re-check now', onPress: () => undefined }))).not.toContain('aria-label')
  })

  it('the line is a polite live region that exists before it has anything to say, and says Checking while busy', () => {
    const empty = renderToStaticMarkup(createElement(RecheckLine, { id: 'x', busy: false, words: null }))
    expect(empty).toContain('role="status"')
    expect(empty).toContain('aria-live="polite"')
    expect(empty).toContain('><')
    expect(renderToStaticMarkup(createElement(RecheckLine, { id: 'x', busy: true, words: { line: 'old', note: 'old note' } }))).toContain('>Checking<')
    const done = renderToStaticMarkup(createElement(RecheckLine, { id: 'x', busy: false, words: { line: 'Still firing, checked just now', note: 'A note.' } }))
    expect(done).toContain('Still firing, checked just now')
    expect(done).toContain('A note.')
    expect(renderToStaticMarkup(createElement(RecheckLine, { id: 'x', busy: false, words: null, failed: true }))).toContain(RECHECK_FAILED)
  })

  it('the standing sentence is a note in the existing style, outside the live region, and stays while busy and before any answer', () => {
    const standing = 'sweep runs next at 16:07, in 1 h 35 min.'
    const rest = renderToStaticMarkup(createElement(RecheckLine, { id: 'x', busy: false, words: null, standing }))
    expect(rest).toContain(`<p class="recheck__note">${standing}</p>`)
    expect(rest.indexOf('role="status"')).toBeLessThan(rest.indexOf('recheck__note'))
    expect(rest).toMatch(/<p class="recheck__line" role="status" aria-live="polite"><\/p>/)
    expect(renderToStaticMarkup(createElement(RecheckLine, { id: 'x', busy: true, words: null, standing }))).toContain(standing)
    expect(renderToStaticMarkup(createElement(RecheckLine, { id: 'x', busy: false, words: null, failed: true, standing }))).toContain(standing)
    const both = renderToStaticMarkup(createElement(RecheckLine, { id: 'x', busy: false, words: { line: 'Asked it.', note: 'A note.' }, standing }))
    expect(both.indexOf('Asked it.')).toBeLessThan(both.indexOf('A note.'))
    expect(both.indexOf('A note.')).toBeLessThan(both.indexOf(standing))
    expect(renderToStaticMarkup(createElement(RecheckLine, { id: 'x', busy: false, words: null, standing: null }))).not.toContain('recheck__note')
  })
})

describe('how the controls are built', () => {
  const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

  it('a press only acknowledges: the hooks mark busy and queue the request behind the settle seam, and nothing else fetches', () => {
    const hooks = read('src/web/lib/use-recheck.ts')
    expect(hooks).toContain("from './settle.ts'")
    expect(hooks.match(/afterSettle\(/g)).toHaveLength(2)
    // the request sits inside the queued job, never straight in a handler
    for (const body of hooks.split('afterSettle(').slice(1)) expect(body.slice(0, 400)).toContain('api<')
    const before = hooks.split('afterSettle(')[0]
    expect(before).not.toMatch(/api<[A-Za-z]+>\(/)
    const ui = read('src/web/components/Recheck.tsx')
    expect(ui).not.toContain('fetch(')
    expect(ui).not.toContain('api(')
    expect(ui).not.toContain('setTimeout')
  })

  it('the seam releases on the real end of an animation plus one idle slot, skips the endless spinner, and uses no timer on a motion length', () => {
    const seam = read('src/web/lib/settle.ts')
    expect(seam).toContain('document.getAnimations()')
    expect(seam).toContain('.finished')
    expect(seam).toContain('requestIdleCallback')
    expect(seam).toContain('Number.isFinite(t.endTime)')
    expect(seam).not.toMatch(/setTimeout\([^)]*(duration|transition)/i)
    expect(seam).not.toContain('InteractionManager')
  })

  it('the spinner is declared with a reduced-motion guard in the same file, on token numbers only', () => {
    const css = read('src/web/styles/wall.css')
    // the re-check section only: it ends where the next banner comment ("the name prompt and the name field") opens
    const from = css.indexOf('re-check: the wall')
    const to = css.indexOf('/* ---- ', from)
    expect(from).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(from)
    const block = css.slice(from, to)
    expect(block).toContain('@keyframes recheck-spin')
    expect(block).toContain('prefers-reduced-motion: reduce')
    expect(block).toContain('var(--duration-spin)')
    expect(block).toContain('var(--turn-full)')
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(block).not.toMatch(/\d+(\.\d+)?(ms|s)\b/)
    expect(block).not.toMatch(/border-radius|font-family/)
    const tokens = read('src/web/styles/tokens.css')
    expect(tokens).toContain('--duration-spin: calc(var(--duration-300) * 4)')
    expect(tokens).toContain('--turn-full: 360deg')
  })

  it('no copy of the feature holds an em dash', () => {
    for (const f of ['src/web/lib/recheck.ts', 'src/web/components/Recheck.tsx', 'src/server/recheck.ts', 'src/server/push-recheck.ts', 'src/shared/recheck.ts', 'src/web/lib/use-recheck.ts', 'src/web/lib/settle.ts', 'src/web/lib/format.ts']) {
      expect(read(f)).not.toMatch(/\u2014/)
    }
  })

  it('the request state moves with the sheet\'s own refresh: no new timer, and the standing note needs no style of its own', () => {
    const sheet = read('src/web/components/Sheets.tsx')
    expect(sheet).not.toMatch(/setInterval|setTimeout/)
    expect(sheet).toContain('/api/incidents/${encodeURIComponent(incidentKey)}`, 5000)')
    expect(read('src/web/components/Recheck.tsx')).not.toMatch(/setInterval|setTimeout|useEffect/)
    const css = read('src/web/styles/wall.css')
    const from = css.indexOf('re-check: the wall')
    const block = css.slice(from, css.indexOf('/* ---- ', from))
    // a note beside an empty live region keeps the text block on the page; with no note the empty region still takes no room
    expect(block).toContain('.recheck__text:not(:has(.recheck__line:not(:empty), .recheck__note))')
    expect(block.match(/\.recheck__note\b/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('the old wording is gone from the words, the server and the sheet', () => {
    for (const f of ['src/web/lib/recheck.ts', 'src/web/components/Recheck.tsx', 'src/web/components/Sheets.tsx', 'src/server/recheck.ts', 'src/shared/recheck.ts']) {
      expect(read(f)).not.toContain('so this can change next when it reports')
    }
  })
})
