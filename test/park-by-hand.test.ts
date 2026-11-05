// Park by hand (docs/design.md, Parked): a firing incident of ANY source taken off the live wall by whoever fixed or judged it, for at most 72 h, with a name and a
// reason on it. Covers the checker (`checkPark`), the state function with a hand-set park (`governingPark`, `parkHolds`, `incidentState`'s `manualPark`), the engine
// (`Engine.park`, `unpark`, `manualParkOf` and every way a park ends), the History wording, POST /api/incidents/:key/park and /unpark, the MCP `park` and `unpark`
// tools, and the words on a tile and in a sheet. Written, not run, in the session that added it (agent test runs were off). Run it with
// `npx vitest run --configLoader runner test/park-by-hand.test.ts` from the repo root. The clock is fixed in every case; nothing here reads the real time.
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/server/app.ts'
import type { AppDeps } from '../src/server/app.ts'
import type { RouteConfig, WatchConfig } from '../src/server/config.ts'
import { makeAlert } from '../src/server/derive.ts'
import type { AlertDraft } from '../src/server/derive.ts'
import { migrate, openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'
import { planSends } from '../src/server/notify/plan.ts'
import type { Plan } from '../src/server/notify/plan.ts'
import type { LogRow } from '../src/server/notify/types.ts'
import { SqlitePushStore } from '../src/server/stores.ts'
import { PARK_NOTE_MAX, PARK_REF_MAX, PARK_STATES, checkPark } from '../src/shared/agent.ts'
import { eventLine, eventSaying, utcStamp } from '../src/shared/event-text.ts'
import { PARK_MAX_MS, governingPark, incidentState, isParked, parkHolds, parkOf, unattendedSecOf } from '../src/shared/incident.ts'
import type { StateInput } from '../src/shared/incident.ts'
import { summaryOf } from '../src/shared/summary.ts'
import type { Alert, AlertEvent, Incident, Observation, Park, ParkedState } from '../src/shared/types.ts'
import { FALLBACK_NAME } from '../src/shared/who.ts'
import { PARK_REASON, parkedDetail, parkedLine, parkedParts } from '../src/web/lib/ack.ts'
import { parkStampText } from '../src/web/lib/format.ts'

const T0 = Date.parse('2026-10-16T12:00:00Z')
const H = 3_600_000
const MIN = 60_000
let clock = T0
const iso = (ms: number = clock): string => new Date(ms).toISOString()
/** When the incidents below began: two hours before T0, so an unattended clock that restarts at a park's end is told apart from one that never stopped. */
const STARTED = T0 - 2 * H
const TOKEN = 'park-test-token-'.padEnd(64, '0')
/** A time stamp as the wall words it ("Oct 17, 04:00"): the zone and locale of the machine decide the digits, so the shape is what is checked. */
const STAMP = '[A-Z][a-z]{2} \\d{1,2}, \\d{2}:\\d{2}'

const cfg: WatchConfig = {
  baseUrl: 'https://watch.test',
  port: 0,
  host: '127.0.0.1',
  dataDir: ':memory:',
  historyHours: 24,
  staleAfterMisses: 3,
  sources: [
    { id: 'grafana', type: 'grafana', url: 'http://g', tokenEnv: 'X', pollSec: 10 },
    { id: 'sweep', type: 'webhook', tokenEnv: 'T', staleAfterSec: 43200, presenceTtlSec: 86400 }
  ],
  serviceMap: [],
  channels: [],
  routes: [],
  quietHours: null
}

// ---- shared fixtures -------------------------------------------------------------------------------------------------------------

let engine: Engine
let nudges: number
beforeEach(() => {
  clock = T0
  nudges = 0
  engine = new Engine(openDb(':memory:'), cfg, () => clock)
})

/** A Grafana-style alert with NO annotations: the proof that a park by hand needs nothing from the source. */
function grafana(over: { startsAtMs?: number; fingerprint?: string; host?: string } = {}): Alert {
  const host = over.host ?? 'node-4'
  return makeAlert(
    {
      origin: 'grafana',
      fingerprint: over.fingerprint ?? 'a1b2c3d4e5f60718',
      rule: 'DiskFull',
      labels: { alertname: 'DiskFull', severity: 'warning', host, service: 'Disk' },
      annotations: { summary: `DiskFull on ${host}` },
      startsAt: iso(over.startsAtMs ?? STARTED),
      via: { source: 'grafana', kind: 'grafana', lastSeen: iso() },
      raw: {},
      links: {}
    },
    [],
    iso()
  )
}
/** One complete Grafana poll: whatever it omits resolves. */
const poll = (...firing: Alert[]): Observation => ({ source: 'grafana', kind: 'grafana', at: iso(), firing, resolved: [], complete: true })
const fire = (e: Engine = engine, over: { startsAtMs?: number; fingerprint?: string; host?: string } = {}): string => {
  e.ingest(poll(grafana(over)))
  return e.wall().incidents[0].key
}

/** A sweep alert that may state a park in its annotations (the other way an incident gets parked). */
function sweepAlert(rule: string, annotations: Record<string, string> = {}): Alert {
  const draft: AlertDraft = {
    origin: 'sweep',
    rule,
    labels: { alertname: rule, service: 'Regression sweep', severity: 'warning' },
    annotations: { summary: `${rule} is red`, ...annotations },
    startsAt: iso(STARTED),
    via: { source: 'sweep', kind: 'webhook', lastSeen: iso() },
    raw: {},
    fingerprint: `${rule.length.toString(16).padStart(2, '0')}${rule.charCodeAt(0).toString(16)}b2c3d4e5f60718`
  }
  return makeAlert(draft, [], iso())
}
const sweepPush = (...firing: Alert[]): Observation => ({ source: 'sweep', kind: 'webhook', at: iso(), firing, resolved: [], complete: false })

/** The annotations that state a park, as the sweep writes them. */
const ann = (until: number | string, state = 'deferred', extra: Record<string, string> = {}): Record<string, string> => ({
  parked_state: state,
  parked_until: typeof until === 'number' ? iso(until) : until,
  ...extra
})
/** A park set by hand, as the state function and the engine hold it. */
const hand = (untilMs: number, over: Partial<Park> = {}): Park => ({
  state: 'fixed_undeployed',
  until: iso(untilMs),
  since: iso(T0 - 5 * MIN),
  ref: 'SB-1',
  note: 'fix merged, waits for the deploy',
  by: 'agent: claude',
  ...over
})
/** What `Engine.park` is given. */
const ask = (over: Partial<{ state: ParkedState; until: string; by: string; note: string; ref: string }> = {}) => ({
  state: 'awaiting_source' as ParkedState,
  until: iso(T0 + 6 * H),
  by: 'agent: claude',
  note: 'the fix is live and the alert window has not caught up',
  ref: 'SB-9' as string | undefined,
  ...over
})

const incidentOf = (e: Engine, key: string): Incident => {
  const found = e.wall().incidents.find((i) => i.key === key)
  if (!found) throw new Error(`no firing incident ${key}`)
  return found
}
const parkKeys = (e: Engine): string[] => (e.db.prepare('SELECT incident_key FROM parks ORDER BY incident_key').all() as unknown as Array<{ incident_key: string }>).map((r) => r.incident_key)
const eventsOf = (e: Engine, key: string, kind: string): AlertEvent[] => e.incidentDetail(key).events.filter((x) => x.kind === kind)

// ---- 1. checkPark ------------------------------------------------------------------------------------------------------------------

describe('1. checkPark: what a park set by hand may say', () => {
  const good = { state: 'deferred', until: iso(T0 + 2 * H), note: 'a person chose a later date' }
  /** The error of a refusal; fails the case when the input is taken. */
  const refusal = (raw: Parameters<typeof checkPark>[0], nowMs = T0): string => {
    const r = checkPark(raw, nowMs)
    expect(r.ok, JSON.stringify(raw)).toBe(false)
    return r.ok ? '' : r.error
  }

  it('takes each of the three states and answers the state, the end as ISO UTC, the note and an empty ref', () => {
    expect([...PARK_STATES]).toEqual(['fixed_undeployed', 'deferred', 'awaiting_source'])
    for (const state of PARK_STATES) {
      expect(checkPark({ ...good, state }, T0)).toEqual({ ok: true, state, until: iso(T0 + 2 * H), note: good.note, ref: '' })
    }
  })

  it('reads the state in any case and ignoring the spaces around it', () => {
    expect(checkPark({ ...good, state: 'FIXED_UNDEPLOYED' }, T0)).toMatchObject({ ok: true, state: 'fixed_undeployed' })
    expect(checkPark({ ...good, state: ' Awaiting_Source ' }, T0)).toMatchObject({ ok: true, state: 'awaiting_source' })
    expect(checkPark({ ...good, state: 'DEFERRED' }, T0)).toMatchObject({ ok: true, state: 'deferred' })
  })

  it('refuses a missing, blank, unknown or non-text state and names the three that are taken', () => {
    for (const state of [undefined, null, '', '   ', 'snoozed', 'fixed', 'fixed undeployed', 42, ['deferred']]) {
      expect(refusal({ ...good, state })).toContain(`state must be one of ${PARK_STATES.join(', ')}`)
    }
    expect(refusal({})).toContain('state must be one of')
  })

  it('refuses an until that is missing, not text, unzoned, a date only or not a real time, and gives an example', () => {
    for (const until of [undefined, null, 42, '', 'tomorrow', '2026-10-17T04:00:00', '2026-10-17T04:00', '2026-10-17', '2026-13-45T99:00:00Z']) {
      const error = refusal({ ...good, until })
      expect(error).toMatch(/until must be an ISO 8601 time with a zone/)
      expect(error).toContain(`for example ${iso(T0 + 24 * H)}`)
      expect(error).toContain(`it is ${iso(T0)} now`)
    }
  })

  it('refuses an until in the past and an until that is exactly now', () => {
    for (const until of [iso(T0 - 5 * H), iso(T0 - 1), iso(T0)]) {
      const error = refusal({ ...good, until })
      expect(error).toContain('until must be after now')
      expect(error).toContain(iso(T0))
    }
  })

  it('reads a zone as an offset and answers in UTC; an offset that lands on now is still refused', () => {
    expect(checkPark({ ...good, until: '2026-10-16T16:00:00+02:00' }, T0)).toMatchObject({ ok: true, until: iso(T0 + 2 * H) })
    expect(checkPark({ ...good, until: '2026-10-16T14:00:00Z' }, T0)).toMatchObject({ ok: true, until: iso(T0 + 2 * H) })
    expect(refusal({ ...good, until: '2026-10-16T14:00:00+02:00' })).toContain('until must be after now')
  })

  it('takes exactly 72 h ahead and refuses 72 h and one millisecond, naming the latest time and not shortening', () => {
    expect(PARK_MAX_MS).toBe(72 * H)
    expect(checkPark({ ...good, until: iso(T0 + 72 * H) }, T0)).toMatchObject({ ok: true, until: iso(T0 + 72 * H) })
    expect(checkPark({ ...good, until: '2026-10-19T14:00:00+02:00' }, T0)).toMatchObject({ ok: true, until: iso(T0 + 72 * H) })
    const r = checkPark({ ...good, until: iso(T0 + 72 * H + 1) }, T0)
    expect(r.ok).toBe(false)
    // refused, not shortened: the answer carries no until of its own to use instead
    expect(r).not.toHaveProperty('until')
    const error = r.ok ? '' : r.error
    expect(error).toContain('at most 72 hours')
    expect(error).toContain('refused, not shortened')
    expect(error).toContain(`The latest time it takes is ${iso(T0 + 72 * H)}`)
    expect(error).toContain(iso(T0 + 72 * H + 1))
    // far past the ceiling says how far out it was
    expect(refusal({ ...good, until: iso(T0 + 7 * 24 * H) })).toContain('168 hours out')
  })

  it('needs a note: missing, empty and blank are refused; 500 characters are taken and 501 are not; trimmed; counted by character', () => {
    for (const note of [undefined, null, '', '   \n\t ', 42]) expect(refusal({ ...good, note })).toBe('note is required and may not be empty')
    expect(PARK_NOTE_MAX).toBe(500)
    const full = checkPark({ ...good, note: 'n'.repeat(500) }, T0)
    expect(full).toMatchObject({ ok: true })
    expect(full.ok && full.note.length).toBe(500)
    expect(refusal({ ...good, note: 'n'.repeat(501) })).toBe('note is 501 characters; the most is 500')
    expect(checkPark({ ...good, note: '  why\u0007 it is parked  ' }, T0)).toMatchObject({ ok: true, note: 'why it is parked' })
    // an emoji is one character, though two UTF-16 units
    expect(checkPark({ ...good, note: '\u{1F600}'.repeat(500) }, T0)).toMatchObject({ ok: true })
    expect(refusal({ ...good, note: '\u{1F600}'.repeat(501) })).toBe('note is 501 characters; the most is 500')
  })

  it('takes an optional ref: absent, null and blank read as none; 64 characters are taken and 65 are not; line ends are folded', () => {
    for (const ref of [undefined, null, '', '   ']) expect(checkPark({ ...good, ref }, T0)).toMatchObject({ ok: true, ref: '' })
    expect(PARK_REF_MAX).toBe(64)
    expect(checkPark({ ...good, ref: 'r'.repeat(64) }, T0)).toMatchObject({ ok: true, ref: 'r'.repeat(64) })
    expect(refusal({ ...good, ref: 'r'.repeat(65) })).toBe('ref is 65 characters; the most is 64')
    expect(checkPark({ ...good, ref: 'SB-1\nfix  lands\r\nsoon' }, T0)).toMatchObject({ ok: true, ref: 'SB-1 fix lands soon' })
    expect(checkPark({ ...good, ref: '  SB-2\t' }, T0)).toMatchObject({ ok: true, ref: 'SB-2' })
  })

  it('checks the state first, then the end, then the note, then the ref', () => {
    expect(refusal({ state: 'nope', until: 'nope', note: '', ref: 'r'.repeat(99) })).toContain('state must be one of')
    expect(refusal({ state: 'deferred', until: 'nope', note: '', ref: 'r'.repeat(99) })).toContain('until must be an ISO 8601 time')
    expect(refusal({ state: 'deferred', until: iso(T0 + H), note: '', ref: 'r'.repeat(99) })).toContain('note is required')
    expect(refusal({ state: 'deferred', until: iso(T0 + H), note: 'why', ref: 'r'.repeat(99) })).toContain('ref is 99 characters')
  })
})

// ---- 2. the state function with a hand-set park ----------------------------------------------------------------------------------

describe('2. incidentState and governingPark with a park set by hand', () => {
  const startsAtMs = T0 - 9 * H
  const state = (over: Partial<StateInput> = {}) => incidentState({ severity: 'warning', instances: 1, startsAtMs, nowMs: T0, ...over })

  it('parkHolds: after now and no more than 72 h out, and never for none', () => {
    expect(parkHolds(null, T0)).toBe(false)
    expect(parkHolds({ until: iso(T0 - H) }, T0)).toBe(false)
    expect(parkHolds({ until: iso(T0 - 1) }, T0)).toBe(false)
    expect(parkHolds({ until: iso(T0) }, T0)).toBe(false)
    expect(parkHolds({ until: iso(T0 + 1) }, T0)).toBe(true)
    expect(parkHolds({ until: iso(T0 + 72 * H) }, T0)).toBe(true)
    expect(parkHolds({ until: iso(T0 + 72 * H + 1) }, T0)).toBe(false)
  })

  it('a hand park that holds is parked: the quiet tier at the quiet weight, counted as firing nowhere, with its name, and a clock that has not started', () => {
    const manual = hand(T0 + 3 * H)
    const s = state({ manualPark: manual })
    expect(s).toMatchObject({ attention: 'parked', tier: 'quiet', R: 1, firing: false, band: 0, unattendedSinceMs: startsAtMs })
    expect(s.park).toEqual(manual)
    expect(s.park?.by).toBe('agent: claude')
    expect(unattendedSecOf(s, null, T0)).toBe(0)
    expect(isParked({ state: s })).toBe(true)
    // a page that is parked is not a page
    expect(state({ severity: 'page', instances: 4, manualPark: manual })).toMatchObject({ attention: 'parked', tier: 'quiet', R: 1 })
  })

  it('an acknowledgement beats it, and its age still freezes at the ack', () => {
    const s = state({ manualPark: hand(T0 + 3 * H), ackedAtMs: T0 - 30 * MIN })
    expect(s).toMatchObject({ attention: 'acked', tier: 'warning', firing: true, park: null })
    expect(unattendedSecOf(s, T0 - 30 * MIN, T0)).toBe(8.5 * 3600)
  })

  it('a silence beats it, and beats an acknowledgement too', () => {
    const silenced = state({ manualPark: hand(T0 + 3 * H), silencedUntilMs: T0 + H })
    expect(silenced).toMatchObject({ attention: 'silenced', tier: 'quiet', R: 1, firing: true, park: null })
    expect(state({ manualPark: hand(T0 + 3 * H), silencedUntilMs: T0 + H, ackedAtMs: T0 - MIN }).attention).toBe('silenced')
    // a silence that has run out gives the park back
    expect(state({ manualPark: hand(T0 + 3 * H), silencedUntilMs: T0 - 1 }).attention).toBe('parked')
  })

  it('an expired hand park hands the incident back: attention none, its tier, and the unattended clock starts at the end of the park', () => {
    const until = T0 - 5 * MIN
    const s = state({ manualPark: hand(until) })
    expect(s).toMatchObject({ attention: 'none', tier: 'warning', firing: true, band: 0, park: null, unattendedSinceMs: until })
    expect(unattendedSecOf(s, null, T0)).toBe(300)
    // never the first firing: two hours later it is five minutes older than two hours, not eleven hours
    const later = state({ manualPark: hand(until), nowMs: T0 + 2 * H })
    expect(later.unattendedSinceMs).toBe(until)
    expect(later.band).toBe(2)
    // a page comes back as a page
    expect(state({ severity: 'page', manualPark: hand(until) })).toMatchObject({ attention: 'none', tier: 'page' })
  })

  it('unattendedSinceMs is the later of the incident start and the end of the park', () => {
    // the park ended before the incident began: nothing changes
    expect(state({ startsAtMs: T0 - 60 * MIN, manualPark: hand(T0 - 2 * H) }).unattendedSinceMs).toBe(T0 - 60 * MIN)
    // the park ended after it began
    expect(state({ startsAtMs: T0 - 60 * MIN, manualPark: hand(T0 - 10 * MIN) }).unattendedSinceMs).toBe(T0 - 10 * MIN)
    // ending exactly now is ended: the clock starts now
    const s = state({ manualPark: hand(T0) })
    expect(s).toMatchObject({ attention: 'none', unattendedSinceMs: T0 })
    expect(unattendedSecOf(s, null, T0)).toBe(0)
  })

  it('a hand park outranks the annotations\' park while it holds, and the annotation park\'s own end is ignored', () => {
    const s = state({ manualPark: hand(T0 + 2 * H), annotations: [ann(T0 + 20 * H)] })
    expect(s.attention).toBe('parked')
    expect(s.park?.by).toBe('agent: claude')
    expect(s.park?.until).toBe(iso(T0 + 2 * H))
    expect(s.park?.state).toBe('fixed_undeployed')
    // the annotation park ends sooner than the hand park: still the hand park that speaks
    const sooner = state({ manualPark: hand(T0 + 20 * H), annotations: [ann(T0 + 2 * H)] })
    expect(sooner.park?.by).toBe('agent: claude')
    expect(sooner.park?.until).toBe(iso(T0 + 20 * H))
  })

  it('after the hand park has ended an annotation park that still holds takes over, with no name on it', () => {
    const s = state({ manualPark: hand(T0 - 5 * MIN), annotations: [ann(T0 + 5 * H)] })
    expect(s).toMatchObject({ attention: 'parked', firing: false, unattendedSinceMs: startsAtMs })
    expect(s.park?.until).toBe(iso(T0 + 5 * H))
    expect(s.park).not.toHaveProperty('by')
  })

  it('a hand park more than 72 h out is not honoured: unattended from the incident\'s own start, or the annotations\' park if that holds', () => {
    const alone = state({ manualPark: hand(T0 + 72 * H + 1) })
    expect(alone).toMatchObject({ attention: 'none', firing: true, park: null, unattendedSinceMs: startsAtMs })
    expect(state({ manualPark: hand(T0 + 72 * H) }).attention).toBe('parked')
    const withAnnotation = state({ manualPark: hand(T0 + 100 * H), annotations: [ann(T0 + 3 * H)] })
    expect(withAnnotation.attention).toBe('parked')
    expect(withAnnotation.park?.until).toBe(iso(T0 + 3 * H))
    expect(withAnnotation.park).not.toHaveProperty('by')
  })

  it('when neither holds the clock starts at the end of the park that ended last; a claim too far out never counts as ended', () => {
    // hand park ended five minutes ago, annotations claim something a week out: the clock is the hand park's end
    const a = state({ manualPark: hand(T0 - 5 * MIN), annotations: [ann(T0 + 100 * H)] })
    expect(a).toMatchObject({ attention: 'none', park: null, unattendedSinceMs: T0 - 5 * MIN })
    // the annotation park ended later than the hand park: the later end
    const b = state({ manualPark: hand(T0 - 30 * MIN), annotations: [ann(T0 - 2 * MIN)] })
    expect(b.unattendedSinceMs).toBe(T0 - 2 * MIN)
    // and the other way round
    const c = state({ manualPark: hand(T0 - 2 * MIN), annotations: [ann(T0 - 30 * MIN)] })
    expect(c.unattendedSinceMs).toBe(T0 - 2 * MIN)
    // a hand park a week out and nothing else: unattended from the start
    expect(state({ manualPark: hand(T0 + 7 * 24 * H) })).toMatchObject({ attention: 'none', unattendedSinceMs: startsAtMs })
  })

  it('a park already read (a roll-up) still replaces both the annotations and the hand park', () => {
    const rolled = parkOf(ann(T0 + 7 * H)) as Park
    const s = state({ park: rolled, manualPark: hand(T0 + H), annotations: [ann(T0 + 2 * H)] })
    expect(s.attention).toBe('parked')
    expect(s.park?.until).toBe(iso(T0 + 7 * H))
    expect(s.park).not.toHaveProperty('by')
    expect(state({ park: null, manualPark: hand(T0 + H), annotations: [ann(T0 + 2 * H)] }).attention).toBe('none')
    // a rolled-up park that has ended counts the clock from its end, as before
    expect(state({ park: parkOf(ann(T0 - 10 * MIN)) as Park, manualPark: hand(T0 + H) })).toMatchObject({ attention: 'none', unattendedSinceMs: T0 - 10 * MIN })
  })

  it('governingPark picks the hand park while it holds, else the annotations\' park while it holds, else the park that ended last, else whatever is claimed', () => {
    const annotated = parkOf(ann(T0 + 5 * H)) as Park
    const manual = hand(T0 + 2 * H)
    expect(governingPark(null, null, T0)).toBeNull()
    expect(governingPark(manual, annotated, T0)).toBe(manual)
    expect(governingPark(manual, null, T0)).toBe(manual)
    expect(governingPark(null, annotated, T0)).toBe(annotated)
    // the hand park has ended, the annotations' park holds
    const ended = hand(T0 - MIN)
    expect(governingPark(ended, annotated, T0)).toBe(annotated)
    // the annotations' park has ended, the hand park holds
    const annotatedEnded = parkOf(ann(T0 - MIN)) as Park
    expect(governingPark(manual, annotatedEnded, T0)).toBe(manual)
    // neither holds: the one that ended last
    const olderHand = hand(T0 - 10 * MIN)
    const newerAnnotated = parkOf(ann(T0 - 2 * MIN)) as Park
    expect(governingPark(olderHand, newerAnnotated, T0)).toBe(newerAnnotated)
    const newerHand = hand(T0 - 2 * MIN)
    const olderAnnotated = parkOf(ann(T0 - 10 * MIN)) as Park
    expect(governingPark(newerHand, olderAnnotated, T0)).toBe(newerHand)
    // a claim too far out is not "ended": the one that did end speaks, and a lone far claim is returned as it is (it counts from the incident's start)
    const far = hand(T0 + 100 * H)
    expect(governingPark(far, olderAnnotated, T0)).toBe(olderAnnotated)
    expect(governingPark(far, null, T0)).toBe(far)
    const farAnnotated = parkOf(ann(T0 + 100 * H)) as Park
    expect(governingPark(far, farAnnotated, T0)).toBe(farAnnotated)
  })

  // the rule read independently of the code: silenced beats acked beats a park that ends after now and within 72 h of it, the hand park speaking first
  const offsets: Array<number | null> = [-30 * H, -3 * H, -1000, 0, 1000, 20 * H, 72 * H, 72 * H + 1, 100 * H, null]
  const holds = (o: number | null): o is number => o !== null && o > 0 && o <= 72 * H
  const label = (o: number | null): string => (o === null ? 'none' : `${o / MIN} min`)

  for (const [name, silenced, acked] of [
    ['unattended', false, false],
    ['acknowledged', false, true],
    ['silenced', true, false],
    ['silenced and acknowledged', true, true]
  ] as const) {
    it(`over every pair of ends for a hand park and the annotations' park, ${name}`, () => {
      for (const m of offsets) {
        for (const a of offsets) {
          const where = `hand park ${label(m)}, annotations ${label(a)}`
          const s = state({
            ackedAtMs: acked ? T0 - 30 * MIN : null,
            silencedUntilMs: silenced ? T0 + H : null,
            manualPark: m === null ? null : hand(T0 + m),
            annotations: a === null ? [{}] : [ann(T0 + a)]
          })
          const parked = !silenced && !acked && (holds(m) || holds(a))
          expect(s.attention, where).toBe(silenced ? 'silenced' : acked ? 'acked' : parked ? 'parked' : 'none')
          expect(s.firing, where).toBe(!parked)
          expect(s.tier, where).toBe(silenced || parked ? 'quiet' : 'warning')
          if (parked) {
            // the hand park speaks first while it holds, and only then carries a name
            expect(s.park?.until, where).toBe(iso(T0 + (holds(m) ? m : (a as number))))
            expect(s.park !== null && 'by' in s.park, where).toBe(holds(m))
            expect(s.R, where).toBe(1)
            expect(s.band, where).toBe(0)
          } else {
            expect(s.park, where).toBeNull()
          }
          // the clock: a park that holds has not ended; otherwise it starts at the end of the park that ended last, never before the incident began
          const ended = [m, a].filter((o): o is number => o !== null && o <= 0)
          const since = holds(m) || holds(a) ? startsAtMs : ended.length > 0 ? Math.max(startsAtMs, T0 + Math.max(...ended)) : startsAtMs
          expect(s.unattendedSinceMs, where).toBe(since)
        }
      }
    })
  }
})

// ---- 3. the engine ------------------------------------------------------------------------------------------------------------------

describe('3. the engine: park, replace, survive a restart, and every way a park ends', () => {
  it('parks a firing incident of any source (a Grafana alert with no annotations) and shows it in every count', () => {
    const e = engine
    const key = fire()
    expect(incidentOf(e, key).state.attention).toBe('none')
    expect(e.park(key, ask())).toEqual({ ok: true, at: iso(T0), replaced: false })
    const i = incidentOf(e, key)
    expect(i.state).toMatchObject({ attention: 'parked', tier: 'quiet', R: 1, firing: false, band: 0 })
    expect(i.state.park).toEqual({
      state: 'awaiting_source',
      until: iso(T0 + 6 * H),
      since: iso(T0),
      ref: 'SB-9',
      note: 'the fix is live and the alert window has not caught up',
      by: 'agent: claude',
      // it covers the alert that fires now, and no other
      alertKeys: ['grafana:a1b2c3d4']
    })
    expect(e.manualParkOf(key)).toEqual(i.state.park)
    // no next step is promised, and nothing is counted live
    expect(i.nextStep).toBeNull()
    expect(e.wall().header).toMatchObject({ firing: 0, acknowledged: 0, parked: 1 })
    expect(summaryOf(e.wall())).toMatchObject({ firing: 0, unattended: 0, acknowledged: 0, parked: 1, worst: 'none' })
    const view = e.notifyViews().views[0]
    expect(view).toMatchObject({ key, attention: 'parked', unattendedSec: 0 })
    expect(view.freshSince ?? null).toBeNull()
  })

  it('a park with no ref reads null, and the event carries no ref', () => {
    const key = fire()
    engine.park(key, ask({ ref: undefined }))
    expect(incidentOf(engine, key).state.park?.ref).toBeNull()
    expect(eventsOf(engine, key, 'park')[0].detail).not.toHaveProperty('ref')
  })

  it('a park is recorded as an event with who, why, which state and until when', () => {
    const key = fire()
    engine.park(key, ask())
    const [park, ...rest] = eventsOf(engine, key, 'park')
    expect(rest).toEqual([])
    expect(park).toMatchObject({ at: iso(T0), kind: 'park', alertKey: null, incidentKey: key })
    expect(park.detail).toEqual({
      by: 'agent: claude',
      state: 'awaiting_source',
      until: iso(T0 + 6 * H),
      note: 'the fix is live and the alert window has not caught up',
      ref: 'SB-9'
    })
  })

  it('a second park replaces the first: replaced is true, one row is held, and the event says so', () => {
    const e = engine
    const key = fire()
    e.park(key, ask())
    clock += MIN
    const second = e.park(key, ask({ state: 'deferred', until: iso(T0 + 10 * H), by: 'the user', note: 'later', ref: undefined }))
    expect(second).toEqual({ ok: true, at: iso(T0 + MIN), replaced: true })
    expect(parkKeys(e)).toEqual([key])
    expect(incidentOf(e, key).state.park).toEqual({ state: 'deferred', until: iso(T0 + 10 * H), since: iso(T0 + MIN), ref: null, note: 'later', by: 'the user', alertKeys: ['grafana:a1b2c3d4'] })
    const [newest, oldest] = eventsOf(e, key, 'park')
    expect(newest.detail).toEqual({ by: 'the user', state: 'deferred', until: iso(T0 + 10 * H), note: 'later', replaced: true })
    expect(oldest.detail).not.toHaveProperty('replaced')
  })

  it('a park after an unpark, or after the first one ran out, replaces nothing that was still in force: replaced is false', () => {
    const e = engine
    const key = fire()
    e.park(key, ask({ until: iso(T0 + 2 * H) }))
    clock += H
    expect(e.unpark(key, 'agent: claude').ok).toBe(true)
    clock += MIN
    expect(e.park(key, ask({ until: iso(T0 + 3 * H) })).ok && (e.park(key, ask({ until: iso(T0 + 4 * H) })) as { replaced: boolean }).replaced).toBe(true)
    // a park that ran out: the row is still there, but nothing was in force to replace
    clock = T0 + 5 * H
    const again = e.park(key, ask({ until: iso(T0 + 8 * H) }))
    expect(again).toMatchObject({ ok: true, replaced: false })
    expect(eventsOf(e, key, 'park')[0].detail).not.toHaveProperty('replaced')
  })

  it('refuses an incident that is not firing and writes nothing', () => {
    const e = engine
    fire()
    expect(e.park('No|Such', ask())).toEqual({ ok: false, error: 'not firing' })
    expect(parkKeys(e)).toEqual([])
    expect(e.incidentDetail('No|Such').events).toEqual([])
  })

  it('survives a restart: a new Engine over the same database still shows it parked, with its name', () => {
    const key = fire()
    engine.park(key, ask())
    const restarted = new Engine(engine.db, cfg, () => clock)
    expect(incidentOf(restarted, key).state).toMatchObject({ attention: 'parked', firing: false })
    expect(restarted.wall().header).toMatchObject({ firing: 0, parked: 1 })
    expect(restarted.manualParkOf(key)).toMatchObject({ by: 'agent: claude', state: 'awaiting_source', until: iso(T0 + 6 * H) })
  })

  // the second alert of the incident the Grafana fixture raises: same service and rule, another host, so the same incident and another alert key
  const hostB = (over: { startsAtMs?: number } = {}): Alert => grafana({ fingerprint: 'b1b2c3d4e5f60718', host: 'node-5', ...over })

  it('covers the alerts firing when it was set: their keys are stored with it, worst alert first or not', () => {
    const e = engine
    e.ingest(poll(grafana(), hostB()))
    const key = e.wall().incidents[0].key
    e.park(key, ask())
    expect(e.manualParkOf(key)?.alertKeys).toEqual(['grafana:a1b2c3d4', 'grafana:b1b2c3d4'])
    expect(incidentOf(e, key).state.park?.alertKeys).toEqual(['grafana:a1b2c3d4', 'grafana:b1b2c3d4'])
  })

  it('an alert that joins the incident ends the park at that moment: back unattended, paged as a new problem, its clock from the join, and History names the alert', () => {
    const e = engine
    const key = fire()
    e.park(key, ask())
    expect(incidentOf(e, key).state.attention).toBe('parked')
    clock += 10 * MIN
    e.ingest(poll(grafana(), hostB({ startsAtMs: clock - 30_000 })))
    const i = incidentOf(e, key)
    expect(i.alerts).toHaveLength(2)
    expect(i.state).toMatchObject({ attention: 'none', tier: 'warning', firing: true, park: null, unattendedSinceMs: clock })
    expect(e.wall().header).toMatchObject({ firing: 1, parked: 0 })
    expect(summaryOf(e.wall())).toMatchObject({ firing: 1, unattended: 1, parked: 0 })
    // the pager counts it as a fresh episode from the join, so its group wait and its escalation steps start there
    expect(e.notifyViews().views[0]).toMatchObject({ attention: 'none', unattendedSec: 0, freshSince: iso(clock) })
    clock += 2 * MIN
    expect(e.notifyViews().views[0]).toMatchObject({ unattendedSec: 120 })
    // the park is over, not deleted: its end is the join, so nothing can unpark it again
    expect(e.manualParkOf(key)?.until).toBe(iso(T0 + 10 * MIN))
    expect(e.unpark(key, 'agent: claude')).toEqual({ ok: false, error: 'park ended', endedAt: iso(T0 + 10 * MIN) })
    const ended = eventsOf(e, key, 'unpark')
    expect(ended).toHaveLength(1)
    expect(ended[0].at).toBe(iso(T0 + 10 * MIN))
    expect(ended[0].detail).toEqual({ ended: 'joined', parkedBy: 'agent: claude', state: 'awaiting_source', wasUntil: iso(T0 + 6 * H), alert: { key: 'grafana:b1b2c3d4', rule: 'DiskFull', host: 'node-5' } })
    // the engine ended it: nobody is named as the one who unparked
    expect(ended[0].detail).not.toHaveProperty('by')
    expect(eventLine(ended[0])).toEqual({ at: iso(T0 + 10 * MIN), kind: 'unpark', text: 'Park by agent: claude ended. A new alert joined the incident (DiskFull on node-5)' })
  })

  it('an alert of the park that resolves and fires again is the same key and keeps the park', () => {
    const e = engine
    e.ingest(poll(grafana(), hostB()))
    const key = e.wall().incidents[0].key
    e.park(key, ask())
    clock += MIN
    e.ingest(poll(grafana()))
    expect(incidentOf(e, key).state.attention).toBe('parked')
    clock += MIN
    e.ingest(poll(grafana(), hostB({ startsAtMs: clock - 10_000 })))
    const i = incidentOf(e, key)
    expect(i.alerts).toHaveLength(2)
    expect(i.state).toMatchObject({ attention: 'parked', firing: false })
    expect(i.state.park?.until).toBe(iso(T0 + 6 * H))
    expect(eventsOf(e, key, 'unpark')).toEqual([])
    expect(e.wall().header).toMatchObject({ firing: 0, parked: 1 })
  })

  it('an alert that was not firing when the park was set is a new alert when it fires, even one that fired before', () => {
    const e = engine
    e.ingest(poll(grafana(), hostB()))
    const key = e.wall().incidents[0].key
    clock += MIN
    e.ingest(poll(grafana()))
    e.park(key, ask())
    expect(e.manualParkOf(key)?.alertKeys).toEqual(['grafana:a1b2c3d4'])
    clock += MIN
    e.ingest(poll(grafana(), hostB({ startsAtMs: clock - 10_000 })))
    expect(incidentOf(e, key).state).toMatchObject({ attention: 'none', park: null })
    expect(eventsOf(e, key, 'unpark')).toHaveLength(1)
  })

  it('a join after the park is over (it ran out, or was unparked) records nothing', () => {
    const e = engine
    const key = fire()
    e.park(key, ask({ until: iso(T0 + H) }))
    clock = T0 + 2 * H
    e.ingest(poll(grafana(), hostB()))
    expect(incidentOf(e, key).state.attention).toBe('none')
    expect(eventsOf(e, key, 'unpark')).toEqual([])
    // and an unpark is recorded once, never twice
    const other = new Engine(openDb(':memory:'), cfg, () => clock)
    const k2 = fire(other)
    other.park(k2, ask({ until: iso(clock + 5 * H) }))
    clock += MIN
    other.unpark(k2, 'the user')
    clock += MIN
    other.ingest(poll(grafana(), hostB()))
    expect(eventsOf(other, k2, 'unpark')).toHaveLength(1)
  })

  it('an acknowledged incident that gets a new alert still records the end of the park, and the ack still wins', () => {
    const e = engine
    const key = fire()
    e.park(key, ask())
    e.ack(key, 'the user')
    clock += MIN
    e.ingest(poll(grafana(), hostB()))
    expect(incidentOf(e, key).state.attention).toBe('acked')
    expect(eventsOf(e, key, 'unpark')).toHaveLength(1)
    e.unack(key, 'the user')
    // the park is over: taking the ack off does not bring it back
    expect(incidentOf(e, key).state.attention).toBe('none')
  })

  it('a park after the join covers both alerts and holds again', () => {
    const e = engine
    const key = fire()
    e.park(key, ask())
    clock += MIN
    e.ingest(poll(grafana(), hostB()))
    clock += MIN
    expect(e.park(key, ask({ until: iso(clock + 4 * H), note: 'both hosts fixed' }))).toMatchObject({ ok: true, replaced: false })
    expect(e.manualParkOf(key)?.alertKeys).toEqual(['grafana:a1b2c3d4', 'grafana:b1b2c3d4'])
    expect(incidentOf(e, key).state.attention).toBe('parked')
    clock += MIN
    e.ingest(poll(grafana(), hostB()))
    expect(incidentOf(e, key).state.attention).toBe('parked')
  })

  it('a park written before the keys were recorded covers whatever fires, and the migration gives it the alerts that fire now', () => {
    const e = engine
    const key = fire()
    e.db
      .prepare('INSERT INTO parks (incident_key, state, until_at, parked_by, parked_at, ref, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(key, 'deferred', iso(T0 + 5 * H), 'agent: old', iso(T0), null, 'legacy')
    clock += MIN
    e.ingest(poll(grafana(), hostB()))
    expect(incidentOf(e, key).state.attention).toBe('parked')
    expect(e.manualParkOf(key)).not.toHaveProperty('alertKeys')
    // the release before had no column: openDb adds it, and a second run changes nothing
    const db = openDb(':memory:')
    db.exec('DROP TABLE parks')
    db.exec('CREATE TABLE parks (incident_key TEXT PRIMARY KEY, state TEXT NOT NULL, until_at TEXT NOT NULL, parked_by TEXT NOT NULL, parked_at TEXT NOT NULL, ref TEXT, note TEXT NOT NULL)')
    const old = new Engine(db, cfg, () => clock)
    const k2 = fire(old)
    db.prepare('INSERT INTO parks (incident_key, state, until_at, parked_by, parked_at, ref, note) VALUES (?, ?, ?, ?, ?, ?, ?)').run(k2, 'deferred', iso(clock + 5 * H), 'agent: old', iso(clock), null, 'legacy')
    migrate(db)
    migrate(db)
    expect(old.manualParkOf(k2)?.alertKeys).toEqual(['grafana:a1b2c3d4'])
    clock += MIN
    old.ingest(poll(grafana(), hostB()))
    expect(incidentOf(old, k2).state.attention).toBe('none')
  })

  it('a park set by hand on a database from before the keys were recorded goes in through the fallback insert and reads back', () => {
    const db = openDb(':memory:')
    db.exec('DROP TABLE parks')
    db.exec('CREATE TABLE parks (incident_key TEXT PRIMARY KEY, state TEXT NOT NULL, until_at TEXT NOT NULL, parked_by TEXT NOT NULL, parked_at TEXT NOT NULL, ref TEXT, note TEXT NOT NULL)')
    const old = new Engine(db, cfg, () => clock)
    const key = fire(old)
    // `park` writes alert_keys when the column is there and falls back to the pre-migration columns when it is not
    expect(old.park(key, ask())).toMatchObject({ ok: true, replaced: false, at: iso() })
    const row = db.prepare('SELECT incident_key, state, until_at, parked_by, parked_at, ref, note FROM parks WHERE incident_key = ?').get(key) as Record<string, unknown>
    expect(row).toMatchObject({ incident_key: key, state: 'awaiting_source', until_at: iso(T0 + 6 * H), parked_by: 'agent: claude', parked_at: iso(), ref: 'SB-9' })
    // it reads back as a park that covers whatever fires (no alert_keys), and it holds the incident off the wall
    expect(old.manualParkOf(key)).toEqual({ state: 'awaiting_source', until: iso(T0 + 6 * H), since: iso(), ref: 'SB-9', note: ask().note, by: 'agent: claude' })
    expect(old.manualParkOf(key)).not.toHaveProperty('alertKeys')
    expect(incidentOf(old, key).state.attention).toBe('parked')
    expect(eventsOf(old, key, 'park')).toHaveLength(1)
  })

  it('ends when the source resolves the alert, and a re-fire is a new problem: unparked and unattended', () => {
    const e = engine
    const key = fire()
    e.park(key, ask())
    clock += MIN
    e.ingest(poll())
    expect(e.wall().incidents).toHaveLength(0)
    expect(e.manualParkOf(key)).toBeNull()
    expect(parkKeys(e)).toEqual([])
    clock += MIN
    e.ingest(poll(grafana({ startsAtMs: clock - 30_000 })))
    const back = incidentOf(e, key)
    expect(back.state).toMatchObject({ attention: 'none', tier: 'warning', firing: true, park: null, unattendedSinceMs: clock - 30_000 })
    expect(e.wall().header).toMatchObject({ firing: 1, parked: 0 })
    expect(e.notifyViews().views[0]).toMatchObject({ attention: 'none', unattendedSec: 30 })
  })

  it('ends on a manual resolve, and the source reporting it again afterwards is unparked', () => {
    const e = engine
    const key = fire()
    e.park(key, ask())
    clock += MIN
    expect(e.resolveManual(key, 'agent: claude', 'fixed').ok).toBe(true)
    expect(e.wall().incidents).toHaveLength(0)
    expect(e.manualParkOf(key)).toBeNull()
    expect(parkKeys(e)).toEqual([])
    clock += MIN
    e.ingest(poll(grafana()))
    const back = incidentOf(e, key)
    expect(back.state).toMatchObject({ attention: 'none', firing: true, park: null })
    expect(e.wall().header).toMatchObject({ firing: 1, parked: 0 })
    expect(eventsOf(e, key, 'reopened')).toHaveLength(1)
  })

  it('a stray park row left behind (a re-keyed incident) never holds a new episode off the wall', () => {
    const e = engine
    const key = fire()
    clock += MIN
    e.ingest(poll())
    e.db
      .prepare('INSERT INTO parks (incident_key, state, until_at, parked_by, parked_at, ref, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(key, 'deferred', iso(T0 + 5 * H), 'agent: stale', iso(T0), null, 'left behind')
    expect(parkKeys(e)).toEqual([key])
    clock += MIN
    e.ingest(poll(grafana({ startsAtMs: clock - 30_000 })))
    expect(incidentOf(e, key).state.attention).toBe('none')
    expect(parkKeys(e)).toEqual([])
  })

  it('when until passes the incident is back unattended, and the pager counts from until', () => {
    const e = engine
    const key = fire()
    e.park(key, ask({ until: iso(T0 + H) }))
    // the last moment of the park
    clock = T0 + H - 1
    expect(incidentOf(e, key).state.attention).toBe('parked')
    // five minutes after it ended
    clock = T0 + H + 5 * MIN
    const back = incidentOf(e, key)
    expect(back.state).toMatchObject({ attention: 'none', tier: 'warning', firing: true, band: 0, park: null, unattendedSinceMs: T0 + H })
    expect(e.wall().header).toMatchObject({ firing: 1, parked: 0 })
    const view = e.notifyViews().views[0]
    expect(view).toMatchObject({ attention: 'none', unattendedSec: 300 })
    expect(view.freshSince).toBe(iso(T0 + H))
  })

  it('at the very instant until arrives it has ended', () => {
    const key = fire()
    engine.park(key, ask({ until: iso(T0 + H) }))
    clock = T0 + H
    expect(incidentOf(engine, key).state).toMatchObject({ attention: 'none', unattendedSinceMs: T0 + H })
    expect(engine.notifyViews().views[0]).toMatchObject({ unattendedSec: 0, freshSince: iso(T0 + H) })
  })

  it('an acknowledgement wins over the park, which is kept and shows again when the acknowledgement is taken off', () => {
    const e = engine
    const key = fire()
    e.park(key, ask())
    expect(e.ack(key, 'the user')).toBe(true)
    expect(incidentOf(e, key).state).toMatchObject({ attention: 'acked', park: null })
    expect(e.manualParkOf(key)).not.toBeNull()
    expect(e.wall().header).toMatchObject({ firing: 1, acknowledged: 1, parked: 0 })
    e.unack(key, 'the user')
    expect(incidentOf(e, key).state).toMatchObject({ attention: 'parked', park: { by: 'agent: claude' } })
    expect(e.wall().header).toMatchObject({ firing: 0, acknowledged: 0, parked: 1 })
  })

  it('a silence wins over the park too', () => {
    const e = engine
    const key = fire()
    e.park(key, ask())
    expect(e.silence(key, 60, 'the user')).toBe(true)
    expect(incidentOf(e, key).state.attention).toBe('silenced')
    e.unack(key, 'the user')
    expect(incidentOf(e, key).state.attention).toBe('parked')
  })

  it('the pager sends nothing for the whole of a park and pages it as a new problem when it ends', () => {
    const route: RouteConfig = { id: 'page', match: {}, receivers: ['ntfy'], mode: 'all', groupWaitSec: 0, groupIntervalSec: 60, repeatIntervalSec: 3600, escalate: [{ afterSec: 600, receivers: ['sms'] }] }
    const planOf = (log: Map<string, LogRow>): Plan => {
      const { views, resolved } = engine.notifyViews()
      return planSends({ routes: [route], views, resolved, nowMs: clock, quiet: false, getLog: (k) => log.get(k) ?? null, getHeld: () => [] })
    }
    const key = fire()
    engine.park(key, ask({ until: iso(T0 + H) }))
    const log = new Map<string, LogRow>()
    for (let t = T0; t < T0 + H; t += 7 * MIN) {
      clock = t
      const p = planOf(log)
      expect(p.sends).toEqual([])
      expect(p.held).toEqual([])
    }
    clock = T0 + H - 1
    expect(planOf(log).sends).toEqual([])
    clock = T0 + H
    expect(planOf(log).sends.map((s) => s.stage)).toEqual(['alert'])
  })

  it('unpark ends it now: back in its tier, unattended, and the clock starts at the unpark, not at the first firing', () => {
    const e = engine
    const key = fire()
    e.park(key, ask())
    clock += 10 * MIN
    const r = e.unpark(key, 'agent: claude', 'the fix did not hold')
    expect(r).toMatchObject({ ok: true, at: iso(T0 + 10 * MIN) })
    expect(r.ok && r.was).toMatchObject({ state: 'awaiting_source', until: iso(T0 + 6 * H), by: 'agent: claude' })
    const back = incidentOf(e, key)
    expect(back.state).toMatchObject({ attention: 'none', tier: 'warning', firing: true, band: 0, park: null, unattendedSinceMs: T0 + 10 * MIN })
    expect(back.state.unattendedSinceMs).not.toBe(STARTED)
    expect(e.wall().header).toMatchObject({ firing: 1, parked: 0 })
    expect(e.notifyViews().views[0]).toMatchObject({ attention: 'none', unattendedSec: 0, freshSince: iso(T0 + 10 * MIN) })
    clock += 2 * MIN
    expect(e.notifyViews().views[0].unattendedSec).toBe(120)
    // the row is kept (its end rewritten to the unpark), not deleted
    expect(e.manualParkOf(key)?.until).toBe(iso(T0 + 10 * MIN))
  })

  it('unpark is recorded as an event with who, the state it ended, when it would have ended, and the note', () => {
    const key = fire()
    engine.park(key, ask())
    clock += 10 * MIN
    engine.unpark(key, 'agent: claude', 'the fix did not hold')
    const [unpark, ...rest] = eventsOf(engine, key, 'unpark')
    expect(rest).toEqual([])
    expect(unpark).toMatchObject({ at: iso(T0 + 10 * MIN), kind: 'unpark', alertKey: null, incidentKey: key })
    expect(unpark.detail).toEqual({ by: 'agent: claude', state: 'awaiting_source', wasUntil: iso(T0 + 6 * H), note: 'the fix did not hold' })
    // no note given: no note key
    const other = new Engine(openDb(':memory:'), cfg, () => clock)
    const k2 = fire(other)
    other.park(k2, ask())
    other.unpark(k2, 'the user')
    expect(eventsOf(other, k2, 'unpark')[0].detail).toEqual({ by: 'the user', state: 'awaiting_source', wasUntil: iso(T0 + 6 * H) })
  })

  it('a second unpark says the park ended and when; so does an unpark after the park ran out', () => {
    const e = engine
    const key = fire()
    e.park(key, ask())
    clock += 10 * MIN
    expect(e.unpark(key, 'agent: claude').ok).toBe(true)
    expect(e.unpark(key, 'agent: claude')).toEqual({ ok: false, error: 'park ended', endedAt: iso(T0 + 10 * MIN) })
    clock += H
    expect(e.unpark(key, 'agent: claude')).toEqual({ ok: false, error: 'park ended', endedAt: iso(T0 + 10 * MIN) })
    expect(eventsOf(e, key, 'unpark')).toHaveLength(1)
    // a park that ran out
    const other = new Engine(openDb(':memory:'), cfg, () => clock)
    clock = T0
    const k2 = fire(other)
    other.park(k2, ask({ until: iso(T0 + H) }))
    clock = T0 + 2 * H
    expect(other.unpark(k2, 'the user')).toEqual({ ok: false, error: 'park ended', endedAt: iso(T0 + H) })
  })

  it('an unpark with no hand park says it was not parked by hand, and an unpark of a key that is not firing says so', () => {
    const e = engine
    const key = fire()
    expect(e.unpark(key, 'the user')).toEqual({ ok: false, error: 'not parked by hand' })
    expect(e.unpark('No|Such', 'the user')).toEqual({ ok: false, error: 'not firing' })
    expect(eventsOf(e, key, 'unpark')).toEqual([])
  })

  it('an unpark of a park the sweep states in its annotations says it was not parked by hand and leaves the park alone', () => {
    const e = engine
    e.ingest(sweepPush(sweepAlert('CiRed', ann(T0 + 20 * H, 'fixed_undeployed'))))
    const key = e.wall().incidents[0].key
    expect(incidentOf(e, key).state.attention).toBe('parked')
    expect(e.unpark(key, 'agent: claude')).toEqual({ ok: false, error: 'not parked by hand' })
    const still = incidentOf(e, key)
    expect(still.state.attention).toBe('parked')
    expect(still.state.park).not.toHaveProperty('by')
    expect(eventsOf(e, key, 'unpark')).toEqual([])
  })

  it('a park by hand works on a sweep incident too, outranks the sweep\'s park, and the sweep\'s park takes over again when it is unparked', () => {
    const e = engine
    e.ingest(sweepPush(sweepAlert('CiRed', ann(T0 + 20 * H, 'fixed_undeployed'))))
    const key = e.wall().incidents[0].key
    e.park(key, ask({ state: 'awaiting_source', until: iso(T0 + 2 * H) }))
    expect(incidentOf(e, key).state.park).toMatchObject({ by: 'agent: claude', state: 'awaiting_source', until: iso(T0 + 2 * H) })
    clock += MIN
    expect(e.unpark(key, 'agent: claude').ok).toBe(true)
    const back = incidentOf(e, key)
    expect(back.state.attention).toBe('parked')
    expect(back.state.park).toMatchObject({ state: 'fixed_undeployed', until: iso(T0 + 20 * H) })
    expect(back.state.park).not.toHaveProperty('by')
    expect(e.wall().header).toMatchObject({ firing: 0, parked: 1 })
  })

  it('a new park after an unpark parks it again', () => {
    const e = engine
    const key = fire()
    e.park(key, ask())
    clock += 10 * MIN
    e.unpark(key, 'agent: claude')
    clock += MIN
    expect(e.park(key, ask({ until: iso(clock + 4 * H), note: 'second attempt' })).ok).toBe(true)
    expect(incidentOf(e, key).state).toMatchObject({ attention: 'parked', park: { since: iso(clock), note: 'second attempt' } })
    expect(parkKeys(e)).toEqual([key])
  })

  it('prune deletes the park row of an incident that is not firing and keeps the row of one that is', () => {
    const e = engine
    const key = fire()
    e.park(key, ask())
    e.db
      .prepare('INSERT INTO parks (incident_key, state, until_at, parked_by, parked_at, ref, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('Gone|Rule', 'deferred', iso(T0 + H), 'agent: claude', iso(T0), null, 'orphan')
    expect(parkKeys(e)).toEqual([key, 'Gone|Rule'].sort())
    e.prune()
    expect(parkKeys(e)).toEqual([key])
    expect(incidentOf(e, key).state.attention).toBe('parked')
  })

  it('actions() returns the park and the unpark, newest first, with who and why', () => {
    const e = engine
    const key = fire()
    e.park(key, ask())
    clock += 10 * MIN
    e.unpark(key, 'the user', 'did not hold')
    const actions = e.actions(iso(T0 - H), iso(T0 + H), 50)
    expect(actions.map((a) => a.kind)).toEqual(['unpark', 'park'])
    expect(actions[0].detail).toMatchObject({ by: 'the user', note: 'did not hold' })
    expect(actions[1].detail).toMatchObject({ by: 'agent: claude', state: 'awaiting_source' })
    expect(actions.every((a) => a.incidentKey === key)).toBe(true)
  })
})

// ---- 4. History and event wording --------------------------------------------------------------------------------------------------

describe('4. History: the park and the unpark in words', () => {
  const ev = (kind: string, detail: Record<string, unknown>): AlertEvent => ({ id: 1, at: '2026-10-16T12:00:00.000Z', incidentKey: 'k', alertKey: null, kind, detail }) as unknown as AlertEvent
  const UNTIL = '2026-10-17T04:00:00.000Z'

  it('utcStamp tells a time in UTC, whatever zone it was written in, and says nothing for what is not a time', () => {
    expect(utcStamp(UNTIL)).toBe('Oct 17, 04:00 UTC')
    expect(utcStamp('2026-10-17T06:00:00+02:00')).toBe('Oct 17, 04:00 UTC')
    expect(utcStamp('2026-01-05T03:07:00Z')).toBe('Jan 5, 03:07 UTC')
    expect(utcStamp('soon')).toBe('')
    expect(utcStamp(undefined)).toBe('')
    expect(utcStamp(42)).toBe('')
  })

  it('a park reads who, until when, why and the ticket, then the note', () => {
    const line = eventLine(ev('park', { by: 'agent: x', state: 'awaiting_source', until: UNTIL, ref: 'SB-1', note: 'why' }))
    expect(line.text).toBe('Parked by agent: x until Oct 17, 04:00 UTC (fix live, awaiting source, SB-1). Note: why')
    expect(line).toMatchObject({ kind: 'park', by: 'agent: x', agent: true })
  })

  it('each state has its own words, and the parts that are absent are left out', () => {
    expect(eventLine(ev('park', { by: 'the user', state: 'fixed_undeployed', until: UNTIL, note: 'merged' })).text).toBe('Parked by the user until Oct 17, 04:00 UTC (fix not deployed). Note: merged')
    expect(eventLine(ev('park', { by: 'the user', state: 'deferred', until: UNTIL })).text).toBe('Parked by the user until Oct 17, 04:00 UTC (deferred)')
    expect(eventLine(ev('park', { by: 'the user', state: 'deferred', until: UNTIL, ref: 'SB-1' })).text).toBe('Parked by the user until Oct 17, 04:00 UTC (deferred, SB-1)')
    expect(eventLine(ev('park', { by: 'the user', until: UNTIL })).text).toBe('Parked by the user until Oct 17, 04:00 UTC')
    expect(eventLine(ev('park', { by: 'the user', state: 'unheard-of', until: UNTIL })).text).toBe('Parked by the user until Oct 17, 04:00 UTC')
    expect(eventLine(ev('park', { by: 'the user', state: 'deferred', note: 'why' })).text).toBe('Parked by the user (deferred). Note: why')
    expect(eventLine(ev('park', { by: 'the user' })).text).toBe('Parked by the user')
  })

  it('a stored actor that names nobody leaves "by ..." out of the park and the unpark', () => {
    for (const by of ['this browser', 'wall', 'someone', '']) {
      expect(eventLine(ev('park', { by, state: 'deferred', until: UNTIL, note: 'why' })).text).toBe('Parked until Oct 17, 04:00 UTC (deferred). Note: why')
      expect(eventLine(ev('unpark', { by, note: 'why' })).text).toBe('Unparked. Note: why')
      expect(eventLine(ev('unpark', { by })).text).toBe('Unparked')
    }
    expect(eventLine(ev('park', { state: 'deferred', until: UNTIL })).text).toBe('Parked until Oct 17, 04:00 UTC (deferred)')
    expect(eventLine(ev('park', { by: FALLBACK_NAME, state: 'deferred', until: UNTIL })).text).not.toContain(' by ')
  })

  it('an unpark reads who and the note', () => {
    expect(eventLine(ev('unpark', { by: 'agent: x', note: 'why' })).text).toBe('Unparked by agent: x. Note: why')
    expect(eventLine(ev('unpark', { by: 'agent: x' })).text).toBe('Unparked by agent: x')
    expect(eventLine(ev('unpark', { by: 'agent: x', state: 'deferred', wasUntil: UNTIL })).text).toBe('Unparked by agent: x')
    expect(eventLine(ev('unpark', { by: 'the user', note: 'why' }))).toMatchObject({ kind: 'unpark', by: 'the user', agent: false })
  })

  it('the sheet\'s History says both in the same words, and still says nothing of the events it words itself', () => {
    const park = ev('park', { by: 'agent: x', state: 'deferred', until: UNTIL, note: 'why' })
    const unpark = ev('unpark', { by: 'agent: x' })
    expect(eventSaying(park)).toBe(eventLine(park).text)
    expect(eventSaying(unpark)).toBe('Unparked by agent: x')
    expect(eventSaying(park)).not.toBeNull()
    expect(eventSaying(ev('notify', {}))).toBeNull()
    expect(eventSaying(ev('fired', {}))).toBeNull()
  })

  it('what the engine records reads right through eventLine', () => {
    const key = fire()
    engine.park(key, ask({ until: iso(T0 + 16 * H) }))
    clock += 10 * MIN
    engine.unpark(key, 'agent: claude', 'did not hold')
    const lines = engine.incidentDetail(key).events.map((e) => eventLine(e)).map((l) => l.text)
    expect(lines).toContain('Parked by agent: claude until Oct 17, 04:00 UTC (fix live, awaiting source, SB-9). Note: the fix is live and the alert window has not caught up')
    expect(lines).toContain('Unparked by agent: claude. Note: did not hold')
  })

  it('a park that a new alert ended reads whose park it was and which alert joined, and names nobody as having unparked it', () => {
    const joined = (detail: Record<string, unknown>) => eventLine(ev('unpark', { ended: 'joined', parkedBy: 'agent: x', state: 'deferred', wasUntil: UNTIL, ...detail }))
    expect(joined({ alert: { key: 'grafana:b1b2c3d4', rule: 'DiskFull', host: 'node-5' } }).text).toBe('Park by agent: x ended. A new alert joined the incident (DiskFull on node-5)')
    expect(joined({ alert: { key: 'k', rule: 'DiskFull', host: '' } }).text).toBe('Park by agent: x ended. A new alert joined the incident (DiskFull)')
    expect(joined({ alert: { key: 'k', rule: '', host: 'node-5' } }).text).toBe('Park by agent: x ended. A new alert joined the incident (node-5)')
    expect(joined({}).text).toBe('Park by agent: x ended. A new alert joined the incident')
    expect(joined({ alert: 'junk' }).text).toBe('Park by agent: x ended. A new alert joined the incident')
    expect(joined({ parkedBy: 'this browser', alert: { key: 'k', rule: 'DiskFull', host: 'node-5' } }).text).toBe('Park ended. A new alert joined the incident (DiskFull on node-5)')
    // no `by`: the line carries no actor and is not marked as an agent's
    expect(joined({}).by).toBeUndefined()
    expect(joined({}).agent).toBeUndefined()
    expect(eventSaying(ev('unpark', { ended: 'joined', parkedBy: 'agent: x', alert: { rule: 'DiskFull', host: 'node-5' } }))).toBe('Park by agent: x ended. A new alert joined the incident (DiskFull on node-5)')
  })

  it('the sentence has one formatter seam: UTC by default, and the wall passes its own so the sheet tells the end in the viewer\'s zone', () => {
    const park = ev('park', { by: 'agent: x', state: 'awaiting_source', until: UNTIL, ref: 'SB-1', note: 'why' })
    const stamp = (iso: string): string => `LOCAL(${iso})`
    expect(eventLine(park, { stamp }).text).toBe(`Parked by agent: x until LOCAL(${UNTIL}) (fix live, awaiting source, SB-1). Note: why`)
    expect(eventSaying(park, { stamp })).toBe(eventLine(park, { stamp }).text)
    expect(eventLine(park, {}).text).toBe(eventLine(park).text)
    expect(eventLine(park).text).toContain('until Oct 17, 04:00 UTC')
    // an end that is not a time is left out whatever the formatter is, and the formatter is never asked about it
    const seen: string[] = []
    expect(eventLine(ev('park', { by: 'the user', state: 'deferred', until: 'soon' }), { stamp: (iso) => { seen.push(iso); return iso } }).text).toBe('Parked by the user (deferred)')
    expect(seen).toEqual([])
    // the wall's formatter is the chip's: one end, told one way
    const web = eventSaying(park, { stamp: parkStampText }) as string
    expect(web).toBe(`Parked by agent: x until ${parkStampText(UNTIL)} (fix live, awaiting source, SB-1). Note: why`)
    expect(web).not.toContain('UTC')
    expect(parkedParts({ state: 'awaiting_source', until: UNTIL, since: null, ref: 'SB-1', note: 'why', by: 'agent: x' }).who).toBe(`Parked until ${parkStampText(UNTIL)} by agent: x`)
  })
})

// ---- 5. the API ---------------------------------------------------------------------------------------------------------------------

function boot(env: NodeJS.ProcessEnv = { WATCHER_MCP_TOKEN: TOKEN }) {
  const deps: AppDeps = {
    engine,
    cfg,
    env,
    db: engine.db,
    push: new SqlitePushStore(engine.db),
    ackSecret: ['park', 'by', 'hand', '0001'].join('-'),
    webDir: '/nonexistent',
    normalizeWebhook: () => {
      throw new Error('unused')
    },
    testChannel: async () => ({ ok: true, status: 'ok', latencyMs: 1 }),
    nudge: () => void (nudges += 1),
    vapidPublicKey: null,
    now: () => clock,
    log: () => undefined
  }
  return createApp(deps)
}

describe('5. the API: POST /api/incidents/:key/park and /unpark', () => {
  const pathOf = (key: string, verb: 'park' | 'unpark'): string => `/api/incidents/${encodeURIComponent(key)}/${verb}`
  const post = (app: ReturnType<typeof boot>, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const parkBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ by: 'the user', state: 'deferred', until: iso(T0 + 10 * H), note: 'handled on Monday', ref: 'SB-2', ...over })
  const json = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>

  it('park answers 200 with who, the state, the end and replaced, and the incident is parked with that name', async () => {
    const key = fire()
    const app = boot()
    const res = await post(app, pathOf(key, 'park'), parkBody())
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ ok: true, key, by: 'the user', state: 'deferred', until: iso(T0 + 10 * H), replaced: false })
    expect(incidentOf(engine, key).state).toMatchObject({
      attention: 'parked',
      firing: false,
      park: { state: 'deferred', until: iso(T0 + 10 * H), since: iso(T0), ref: 'SB-2', note: 'handled on Monday', by: 'the user' }
    })
    expect(nudges).toBe(1)
    // a second park replaces the first
    clock += MIN
    const again = await post(app, pathOf(key, 'park'), parkBody({ state: 'awaiting_source', note: 'now it is live' }))
    expect(again.status).toBe(200)
    expect(await json(again)).toMatchObject({ ok: true, state: 'awaiting_source', replaced: true })
    expect(parkKeys(engine)).toEqual([key])
  })

  it('park reads the state in any case and answers the end in UTC', async () => {
    const key = fire()
    const res = await post(boot(), pathOf(key, 'park'), parkBody({ state: 'AWAITING_SOURCE', until: '2026-10-16T16:00:00+02:00' }))
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ state: 'awaiting_source', until: iso(T0 + 2 * H) })
  })

  it('park answers 400 with the error for a bad body, and writes nothing and wakes nobody', async () => {
    const key = fire()
    const app = boot()
    const cases: Array<[body: unknown, expected: string]> = [
      [parkBody({ note: undefined }), 'note is required'],
      [parkBody({ note: '   ' }), 'note is required'],
      [parkBody({ note: 'n'.repeat(501) }), 'note is 501 characters; the most is 500'],
      [parkBody({ state: 'snoozed' }), 'state must be one of'],
      [parkBody({ until: '2026-10-17T04:00:00' }), 'until must be an ISO 8601 time with a zone'],
      [parkBody({ until: iso(T0 - MIN) }), 'until must be after now'],
      [parkBody({ ref: 'r'.repeat(65) }), 'ref is 65 characters; the most is 64'],
      [undefined, 'state must be one of'],
      [['not', 'an', 'object'], 'state must be one of']
    ]
    for (const [body, expected] of cases) {
      const res = await post(app, pathOf(key, 'park'), body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(((await json(res)).error as string), JSON.stringify(body)).toContain(expected)
    }
    expect(engine.manualParkOf(key)).toBeNull()
    expect(incidentOf(engine, key).state.attention).toBe('none')
    expect(nudges).toBe(0)
  })

  it('park refuses an until beyond 72 h with the latest time named, and does not shorten it', async () => {
    const key = fire()
    const res = await post(boot(), pathOf(key, 'park'), parkBody({ until: iso(T0 + 72 * H + 1) }))
    expect(res.status).toBe(400)
    const error = (await json(res)).error as string
    expect(error).toContain(`The latest time it takes is ${iso(T0 + 72 * H)}`)
    expect(error).toContain('refused, not shortened')
    expect(engine.manualParkOf(key)).toBeNull()
    expect(incidentOf(engine, key).state.attention).toBe('none')
    // exactly 72 h is taken
    const ok = await post(boot(), pathOf(key, 'park'), parkBody({ until: iso(T0 + 72 * H) }))
    expect(ok.status).toBe(200)
    expect(incidentOf(engine, key).state.park?.until).toBe(iso(T0 + 72 * H))
  })

  it('park answers 404 for an incident that is not firing', async () => {
    fire()
    const app = boot()
    const res = await post(app, pathOf('No|Such', 'park'), parkBody())
    expect(res.status).toBe(404)
    expect(await json(res)).toEqual({ error: 'not firing' })
    expect(nudges).toBe(0)
    expect(parkKeys(engine)).toEqual([])
  })

  it('park with no by takes the x-watch-user header, percent-encoded; the body wins over the header; nobody is this browser, never wall', async () => {
    const key = fire()
    const app = boot()
    const noBy = parkBody({ by: undefined })
    const viaHeader = await post(app, pathOf(key, 'park'), noBy, { 'x-watch-user': encodeURIComponent('the user') })
    expect(viaHeader.status).toBe(200)
    expect(await json(viaHeader)).toMatchObject({ by: 'the user' })
    expect(engine.manualParkOf(key)?.by).toBe('the user')
    expect(eventsOf(engine, key, 'park')[0].detail.by).toBe('the user')

    await post(app, pathOf(key, 'park'), parkBody({ by: 'Dana' }), { 'x-watch-user': 'the user' })
    expect(engine.manualParkOf(key)?.by).toBe('Dana')

    await post(app, pathOf(key, 'park'), noBy)
    expect(engine.manualParkOf(key)?.by).toBe(FALLBACK_NAME)
    await post(app, pathOf(key, 'park'), parkBody({ by: 'wall' }))
    expect(engine.manualParkOf(key)?.by).toBe(FALLBACK_NAME)
  })

  it('park from another site is refused with 403 and writes nothing', async () => {
    const key = fire()
    const app = boot()
    // A loopback Host and no proxy header: this is the cross-site Origin check, not the admin-token gate that refuses a
    // tunneled request when WATCHER_ADMIN_TOKEN is unset (test/server/auth.test.ts covers that other 403).
    const res = await post(app, pathOf(key, 'park'), parkBody(), { origin: 'https://evil.example', host: '127.0.0.1:8080' })
    expect(res.status).toBe(403)
    expect(await json(res)).toEqual({ error: 'cross-site request refused' })
    expect(engine.manualParkOf(key)).toBeNull()
    expect(nudges).toBe(0)
  })

  it('unpark answers 200 with the time, and the incident is unattended from then', async () => {
    const key = fire()
    const app = boot()
    await post(app, pathOf(key, 'park'), parkBody())
    clock += 10 * MIN
    const res = await post(app, pathOf(key, 'unpark'), { by: 'the user', note: 'did not hold' })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ ok: true, key, at: iso(T0 + 10 * MIN) })
    expect(incidentOf(engine, key).state).toMatchObject({ attention: 'none', firing: true, park: null, unattendedSinceMs: T0 + 10 * MIN })
    expect(eventsOf(engine, key, 'unpark')[0].detail).toMatchObject({ by: 'the user', note: 'did not hold', state: 'deferred' })
  })

  it('unpark takes its name from the header too', async () => {
    const key = fire()
    const app = boot()
    await post(app, pathOf(key, 'park'), parkBody())
    await post(app, pathOf(key, 'unpark'), undefined, { 'x-watch-user': encodeURIComponent('Zoë') })
    expect(eventsOf(engine, key, 'unpark')[0].detail.by).toBe('Zoë')
  })

  it('unpark answers 404 for an incident that is not firing', async () => {
    fire()
    const res = await post(boot(), pathOf('No|Such', 'unpark'), { by: 'the user' })
    expect(res.status).toBe(404)
    expect(await json(res)).toEqual({ error: 'not firing' })
  })

  it('unpark answers 409 when the incident was not parked by hand, and when its park already ended', async () => {
    const key = fire()
    const app = boot()
    const never = await post(app, pathOf(key, 'unpark'), { by: 'the user' })
    expect(never.status).toBe(409)
    expect(await json(never)).toEqual({ error: 'not parked by hand' })
    await post(app, pathOf(key, 'park'), parkBody())
    clock += 10 * MIN
    expect((await post(app, pathOf(key, 'unpark'), { by: 'the user' })).status).toBe(200)
    const twice = await post(app, pathOf(key, 'unpark'), { by: 'the user' })
    expect(twice.status).toBe(409)
    expect(await json(twice)).toEqual({ error: `its park already ended at ${iso(T0 + 10 * MIN)}` })
  })

  it('unpark answers 409 for a park the sweep states in its annotations', async () => {
    engine.ingest(sweepPush(sweepAlert('CiRed', ann(T0 + 20 * H))))
    const key = engine.wall().incidents[0].key
    const res = await post(boot(), pathOf(key, 'unpark'), { by: 'the user' })
    expect(res.status).toBe(409)
    expect(await json(res)).toEqual({ error: 'not parked by hand' })
    expect(incidentOf(engine, key).state.attention).toBe('parked')
  })

  it('unpark answers 400 for a note over 500 characters and 403 from another site', async () => {
    const key = fire()
    const app = boot()
    await post(app, pathOf(key, 'park'), parkBody())
    const long = await post(app, pathOf(key, 'unpark'), { by: 'the user', note: 'n'.repeat(501) })
    expect(long.status).toBe(400)
    expect((await json(long)).error).toBe('note is 501 characters; the most is 500')
    const cross = await post(app, pathOf(key, 'unpark'), { by: 'the user' }, { origin: 'https://evil.example', host: 'watch.test' })
    expect(cross.status).toBe(403)
    expect(incidentOf(engine, key).state.attention).toBe('parked')
  })
})

// ---- 6. the MCP tools ---------------------------------------------------------------------------------------------------------------

let rpcId = 0
async function call(app: ReturnType<typeof boot>, method: string, params: unknown, token: string | null = TOKEN): Promise<Response> {
  return app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: (rpcId += 1), method, params })
  })
}
type Rpc = {
  error?: { message: string }
  result?: { isError?: boolean; content?: Array<{ text: string }>; tools?: Array<{ name: string; description: string; inputSchema: { required?: string[] }; annotations: Record<string, boolean> }> }
}
const rpcOf = async (r: Response): Promise<Rpc> => (await r.json()) as Rpc
async function tool(app: ReturnType<typeof boot>, name: string, args: Record<string, unknown>): Promise<{ refused: boolean; text: string; data: any }> {
  const r = await rpcOf(await call(app, 'tools/call', { name, arguments: args }))
  const text = r.error?.message ?? r.result?.content?.[0]?.text ?? ''
  const refused = Boolean(r.error) || r.result?.isError === true
  let data: unknown = null
  try {
    data = JSON.parse(text)
  } catch {
    // an error text is not JSON
  }
  return { refused, text, data }
}
/** What the park tool is given: 16 hours out is "Oct 17, 04:00 UTC". */
const parkArgs = (key: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  key,
  state: 'awaiting_source',
  until: iso(T0 + 16 * H),
  by: 'claude',
  note: 'the fix is live and the alert window has not caught up',
  ref: 'SB-9',
  ...over
})

describe('6. MCP: the park and unpark tools', () => {
  it('tools/list has sixteen tools with park and unpark right after silence; both need by, write, and are destructive', async () => {
    const r = await rpcOf(await call(boot(), 'tools/list', {}))
    const tools = r.result?.tools ?? []
    expect(tools).toHaveLength(16)
    expect(tools.map((t) => t.name)).toEqual([
      'watch_state', 'list_incidents', 'get_incident', 'get_fix_context', 'incident_history', 'list_sources',
      'acknowledge', 'unacknowledge', 'silence', 'park', 'unpark', 'comment', 'recheck', 'verify_fix', 'resolve', 'confirm_resolution'
    ])
    const names = tools.map((t) => t.name)
    expect(names.indexOf('park')).toBe(names.indexOf('silence') + 1)
    expect(names.indexOf('unpark')).toBe(names.indexOf('silence') + 2)
    const parkTool = tools.find((t) => t.name === 'park')
    const unparkTool = tools.find((t) => t.name === 'unpark')
    for (const t of [parkTool, unparkTool]) {
      expect(t?.annotations.readOnlyHint).toBe(false)
      expect(t?.annotations.destructiveHint).toBe(true)
      expect(t?.annotations.openWorldHint).toBe(false)
      expect(t?.inputSchema.required).toContain('by')
    }
    expect(parkTool?.inputSchema.required).toEqual(expect.arrayContaining(['key', 'state', 'until', 'by', 'note']))
    expect(parkTool?.inputSchema.required).not.toContain('ref')
    expect(unparkTool?.inputSchema.required).toEqual(expect.arrayContaining(['key', 'by']))
    expect(unparkTool?.inputSchema.required).not.toContain('note')
    expect(tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort()).toEqual(['park', 'resolve', 'silence', 'unacknowledge', 'unpark'])
    expect(tools.filter((t) => !t.annotations.readOnlyHint).every((t) => t.inputSchema.required?.includes('by'))).toBe(true)
  })

  it('the park description says what it is for and that it is never to hide a live problem; the limit is stated', async () => {
    const r = await rpcOf(await call(boot(), 'tools/list', {}))
    const description = r.result?.tools?.find((t) => t.name === 'park')?.description ?? ''
    expect(description).toMatch(/never to hide a live problem/i)
    expect(description).toContain('72 hours')
    expect(description).toContain('not shortened')
    expect(description).toContain('fixed_undeployed')
    expect(description).toContain('awaiting_source')
    expect(description).toContain('deferred')
    const unparkDescription = r.result?.tools?.find((t) => t.name === 'unpark')?.description ?? ''
    expect(unparkDescription).toContain('parked by hand')
  })

  it('park refuses a call with no by, a blank by, a bad state, a missing note and a missing until, and stores nothing', async () => {
    const key = fire()
    const app = boot()
    const { by: _by, ...noBy } = parkArgs(key)
    const { note: _note, ...noNote } = parkArgs(key)
    const { until: _until, ...noUntil } = parkArgs(key)
    for (const args of [noBy, parkArgs(key, { by: '   ' }), parkArgs(key, { state: 'snoozed' }), noNote, parkArgs(key, { note: '' }), noUntil]) {
      expect((await tool(app, 'park', args)).refused, JSON.stringify(args)).toBe(true)
    }
    expect(engine.manualParkOf(key)).toBeNull()
    expect(incidentOf(engine, key).state.attention).toBe('none')
    expect(nudges).toBe(0)
  })

  it('park refuses an until that is not a zoned time, a past one and now, with the reason in the answer', async () => {
    const key = fire()
    const app = boot()
    for (const [until, expected] of [
      ['tomorrow', 'until must be an ISO 8601 time with a zone'],
      ['2026-10-17T04:00:00', 'until must be an ISO 8601 time with a zone'],
      [iso(T0 - MIN), 'until must be after now'],
      [iso(T0), 'until must be after now']
    ] as const) {
      const r = await tool(app, 'park', parkArgs(key, { until }))
      expect(r.refused, until).toBe(true)
      expect(r.text, until).toContain(expected)
    }
    // a note that is only blanks gets past the schema and is refused by the checker
    const blank = await tool(app, 'park', parkArgs(key, { note: '   ' }))
    expect(blank.refused).toBe(true)
    expect(blank.text).toContain('note')
    expect(engine.manualParkOf(key)).toBeNull()
  })

  it('park refuses an until beyond 72 h, naming the latest time, and does not shorten it: nothing is stored', async () => {
    const key = fire()
    const app = boot()
    const r = await tool(app, 'park', parkArgs(key, { until: iso(T0 + 72 * H + 1) }))
    expect(r.refused).toBe(true)
    expect(r.text).toContain(`The latest time it takes is ${iso(T0 + 72 * H)}`)
    expect(r.text).toContain('not shortened')
    expect(engine.manualParkOf(key)).toBeNull()
    expect(incidentOf(engine, key).state.attention).toBe('none')
    expect(engine.wall().header).toMatchObject({ firing: 1, parked: 0 })
    // exactly 72 h is taken
    const ok = await tool(app, 'park', parkArgs(key, { until: iso(T0 + 72 * H) }))
    expect(ok.refused).toBe(false)
    expect(ok.data.until).toBe(iso(T0 + 72 * H))
  })

  it('park holds the limits on the note and the ref: 500 and 64 are taken, 501 and 65 are refused', async () => {
    const key = fire()
    const app = boot()
    expect((await tool(app, 'park', parkArgs(key, { note: 'n'.repeat(501) }))).refused).toBe(true)
    expect((await tool(app, 'park', parkArgs(key, { ref: 'r'.repeat(65) }))).refused).toBe(true)
    expect(engine.manualParkOf(key)).toBeNull()
    const ok = await tool(app, 'park', parkArgs(key, { note: 'n'.repeat(500), ref: 'r'.repeat(64) }))
    expect(ok.refused).toBe(false)
    expect(engine.manualParkOf(key)).toMatchObject({ note: 'n'.repeat(500), ref: 'r'.repeat(64) })
  })

  it('park refuses an incident that is not firing and says where the keys are', async () => {
    fire()
    const r = await tool(boot(), 'park', parkArgs('No|Such'))
    expect(r.refused).toBe(true)
    expect(r.text).toContain('No|Such is not firing')
    expect(r.text).toContain('list_incidents')
    expect(parkKeys(engine)).toEqual([])
  })

  it('park succeeds: it names the author, says parked, carries the incident row with parkedBy, and wakes the notifier', async () => {
    const key = fire()
    const app = boot()
    const r = await tool(app, 'park', parkArgs(key))
    expect(r.refused).toBe(false)
    expect(r.data).toMatchObject({ ok: true, key, by: 'agent: claude', state: 'awaiting_source', until: iso(T0 + 16 * H), replaced: false, attention: 'parked' })
    expect(r.data).not.toHaveProperty('warning')
    expect(r.data.incident).toMatchObject({
      key,
      attention: 'parked',
      parkedBy: 'agent: claude',
      parkedState: 'awaiting_source',
      parkedUntil: iso(T0 + 16 * H),
      parkedSince: iso(T0),
      parkedRef: 'SB-9',
      parkedNote: 'the fix is live and the alert window has not caught up',
      unattendedSec: 0
    })
    expect(nudges).toBe(1)
    expect(incidentOf(engine, key).state.park?.by).toBe('agent: claude')
    // a second park replaces the first
    clock += MIN
    const again = await tool(app, 'park', parkArgs(key, { state: 'deferred', note: 'moved to Monday', ref: undefined }))
    expect(again.refused).toBe(false)
    expect(again.data).toMatchObject({ replaced: true, state: 'deferred', attention: 'parked' })
    expect(again.data.incident.parkedRef).toBeNull()
  })

  it('park on an acknowledged or a silenced incident is recorded and warns that something outranks it', async () => {
    const key = fire()
    const app = boot()
    engine.ack(key, 'the user')
    const acked = await tool(app, 'park', parkArgs(key))
    expect(acked.refused).toBe(false)
    expect(acked.data.attention).toBe('acked')
    expect(acked.data.warning).toContain('acked')
    expect(acked.data.warning).toContain('outranks a park')
    expect(engine.manualParkOf(key)).not.toBeNull()
    // taking the ack off shows the park
    engine.unack(key, 'the user')
    expect(incidentOf(engine, key).state.attention).toBe('parked')
    engine.silence(key, 60, 'the user')
    const silenced = await tool(app, 'park', parkArgs(key, { note: 'again' }))
    expect(silenced.refused).toBe(false)
    expect(silenced.data.attention).toBe('silenced')
    expect(silenced.data.warning).toContain('silenced')
  })

  it('watch_state counts it as parked and as nothing live, and the row names who parked it', async () => {
    const key = fire()
    const app = boot()
    await tool(app, 'park', parkArgs(key))
    const { data } = await tool(app, 'watch_state', {})
    expect(data.counts).toEqual({ firing: 0, unattended: 0, acknowledged: 0, silenced: 0, parked: 1, page: 0, warning: 0, info: 0 })
    expect(data.text).toContain('1 parked')
    expect(data.incidents).toHaveLength(1)
    expect(data.incidents[0]).toMatchObject({ key, attention: 'parked', parkedBy: 'agent: claude', parkedState: 'awaiting_source' })
  })

  it('list_incidents state parked returns it with its fields; firing and unattended leave it out; all keeps it', async () => {
    const key = fire()
    const app = boot()
    await tool(app, 'park', parkArgs(key))
    const parked = await tool(app, 'list_incidents', { state: 'parked' })
    expect(parked.data.firingMatching).toBe(1)
    expect(parked.data.firing[0]).toMatchObject({
      key,
      attention: 'parked',
      parkedBy: 'agent: claude',
      parkedState: 'awaiting_source',
      parkedNote: 'the fix is live and the alert window has not caught up',
      parkedUntil: iso(T0 + 16 * H),
      parkedRef: 'SB-9'
    })
    expect((await tool(app, 'list_incidents', { state: 'firing' })).data.firingMatching).toBe(0)
    expect((await tool(app, 'list_incidents', {})).data.firingMatching).toBe(0)
    expect((await tool(app, 'list_incidents', { state: 'unattended' })).data.firingMatching).toBe(0)
    expect((await tool(app, 'list_incidents', { state: 'all' })).data.firingMatching).toBe(1)
  })

  it('get_incident carries parkedBy on the incident, a park block with by, and the Parked line in its history', async () => {
    const key = fire()
    const app = boot()
    await tool(app, 'park', parkArgs(key))
    const { data } = await tool(app, 'get_incident', { key })
    expect(data.state).toBe('firing')
    expect(data.incident).toMatchObject({ key, attention: 'parked', parkedBy: 'agent: claude' })
    expect(data.park).toEqual({
      state: 'awaiting_source',
      until: iso(T0 + 16 * H),
      since: iso(T0),
      ref: 'SB-9',
      note: 'the fix is live and the alert window has not caught up',
      by: 'agent: claude',
      alertKeys: ['grafana:a1b2c3d4']
    })
    const line = data.history.find((h: { kind: string }) => h.kind === 'park')
    expect(line).toMatchObject({ by: 'agent: claude', agent: true })
    expect(line.text).toBe('Parked by agent: claude until Oct 17, 04:00 UTC (fix live, awaiting source, SB-9). Note: the fix is live and the alert window has not caught up')
  })

  it('park answers which alerts it covers, and a new alert joining ends it: counted live again, unattended, with the join in History', async () => {
    const key = fire()
    const app = boot()
    const r = await tool(app, 'park', parkArgs(key))
    expect(r.refused).toBe(false)
    expect(r.data.covers).toEqual(['grafana:a1b2c3d4'])
    expect(((await tool(app, 'watch_state', {})).data as { counts: Record<string, number> }).counts).toMatchObject({ firing: 0, parked: 1 })
    clock += 5 * MIN
    engine.ingest(poll(grafana(), grafana({ fingerprint: 'b1b2c3d4e5f60718', host: 'node-5' })))
    const state = (await tool(app, 'watch_state', {})).data as { counts: Record<string, number>; incidents: Array<Record<string, unknown>> }
    expect(state.counts).toMatchObject({ firing: 1, unattended: 1, parked: 0 })
    expect(state.incidents[0]).toMatchObject({ attention: 'none', parkedBy: null, unattendedSec: 0 })
    const got = (await tool(app, 'get_incident', { key })).data
    expect(got.park).toBeNull()
    const joined = got.history.find((h: { text: string }) => h.text.startsWith('Park by'))
    expect(joined.text).toBe('Park by agent: claude ended. A new alert joined the incident (DiskFull on node-5)')
    expect(joined.by).toBeUndefined()
    // a park of the whole incident now covers both
    const again = await tool(app, 'park', parkArgs(key))
    expect(again.data.covers).toEqual(['grafana:a1b2c3d4', 'grafana:b1b2c3d4'])
    expect(again.data.replaced).toBe(false)
  })

  it('the park description says what it covers and that a new alert ends it', async () => {
    const r = await rpcOf(await call(boot(), 'tools/list', {}))
    const park = (r.result?.tools ?? []).find((t) => t.name === 'park') as { description?: string } | undefined
    expect(park?.description).toMatch(/covers only the alerts firing when you park/i)
    expect(park?.description).toContain('park.alertKeys')
    expect(park?.description).toMatch(/joins the incident later/i)
  })

  it('get_incident has a null park block for an incident nobody parked', async () => {
    const key = fire()
    const { data } = await tool(boot(), 'get_incident', { key })
    expect(data.park).toBeNull()
    expect(data.incident.parkedBy).toBeNull()
  })

  it('unpark ends it: the author is named, the incident is back unattended from now, and History says so', async () => {
    const key = fire()
    const app = boot()
    await tool(app, 'park', parkArgs(key))
    clock += 10 * MIN
    const r = await tool(app, 'unpark', { key, by: 'claude', note: 'the fix did not hold' })
    expect(r.refused).toBe(false)
    expect(r.data).toMatchObject({ ok: true, key, by: 'agent: claude', at: iso(T0 + 10 * MIN) })
    expect(r.data.incident).toMatchObject({ attention: 'none', parkedBy: null, parkedState: null, unattendedSec: 0 })
    expect(nudges).toBe(2)
    clock += 2 * MIN
    const { data } = await tool(app, 'watch_state', {})
    expect(data.counts).toMatchObject({ firing: 1, unattended: 1, parked: 0 })
    expect(data.incidents[0]).toMatchObject({ attention: 'none', unattendedSec: 120 })
    const got = await tool(app, 'get_incident', { key })
    expect(got.data.park).toBeNull()
    expect(got.data.history.some((h: { text: string }) => h.text === 'Unparked by agent: claude. Note: the fix did not hold')).toBe(true)
  })

  it('unpark refuses a call with no by, an incident never parked by hand, a park that already ended, and a key that is not firing', async () => {
    const key = fire()
    const app = boot()
    expect((await tool(app, 'unpark', { key })).refused).toBe(true)
    expect((await tool(app, 'unpark', { key, by: '   ' })).refused).toBe(true)

    const never = await tool(app, 'unpark', { key, by: 'agent: claude' })
    expect(never.refused).toBe(true)
    expect(never.text).toContain('was not parked by hand')

    await tool(app, 'park', parkArgs(key))
    expect((await tool(app, 'unpark', { key, by: 'agent: claude' })).refused).toBe(false)
    const ended = await tool(app, 'unpark', { key, by: 'agent: claude' })
    expect(ended.refused).toBe(true)
    expect(ended.text).toContain(`its park already ended at ${iso(T0)}`)

    const gone = await tool(app, 'unpark', { key: 'No|Such', by: 'agent: claude' })
    expect(gone.refused).toBe(true)
    expect(gone.text).toContain('No|Such is not firing')
    expect(eventsOf(engine, key, 'unpark')).toHaveLength(1)
  })

  it('unpark refuses a park the sweep states in its annotations', async () => {
    engine.ingest(sweepPush(sweepAlert('CiRed', ann(T0 + 20 * H))))
    const key = engine.wall().incidents[0].key
    const r = await tool(boot(), 'unpark', { key, by: 'agent: claude' })
    expect(r.refused).toBe(true)
    expect(r.text).toContain('was not parked by hand')
    expect(incidentOf(engine, key).state.attention).toBe('parked')
  })

  it('park works on a sweep incident too, and list_incidents says who parked it', async () => {
    engine.ingest(sweepPush(sweepAlert('CiRed', ann(T0 + 20 * H))))
    const key = engine.wall().incidents[0].key
    const app = boot()
    const before = await tool(app, 'list_incidents', { state: 'parked' })
    expect(before.data.firing[0]).toMatchObject({ key, parkedBy: null })
    const r = await tool(app, 'park', parkArgs(key, { until: iso(T0 + 3 * H) }))
    expect(r.refused).toBe(false)
    const after = await tool(app, 'list_incidents', { state: 'parked' })
    expect(after.data.firing[0]).toMatchObject({ key, parkedBy: 'agent: claude', parkedUntil: iso(T0 + 3 * H) })
  })

  it('incident_history lists the park and the unpark among the actions, newest first, with who', async () => {
    const key = fire()
    const app = boot()
    await tool(app, 'park', parkArgs(key))
    clock += 10 * MIN
    await tool(app, 'unpark', { key, by: 'claude', note: 'the fix did not hold' })
    const { data } = await tool(app, 'incident_history', {})
    expect(data.resolved).toEqual([])
    expect(data.actions.map((a: { kind: string }) => a.kind)).toEqual(['unpark', 'park'])
    expect(data.actions[0]).toMatchObject({ incident: key, by: 'agent: claude', agent: true, text: 'Unparked by agent: claude. Note: the fix did not hold' })
    expect(data.actions[1]).toMatchObject({ incident: key, by: 'agent: claude', agent: true })
    expect(data.actions[1].text).toBe('Parked by agent: claude until Oct 17, 04:00 UTC (fix live, awaiting source, SB-9). Note: the fix is live and the alert window has not caught up')
    expect(data.actionsMatching).toBe(2)
  })
})

// ---- 7. the words on a tile and in a sheet -------------------------------------------------------------------------------------------

describe('7. web copy: parkedParts, parkedLine and parkedDetail', () => {
  const byHand: Park = { state: 'awaiting_source', until: iso(T0 + 16 * H), since: iso(T0), ref: null, note: 'The fix is live; the window has not caught up.', by: 'agent: claude' }
  const bySweep: Park = { state: 'fixed_undeployed', until: iso(T0 + 20 * H), since: iso(T0 - 2 * H), ref: 'SB-4412', note: 'Fix merged, waits for the edge deploy' }
  const whoOf = (by: string): RegExp => new RegExp(`^Parked until ${STAMP} by ${by}$`)
  const bare = new RegExp(`^Parked until ${STAMP}$`)

  it('the reasons: fix live, awaiting source is the third', () => {
    expect(PARK_REASON).toEqual({ deferred: 'deferred', fixed_undeployed: 'fix not deployed', awaiting_source: 'fix live, awaiting source' })
  })

  it('a hand park reads "Parked until <stamp> by agent: claude" and the reason; the ticket follows the reason', () => {
    const p = parkedParts(byHand)
    expect(p.who).toMatch(whoOf('agent: claude'))
    expect(p.when).toBe('Fix live, awaiting source')
    expect(parkedParts({ ...byHand, ref: 'SB-9' }).when).toBe('Fix live, awaiting source, SB-9')
    expect(parkedParts({ ...byHand, state: 'deferred' }).when).toBe('Deferred')
    expect(parkedParts({ ...byHand, state: 'fixed_undeployed', by: 'the user' }).who).toMatch(whoOf('the user'))
    expect(parkedLine(byHand)).toBe(`${p.who}. ${p.when}`)
    expect(parkedLine(byHand)).toMatch(new RegExp(`^Parked until ${STAMP} by agent: claude\\. Fix live, awaiting source$`))
  })

  it('a stored actor that names nobody leaves the "by" out', () => {
    for (const by of ['this browser', 'This Browser', 'wall', 'someone', '']) {
      const p = parkedParts({ ...byHand, by })
      expect(p.who, by).toMatch(bare)
      expect(p.who, by).not.toContain(' by ')
      expect(parkedLine({ ...byHand, by }), by).toMatch(new RegExp(`^Parked until ${STAMP}\\. Fix live, awaiting source$`))
    }
  })

  it('a park the sweep states (no by) reads as it always did', () => {
    const p = parkedParts(bySweep)
    expect(p.who).toMatch(bare)
    expect(p.when).toBe('Fix not deployed, SB-4412')
    expect(parkedParts({ ...bySweep, state: 'deferred', ref: null }).when).toBe('Deferred')
    expect(parkedLine(bySweep)).toBe(`${p.who}. ${p.when}`)
  })

  it('the sheet says the reason, the ticket, the note, who parked it and since when, and what happens at the end', () => {
    const d = parkedDetail({ ...byHand, ref: 'SB-9' })
    expect(d).toMatch(
      new RegExp(
        `^Reason: fix live, awaiting source\\. Ticket SB-9\\. The fix is live; the window has not caught up\\. Parked since ${STAMP} by agent: claude\\. It is not paged while it is parked, and comes back unattended when the park ends\\.$`
      )
    )
  })

  it('the sheet leaves the name out for a stored actor that names nobody, and for a park the sweep states', () => {
    const nobody = parkedDetail({ ...byHand, by: 'this browser' })
    expect(nobody).toMatch(new RegExp(`Parked since ${STAMP}\\. It is not paged`))
    expect(nobody).not.toContain(' by ')
    const sweep = parkedDetail(bySweep)
    expect(sweep).toContain('Reason: fix not deployed.')
    expect(sweep).toContain('Ticket SB-4412.')
    expect(sweep).toContain('Fix merged, waits for the edge deploy.')
    expect(sweep).toMatch(new RegExp(`Parked since ${STAMP}\\. It is not paged`))
    expect(sweep).not.toContain(' by ')
    expect(parkedDetail({ ...bySweep, since: null, ref: null, note: null })).toBe('Reason: fix not deployed. It is not paged while it is parked, and comes back unattended when the park ends.')
  })

  it('a hand park with no start still names who set it; one that names nobody says nothing of it', () => {
    expect(parkedDetail({ ...byHand, since: null, note: null })).toBe('Reason: fix live, awaiting source. Parked by agent: claude. It is not paged while it is parked, and comes back unattended when the park ends.')
    expect(parkedDetail({ ...byHand, since: null, note: null, by: 'this browser' })).toBe('Reason: fix live, awaiting source. It is not paged while it is parked, and comes back unattended when the park ends.')
  })

  it('the incident the engine builds reads the same through these functions', () => {
    const key = fire()
    engine.park(key, ask({ until: iso(T0 + 16 * H), ref: 'SB-9' }))
    const park = incidentOf(engine, key).state.park as Park
    expect(parkedParts(park).who).toMatch(whoOf('agent: claude'))
    expect(parkedParts(park).when).toBe('Fix live, awaiting source, SB-9')
    expect(parkedDetail(park)).toMatch(new RegExp(`Parked since ${STAMP} by agent: claude\\.`))
  })
})
