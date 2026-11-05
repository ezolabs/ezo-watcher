// The parked attention state (docs/design.md, Parked). An incident whose every firing alert states `parked_state` (deferred or fixed_undeployed) and a
// `parked_until` later than now and no more than 72 h after it is `parked`: its own state, tile, wall section and count, never paged, back in its tier when the park
// ends with its unattended clock starting at the park's end. Written, not run, in the session that added it (agent test runs were off). Run it with
// `npx vitest run --configLoader runner test/parked.test.ts` from the repo root; the state function is covered against an independent reading of the rule over a
// generated grid of cases, the rest case by case over a real engine.
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { WatchConfig, RouteConfig } from '../src/server/config.ts'
import { makeAlert } from '../src/server/derive.ts'
import type { AlertDraft } from '../src/server/derive.ts'
import { openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'
import { incidentRow, summarizeWall, filterFiring } from '../src/server/mcp/shape.ts'
import { fingerprintDigest, logKey, planSends } from '../src/server/notify/plan.ts'
import type { Plan } from '../src/server/notify/plan.ts'
import type { LogRow } from '../src/server/notify/types.ts'
import { cardOf, CARD_FIELDS } from '../src/shared/card.ts'
import { incidentPark, incidentState, isParked, parkOf, PARK_MAX_HOURS, PARK_MAX_MS, unattendedSecOf } from '../src/shared/incident.ts'
import { groupHeadId, incidentGroupOrder, layoutWall, PARKED_GROUP, wallHeight } from '../src/shared/layout.ts'
import type { LayoutItem, LayoutOptions, TierRule } from '../src/shared/layout.ts'
import { summaryOf } from '../src/shared/summary.ts'
import type { Alert, Attention, Incident, Observation } from '../src/shared/types.ts'
import { wallGroupProblems } from '../src/shared/wall-groups.ts'
import { heroOf, parkedDetail, parkedLine, parkedParts, statusCounts } from '../src/web/lib/ack.ts'
import { flatEntries, GroupHead, groupCountText, IncidentTile, wallEntries } from '../src/web/components/Wall.tsx'
import type { Entry, Tile } from '../src/web/components/Wall.tsx'

const T0 = Date.parse('2026-10-16T12:00:00Z')
const H = 3_600_000
const MIN = 60_000
const iso = (ms: number): string => new Date(ms).toISOString()

// ---- the state function ----------------------------------------------------------------------------------------------------------

const ann = (until: number | string, state = 'deferred', extra: Record<string, string> = {}): Record<string, string> => ({
  parked_state: state,
  parked_until: typeof until === 'number' ? iso(until) : until,
  ...extra
})

describe('parkOf: what one alert states', () => {
  it('reads state, end, start, ticket and note, and nothing else', () => {
    expect(parkOf(ann(T0 + H, 'fixed_undeployed', { parked_since: iso(T0 - H), parked_ref: 'SB-4412', parked_note: 'Fix merged, waits for the deploy.' }))).toEqual({
      state: 'fixed_undeployed',
      until: iso(T0 + H),
      since: iso(T0 - H),
      ref: 'SB-4412',
      note: 'Fix merged, waits for the deploy.'
    })
    expect(parkOf(ann(T0 + H))).toEqual({ state: 'deferred', until: iso(T0 + H), since: null, ref: null, note: null })
  })

  it('states no park when the state is not one of the two, or the end is missing, unzoned or not a time', () => {
    const bad: Array<Record<string, string> | undefined> = [
      undefined,
      {},
      { parked_state: 'deferred' },
      { parked_until: iso(T0 + H) },
      ann(T0 + H, 'snoozed'),
      ann(T0 + H, ''),
      ann('2026-10-16T14:00:00'),
      ann('tomorrow'),
      ann('2026-13-45T99:00:00Z'),
      ann('')
    ]
    for (const a of bad) expect(parkOf(a)).toBeNull()
  })

  it('accepts a zone as an offset, any case of the state word, and folds the ticket and the note to one short line', () => {
    expect(parkOf(ann('2026-10-16T08:00:00-06:00', 'DEFERRED'))?.until).toBe('2026-10-16T14:00:00.000Z')
    const long = parkOf(ann(T0 + H, 'deferred', { parked_ref: `  SB-1\n${'x'.repeat(100)} `, parked_note: `a\tb\r\n${'n'.repeat(300)}` }))
    expect(long?.ref).toMatch(/^SB-1 x+…$/)
    expect(long?.ref?.length).toBe(64)
    expect(long?.note?.startsWith('a b n')).toBe(true)
    expect(long?.note?.length).toBe(200)
    expect(long?.note).not.toMatch(/[\r\n\t]/)
  })

  it('an incident states a park only when every firing alert does, and the park that ends first governs', () => {
    expect(incidentPark([])).toBeNull()
    expect(incidentPark([ann(T0 + 5 * H), ann(T0 + 2 * H, 'fixed_undeployed')])?.until).toBe(iso(T0 + 2 * H))
    expect(incidentPark([ann(T0 + 5 * H), ann(T0 + 2 * H, 'fixed_undeployed')])?.state).toBe('fixed_undeployed')
    expect(incidentPark([ann(T0 + 5 * H), {}])).toBeNull()
    expect(incidentPark([ann(T0 + 5 * H), undefined])).toBeNull()
    expect(incidentPark([ann(T0 + 5 * H), ann('soon')])).toBeNull()
  })
})

/** The rule, read independently of the code: silenced beats acked beats a park that ends after now and within 72 h of it. */
function oracle(c: { silenced: boolean; acked: boolean; offsetMs: number | null; valid: boolean }): Attention {
  if (c.silenced) return 'silenced'
  if (c.acked) return 'acked'
  if (c.valid && c.offsetMs !== null && c.offsetMs > 0 && c.offsetMs <= 72 * H) return 'parked'
  return 'none'
}

describe('incidentState: the one derivation, over every combination of the cases that matter', () => {
  // offsets from now: expired long ago, a second ago, now, one second away, inside, on the 72 h ceiling, one millisecond over it, a week out, and no park at all
  const offsets: Array<number | null> = [-30 * H, -1000, 0, 1000, 20 * H, 72 * H - 1, 72 * H, 72 * H + 1, 7 * 24 * H, null]
  const states = ['deferred', 'fixed_undeployed', 'snoozed']
  const startsAtMs = T0 - 9 * H

  for (const silenced of [false, true]) {
    for (const acked of [false, true]) {
      for (const offsetMs of offsets) {
        for (const state of states) {
          const name = `${silenced ? 'silenced, ' : ''}${acked ? 'acked, ' : ''}${offsetMs === null ? 'no park' : `park ${offsetMs / MIN} min out as ${state}`}`
          it(name, () => {
            const annotations = offsetMs === null ? [{}] : [ann(T0 + offsetMs, state)]
            const s = incidentState({
              severity: 'warning',
              instances: 1,
              startsAtMs,
              nowMs: T0,
              ackedAtMs: acked ? T0 - 30 * MIN : null,
              silencedUntilMs: silenced ? T0 + H : null,
              annotations
            })
            const want = oracle({ silenced, acked, offsetMs, valid: state !== 'snoozed' })
            expect(s.attention).toBe(want)
            if (want === 'parked') {
              // the quiet tier at the quiet weight, counted as firing nowhere, with the park it states and a clock that has not started
              expect(s.tier).toBe('quiet')
              expect(s.R).toBe(1)
              expect(s.firing).toBe(false)
              expect(s.band).toBe(0)
              expect(s.park?.until).toBe(iso(T0 + (offsetMs as number)))
              expect(unattendedSecOf(s, null, T0)).toBe(0)
              expect(isParked({ state: s })).toBe(true)
            } else {
              expect(s.park).toBeNull()
              expect(s.firing).toBe(true)
              expect(isParked({ state: s })).toBe(false)
            }
            // an expired park hands the clock to the park's end; anything else counts from the incident's own start (a park too far out is not honoured at all)
            const expired = offsetMs !== null && offsetMs <= 0 && state !== 'snoozed'
            expect(s.unattendedSinceMs).toBe(expired ? Math.max(startsAtMs, T0 + (offsetMs as number)) : startsAtMs)
            // the severity tier comes back whenever nobody has the incident and no park holds
            if (!silenced && want !== 'parked') expect(s.tier).toBe('warning')
          })
        }
      }
    }
  }

  it('the ceiling is exactly 72 h: a park 72 h out holds, one millisecond further does not', () => {
    expect(PARK_MAX_HOURS).toBe(72)
    expect(PARK_MAX_MS).toBe(72 * H)
    const at = (ms: number) => incidentState({ severity: 'page', instances: 1, startsAtMs: T0 - H, nowMs: T0, annotations: [ann(T0 + ms)] }).attention
    expect(at(72 * H)).toBe('parked')
    expect(at(72 * H + 1)).toBe('none')
  })

  it('a park that has ended counts the unattended age from parked_until, never from the first firing', () => {
    const until = T0 - 5 * MIN
    const s = incidentState({ severity: 'page', instances: 1, startsAtMs: T0 - 30 * H, nowMs: T0, annotations: [ann(until)] })
    expect(s.attention).toBe('none')
    expect(s.tier).toBe('page')
    expect(unattendedSecOf(s, null, T0)).toBe(300)
    // five minutes old, so the youngest age band, not the day-old one the incident itself is
    expect(s.band).toBe(0)
    const later = incidentState({ severity: 'page', instances: 1, startsAtMs: T0 - 30 * H, nowMs: T0 + 2 * H, annotations: [ann(until)] })
    expect(later.band).toBe(2)
    // a park that ended before the incident began changes nothing
    const old = incidentState({ severity: 'page', instances: 1, startsAtMs: T0 - 60 * MIN, nowMs: T0, annotations: [ann(T0 - 2 * H)] })
    expect(old.unattendedSinceMs).toBe(T0 - 60 * MIN)
  })

  it('an acknowledged incident with a park is acknowledged, and its age still freezes at the ack', () => {
    const s = incidentState({ severity: 'warning', instances: 1, startsAtMs: T0 - 9 * H, nowMs: T0, ackedAtMs: T0 - 4 * H, annotations: [ann(T0 + H)] })
    expect(s.attention).toBe('acked')
    expect(s.park).toBeNull()
    expect(unattendedSecOf(s, T0 - 4 * H, T0)).toBe(5 * 3600)
  })

  it('a park read already (a roll-up) is used in place of the annotations', () => {
    const park = parkOf(ann(T0 + H))
    expect(incidentState({ severity: 'warning', instances: 2, startsAtMs: T0 - H, nowMs: T0, park }).attention).toBe('parked')
    expect(incidentState({ severity: 'warning', instances: 2, startsAtMs: T0 - H, nowMs: T0, park: null, annotations: [ann(T0 + H)] }).attention).toBe('none')
  })

  it('several alerts: parked only when every one states a park, and it ends with the first of them', () => {
    const run = (a: Array<Record<string, string>>, nowMs = T0) => incidentState({ severity: 'warning', instances: a.length, startsAtMs: T0 - H, nowMs, annotations: a })
    expect(run([ann(T0 + 2 * H), ann(T0 + 5 * H)]).attention).toBe('parked')
    expect(run([ann(T0 + 2 * H), ann(T0 + 5 * H)]).park?.until).toBe(iso(T0 + 2 * H))
    expect(run([ann(T0 + 2 * H), {}]).attention).toBe('none')
    expect(run([ann(T0 + 2 * H), ann(T0 + 5 * H)], T0 + 3 * H).attention).toBe('none')
  })
})

// ---- a real engine ---------------------------------------------------------------------------------------------------------------

const cfg: WatchConfig = {
  baseUrl: 'https://watch.test',
  port: 0,
  host: '127.0.0.1',
  dataDir: ':memory:',
  historyHours: 24,
  staleAfterMisses: 3,
  sources: [{ id: 'sweep', type: 'webhook', tokenEnv: 'T', staleAfterSec: 43200, presenceTtlSec: 86400 }],
  serviceMap: [],
  channels: [],
  routes: [],
  quietHours: null
}

let clock = T0

function sweepDraft(rule: string, annotations: Record<string, string>, over: Partial<AlertDraft> = {}): AlertDraft {
  return {
    origin: 'sweep',
    rule,
    labels: { alertname: rule, service: 'Regression sweep', severity: 'warning' },
    annotations: { summary: `${rule} is red`, ...annotations },
    startsAt: iso(T0 - 9 * H),
    via: { source: 'sweep', kind: 'webhook', lastSeen: iso(clock) },
    raw: {},
    ...over
  }
}
const sweepAlert = (rule: string, annotations: Record<string, string> = {}, over: Partial<AlertDraft> = {}): Alert => makeAlert(sweepDraft(rule, annotations, { fingerprint: `${rule.length.toString(16).padStart(2, '0')}${rule.charCodeAt(0).toString(16)}b2c3d4e5f60718`, ...over }), [], iso(clock))
const push = (...alerts: Alert[]): Observation => ({ source: 'sweep', kind: 'webhook', at: iso(clock), firing: alerts, resolved: [], complete: false })
const fresh = (): Engine => {
  clock = T0
  return new Engine(openDb(':memory:'), cfg, () => clock)
}
const wallOf = (e: Engine) => e.wall()
const byRule = (e: Engine, rule: string): Incident => {
  const found = e.wall().incidents.find((i) => i.rule === rule)
  if (!found) throw new Error(`no incident ${rule}`)
  return found
}

describe('the engine: parked from the annotations, in every count', () => {
  it('a pushed alert with a park is parked, and the wall counts it as parked and as nothing live', () => {
    const e = fresh()
    e.ingest(push(sweepAlert('CiRed', ann(T0 + 20 * H, 'fixed_undeployed', { parked_since: iso(T0 - 2 * H), parked_ref: 'SB-4412', parked_note: 'waits for the deploy' }))))
    const i = byRule(e, 'CiRed')
    expect(i.state).toMatchObject({ attention: 'parked', tier: 'quiet', R: 1, firing: false })
    expect(i.state.park).toEqual({ state: 'fixed_undeployed', until: iso(T0 + 20 * H), since: iso(T0 - 2 * H), ref: 'SB-4412', note: 'waits for the deploy' })
    expect(wallOf(e).header).toMatchObject({ firing: 0, acknowledged: 0, parked: 1 })
    expect(summaryOf(wallOf(e))).toMatchObject({ v: 1, firing: 0, unattended: 0, acknowledged: 0, parked: 1, worst: 'none', bySeverity: { page: 0, warning: 0, info: 0 }, unattendedBySeverity: { page: 0, warning: 0, info: 0 } })
    // no next step is promised, and the pager reads no unattended time
    expect(i.nextStep).toBeNull()
    expect(e.notifyViews().views[0]).toMatchObject({ attention: 'parked', unattendedSec: 0 })
  })

  it('a park more than 72 h out is not honoured: the incident shows unattended, from its own start', () => {
    const e = fresh()
    e.ingest(push(sweepAlert('CiRed', ann(T0 + 72 * H + MIN))))
    const i = byRule(e, 'CiRed')
    expect(i.state.attention).toBe('none')
    expect(i.state.firing).toBe(true)
    expect(i.state.unattendedSinceMs).toBe(T0 - 9 * H)
    expect(wallOf(e).header).toMatchObject({ firing: 1, parked: 0 })
    expect(summaryOf(wallOf(e))).toMatchObject({ firing: 1, unattended: 1, parked: 0 })
  })

  it('the counts: live, acknowledged, silenced and parked incidents are each counted once, and a parked one in no other tally', () => {
    const e = fresh()
    e.ingest(push(sweepAlert('Live'), sweepAlert('Acked'), sweepAlert('Silenced'), sweepAlert('Parked', ann(T0 + 3 * H)), sweepAlert('ParkedPage', ann(T0 + 6 * H), { labels: { alertname: 'ParkedPage', service: 'Regression sweep', severity: 'page' } })))
    e.ack(byRule(e, 'Acked').key, 'the user')
    e.silence(byRule(e, 'Silenced').key, 60, 'the user')
    const w = wallOf(e)
    expect(w.incidents.map((i) => `${i.rule}:${i.state.attention}`).sort()).toEqual(['Acked:acked', 'Live:none', 'Parked:parked', 'ParkedPage:parked', 'Silenced:silenced'])
    expect(w.header).toMatchObject({ firing: 3, acknowledged: 1, parked: 2 })
    const s = summaryOf(w)
    expect(s).toMatchObject({ firing: 3, unattended: 1, acknowledged: 1, parked: 2, worst: 'warning' })
    expect(s.bySeverity).toEqual({ page: 0, warning: 3, info: 0 })
    expect(s.unattendedBySeverity).toEqual({ page: 0, warning: 1, info: 0 })
    // a page that is parked is not a page: nothing pages, and the tab badge's test (a page nobody has) finds none
    expect(w.incidents.filter((i) => i.severity === 'page' && i.state.attention === 'none')).toEqual([])
    expect(e.notifyViews().views.filter((v) => v.attention === 'none').map((v) => v.rule)).toEqual(['Live'])
  })

  it('precedence: silenced, then acknowledged, then parked, and a removed ack or silence gives the park back', () => {
    const e = fresh()
    e.ingest(push(sweepAlert('CiRed', ann(T0 + 20 * H))))
    const key = byRule(e, 'CiRed').key
    expect(byRule(e, 'CiRed').state.attention).toBe('parked')
    e.ack(key, 'the user')
    expect(byRule(e, 'CiRed').state.attention).toBe('acked')
    e.silence(key, 60, 'the user')
    expect(byRule(e, 'CiRed').state.attention).toBe('silenced')
    e.unack(key, 'the user')
    expect(byRule(e, 'CiRed').state.attention).toBe('parked')
  })

  it('every alert of an incident must carry the park: one that does not keeps the incident live', () => {
    const e = fresh()
    const a = sweepAlert('CiRed', ann(T0 + 20 * H), { labels: { alertname: 'CiRed', service: 'Regression sweep', severity: 'warning', host: 'node-4' }, fingerprint: 'aaaa1111' })
    const b = sweepAlert('CiRed', {}, { labels: { alertname: 'CiRed', service: 'Regression sweep', severity: 'warning', host: 'node-5' }, fingerprint: 'bbbb2222' })
    e.ingest(push(a, b))
    expect(e.wall().incidents).toHaveLength(1)
    expect(e.wall().incidents[0].alerts).toHaveLength(2)
    expect(e.wall().incidents[0].state.attention).toBe('none')
    e.ingest(push(a, sweepAlert('CiRed', ann(T0 + 10 * H), { labels: { alertname: 'CiRed', service: 'Regression sweep', severity: 'warning', host: 'node-5' }, fingerprint: 'bbbb2222' })))
    expect(e.wall().incidents[0].state.attention).toBe('parked')
    expect(e.wall().incidents[0].state.park?.until).toBe(iso(T0 + 10 * H))
  })
})

describe('the annotations never change identity, and a push states the whole park', () => {
  it('the same labels give one alert key and one incident key with the annotations absent, present, changed and absent again', () => {
    const e = fresh()
    const plain = sweepAlert('CiRed', {}, { fingerprint: undefined })
    const parked = sweepAlert('CiRed', ann(T0 + 20 * H, 'deferred', { parked_ref: 'SB-1' }), { fingerprint: undefined })
    const moved = sweepAlert('CiRed', ann(T0 + 40 * H, 'fixed_undeployed', { parked_note: 'later' }), { fingerprint: undefined })
    expect(plain.key).toBe(parked.key)
    expect(plain.key).toBe(moved.key)
    expect(plain.fingerprint).toBe(parked.fingerprint)
    e.ingest(push(plain))
    const key = e.wall().incidents[0].key
    for (const [a, attention] of [[parked, 'parked'], [moved, 'parked'], [plain, 'none'], [parked, 'parked']] as const) {
      e.ingest(push(a))
      expect(e.wall().incidents).toHaveLength(1)
      expect(e.wall().incidents[0].key).toBe(key)
      expect(e.wall().incidents[0].alerts.map((x) => x.key)).toEqual([plain.key])
      expect(e.wall().incidents[0].state.attention).toBe(attention)
    }
  })

  it('a push without the annotations ends the park at once and leaves no parked key on the alert; a later push parks it again', () => {
    const e = fresh()
    e.ingest(push(sweepAlert('CiRed', ann(T0 + 20 * H, 'deferred', { parked_since: iso(T0 - H), parked_ref: 'SB-1', parked_note: 'later' }))))
    e.ingest(push(sweepAlert('CiRed', { summary: 'CiRed is red' })))
    const back = byRule(e, 'CiRed')
    expect(back.state.attention).toBe('none')
    for (const k of ['parked_state', 'parked_until', 'parked_since', 'parked_ref', 'parked_note']) expect(back.alerts[0].annotations[k]).toBeUndefined()
    expect(back.alerts[0].annotations.summary).toBe('CiRed is red')
    e.ingest(push(sweepAlert('CiRed', ann(T0 + 30 * H))))
    expect(byRule(e, 'CiRed').state.attention).toBe('parked')
  })

  it('a poll of the same alert that says nothing about a park does not end one', () => {
    const e = fresh()
    e.ingest(push(sweepAlert('CiRed', ann(T0 + 20 * H))))
    const polled = sweepAlert('CiRed', {}, { via: { source: 'sweep', kind: 'grafana', lastSeen: iso(clock) } })
    e.ingest({ source: 'sweep', kind: 'grafana', at: iso(clock), firing: [polled], resolved: [], complete: false })
    expect(byRule(e, 'CiRed').state.attention).toBe('parked')
  })
})

describe('when the park ends', () => {
  it('the incident is back in its severity tier, unattended, and its age counts from parked_until', () => {
    const e = fresh()
    const end = T0 + 2 * H
    const park = ann(end)
    e.ingest(push(sweepAlert('CiRed', park)))
    expect(byRule(e, 'CiRed').state.attention).toBe('parked')
    clock = end + 5 * MIN
    // the sweep pushes the same stale park again, as it does four times a day: it has ended, so it holds nothing
    e.ingest(push(sweepAlert('CiRed', park)))
    const back = byRule(e, 'CiRed')
    expect(back.state).toMatchObject({ attention: 'none', tier: 'warning', firing: true, band: 0, park: null, unattendedSinceMs: end })
    expect(e.wall().header).toMatchObject({ firing: 1, parked: 0 })
    const view = e.notifyViews().views[0]
    expect(view.unattendedSec).toBe(300)
    expect(view.freshSince).toBe(iso(end))
    const row = incidentRow(back, clock, 0, cfg.baseUrl)
    expect(row.unattendedSec).toBe(300)
    expect(row.ageSec).toBe(Math.round((clock - (T0 - 9 * H)) / 1000))
  })

  it('an incident that was never parked has no fresh start', () => {
    const e = fresh()
    e.ingest(push(sweepAlert('CiRed')))
    expect(e.notifyViews().views[0].freshSince ?? null).toBeNull()
  })
})

// ---- the pager ---------------------------------------------------------------------------------------------------------------------

describe('the pager: nothing while parked, a fresh episode when the park ends', () => {
  const route: RouteConfig = { id: 'page', match: {}, receivers: ['ntfy'], mode: 'all', groupWaitSec: 0, groupIntervalSec: 60, repeatIntervalSec: 3600, escalate: [{ afterSec: 600, receivers: ['sms'] }] }
  const planOf = (e: Engine, log: Map<string, LogRow>): Plan => {
    const { views, resolved } = e.notifyViews()
    return planSends({ routes: [route], views, resolved, nowMs: clock, quiet: false, getLog: (k) => log.get(k) ?? null, getHeld: () => [] })
  }
  const sent = (log: Map<string, LogRow>, p: Plan, at: number): void => {
    for (const s of p.sends) for (const t of s.targets) log.set(t.logKey, { key: t.logKey, sentAt: at, digest: s.digest, ok: true, attempts: 0, nextAttemptAt: null })
  }

  it('plans no send of any kind, escalation and digest included, at any moment of a park, however old the incident is', () => {
    const e = fresh()
    const end = T0 + 20 * H
    e.ingest(push(sweepAlert('CiRed', ann(end))))
    const log = new Map<string, LogRow>()
    // sampled every 7 minutes (a stride that meets every minute of the hour), the whole length of the park
    for (let t = T0; t < end; t += 7 * MIN) {
      clock = t
      const p = planOf(e, log)
      expect(p.sends).toEqual([])
      expect(p.held).toEqual([])
    }
    // the last moment before it ends is still silent
    clock = end - 1
    expect(planOf(e, log).sends).toEqual([])
  })

  it('at the end the page goes out as a fresh one would, and the escalation steps count from parked_until', () => {
    const e = fresh()
    const end = T0 + 20 * H
    e.ingest(push(sweepAlert('CiRed', ann(end))))
    const log = new Map<string, LogRow>()
    clock = end
    const first = planOf(e, log)
    expect(first.sends.map((s) => s.stage)).toEqual(['alert'])
    sent(log, first, clock)
    // the incident is a day old, but nobody has had it for 599 s: no escalation yet
    clock = end + 599_000
    expect(planOf(e, log).sends).toEqual([])
    clock = end + 600_000
    expect(planOf(e, log).sends.map((s) => s.stage)).toEqual(['esc0'])
  })

  it('a notification sent before the park does not hold the page back when it ends; an incident that was never parked is held by it as before', () => {
    const e = fresh()
    const end = T0 + 4 * H
    e.ingest(push(sweepAlert('CiRed', ann(end))))
    clock = end
    const view = e.notifyViews().views[0]
    const key = logKey(view.key, 'page', 'ntfy', 'alert')
    const before: LogRow = { key, sentAt: T0 - 10 * MIN, digest: fingerprintDigest(view), ok: true, attempts: 0, nextAttemptAt: null }
    expect(planOf(e, new Map([[key, before]])).sends.map((s) => s.stage)).toEqual(['alert'])
    // the control: the same row, an incident nobody ever parked, and the repeat interval has not passed
    const plain = fresh()
    plain.ingest(push(sweepAlert('CiRed')))
    clock = T0 + 20 * MIN
    const v = plain.notifyViews().views[0]
    const k = logKey(v.key, 'page', 'ntfy', 'alert')
    const recent: LogRow = { key: k, sentAt: clock - 60_000, digest: fingerprintDigest(v), ok: true, attempts: 0, nextAttemptAt: null }
    expect(planOf(plain, new Map([[k, recent]])).sends.filter((s) => s.stage === 'alert')).toEqual([])
  })

  it('group wait counts from the end of the park', () => {
    const e = fresh()
    const end = T0 + H
    e.ingest(push(sweepAlert('CiRed', ann(end))))
    const waits: RouteConfig = { ...route, groupWaitSec: 120 }
    const at = (ms: number): Plan => {
      clock = ms
      const { views, resolved } = e.notifyViews()
      return planSends({ routes: [waits], views, resolved, nowMs: clock, quiet: false, getLog: () => null, getHeld: () => [] })
    }
    expect(at(end + 119_000).sends).toEqual([])
    expect(at(end + 120_000).sends.map((s) => s.stage)).toEqual(['alert'])
  })

  it('the engine says nothing into the operator log of a parked incident that reopens, and still does for one that is not parked', () => {
    for (const [parked, expected] of [[true, 0], [false, 1]] as const) {
      const e = fresh()
      const notes: string[] = []
      e.onNote = (key, kind) => void notes.push(`${kind}:${key}`)
      const a = (): Alert => sweepAlert('CiRed', parked ? ann(T0 + 20 * H) : {})
      e.ingest(push(a()))
      const key = byRule(e, 'CiRed').key
      expect(e.resolveManual(key, 'agent: claude', 'fixed').ok).toBe(true)
      clock += MIN
      e.ingest(push(a()))
      expect(byRule(e, 'CiRed').state.attention).toBe(parked ? 'parked' : 'none')
      expect(notes).toHaveLength(expected)
    }
  })
})

// ---- the MCP surface and the card ---------------------------------------------------------------------------------------------------

describe('MCP: attention parked, its fields, the parked filter, and unattended leaves it out', () => {
  const build = () => {
    const e = fresh()
    e.ingest(push(sweepAlert('Live'), sweepAlert('Acked'), sweepAlert('Parked', ann(T0 + 6 * H, 'fixed_undeployed', { parked_since: iso(T0 - H), parked_ref: 'SB-9', parked_note: 'waits' }))))
    e.ack(byRule(e, 'Acked').key, 'the user')
    return e
  }

  it('the row carries attention, the state, the end, the start, the ticket and the note, and null for all of them on an incident that is not parked', () => {
    const e = build()
    const w = e.wall()
    const parked = incidentRow(byRule(e, 'Parked'), Date.parse(w.generatedAt), 0, cfg.baseUrl)
    expect(parked).toMatchObject({ attention: 'parked', parkedState: 'fixed_undeployed', parkedUntil: iso(T0 + 6 * H), parkedSince: iso(T0 - H), parkedRef: 'SB-9', parkedNote: 'waits', unattendedSec: 0 })
    const live = incidentRow(byRule(e, 'Live'), Date.parse(w.generatedAt), 0, cfg.baseUrl)
    expect(live).toMatchObject({ attention: 'none', parkedState: null, parkedUntil: null, parkedSince: null, parkedRef: null, parkedNote: null })
  })

  it('watch_state counts it as parked and in no live count, and says so in its text', () => {
    const e = build()
    const w = e.wall()
    const s = summarizeWall(w, new Map(), cfg.baseUrl)
    expect(s.counts).toEqual({ firing: 2, unattended: 1, acknowledged: 1, silenced: 0, parked: 1, page: 0, warning: 2, info: 0 })
    expect(s.incidents).toHaveLength(3)
    expect(s.text).toContain('1 parked')
  })

  it('the filters: firing is the live ones, unattended never includes a parked one, parked keeps only them, all keeps every incident', () => {
    const e = build()
    const w = e.wall()
    const rows = w.incidents.map((i) => incidentRow(i, Date.parse(w.generatedAt), 0, cfg.baseUrl))
    const rules = (state: Parameters<typeof filterFiring>[2]['state']): string[] => filterFiring(rows, w.incidents, { state }).map((r) => r.title).sort()
    expect(rules('firing')).toEqual(['Acked', 'Live'])
    expect(rules('unattended')).toEqual(['Live'])
    expect(rules('acknowledged')).toEqual(['Acked'])
    expect(rules('parked')).toEqual(['Parked'])
    expect(rules('all')).toEqual(['Acked', 'Live', 'Parked'])
    expect(rules('resolved')).toEqual([])
  })

  it('the incident card says parked and when it ends, inside the card contract', () => {
    const e = build()
    const incident = byRule(e, 'Parked')
    const card = cardOf({ key: incident.key, incident, alerts: [], resolved: null, baseUrl: cfg.baseUrl })
    expect(card).toMatchObject({ state: 'parked', parkedUntil: iso(T0 + 6 * H), severity: 'warning' })
    expect(Object.keys(card ?? {}).every((k) => (CARD_FIELDS as readonly string[]).includes(k))).toBe(true)
    const live = byRule(e, 'Live')
    expect('parkedUntil' in (cardOf({ key: live.key, incident: live, alerts: [], resolved: null, baseUrl: cfg.baseUrl }) ?? {})).toBe(false)
  })
})

// ---- the wall: the layout and the reading order --------------------------------------------------------------------------------------

const RULE = {
  cell: { w: 128, h: 74 },
  cellMaxH: 92.5,
  chromeW: 18,
  dotW: 16,
  okW: 72,
  dotRows: 2,
  maxSpan: 3,
  warning: { cols: 2, rows: 2 },
  page: { rows: 3, rowsAttended: 2, share: 0.5, minCols: 3 },
  head: 40
} satisfies TierRule
const geometry = { gap: 8, firingMin: { w: 160, h: 120 }, quietMin: { w: 120, h: 96 } }
const IDS = ['product', 'reliability', 'infrastructure']
const lay = (items: LayoutItem[], groups: string[] | undefined) => {
  const opt: LayoutOptions = { width: 1152, height: 583, ...geometry, tier: RULE, groups }
  const height = wallHeight(items, opt)
  return layoutWall(items, { ...opt, height })
}
const items = (): LayoutItem[] => [
  { id: 'p-prod', tier: 'page', R: 8, firing: true, group: 'product' },
  { id: 'w-rel', tier: 'warning', R: 4, firing: true, group: 'reliability' },
  { id: 'q-rel', tier: 'quiet', R: 1, firing: true, group: 'reliability' },
  { id: 'k-late', tier: 'quiet', R: 1, firing: true, group: 'product', parkedUntil: T0 + 30 * H },
  { id: 'k-soon', tier: 'quiet', R: 1, firing: true, group: 'infrastructure', parkedUntil: T0 + 2 * H },
  { id: 'node-1', tier: 'quiet', R: 2, firing: false },
  { id: 'node-2', tier: 'quiet', R: 1, firing: false }
]
const isHead = (id: string): boolean => id.startsWith('group:')

describe('the layout: the Parked section follows every section and comes before the healthy cells', () => {
  it('with headings: the groups, then Parked (soonest end first, in no group), then the cells; no section for a group that holds only parked incidents', () => {
    const out = lay(items(), IDS)
    const read = [...out].sort((a, b) => a.y - b.y || a.x - b.x).map((p) => p.id)
    expect(read).toEqual([groupHeadId('product'), 'p-prod', groupHeadId('reliability'), 'w-rel', 'q-rel', groupHeadId(PARKED_GROUP.id), 'k-soon', 'k-late', 'node-1', 'node-2'])
    expect(out.filter((p) => isHead(p.id)).map((p) => p.id)).not.toContain(groupHeadId('infrastructure'))
    const head = out.find((p) => p.id === groupHeadId(PARKED_GROUP.id))
    expect(head).toMatchObject({ x: 0, w: 1152, h: RULE.head })
    const soon = out.find((p) => p.id === 'k-soon')
    const late = out.find((p) => p.id === 'k-late')
    const firstCell = out.find((p) => p.id === 'node-1')
    // the parked tiles sit under their heading, soonest first, and the cells start below the lowest of them
    expect((soon?.y ?? 0) >= (head?.y ?? 0) + RULE.head).toBe(true)
    expect(soon?.x).toBeLessThan(late?.x ?? 0)
    expect((firstCell?.y ?? 0) >= (late?.y ?? 0) + (late?.h ?? 0)).toBe(true)
  })

  it('the group order ignores parked incidents', () => {
    expect(incidentGroupOrder(items(), IDS)).toEqual(['product', 'reliability'])
  })

  it('without headings the parked tiles are one section under everything else, cells included', () => {
    const out = lay(items(), undefined).filter((p) => !isHead(p.id) || p.id === groupHeadId(PARKED_GROUP.id))
    const head = out.find((p) => p.id === groupHeadId(PARKED_GROUP.id))
    expect(head).toBeDefined()
    const lowestLive = Math.max(...out.filter((p) => p.id !== head?.id && !p.id.startsWith('k-')).map((p) => p.y + p.h))
    for (const id of ['k-soon', 'k-late']) expect((out.find((p) => p.id === id)?.y ?? 0) >= lowestLive).toBe(true)
    expect((head?.y ?? 0) >= lowestLive).toBe(true)
  })

  it('a wall with nothing parked has no Parked section, and a parkedUntil of undefined (what the wall passes for a live tile) is the field absent', () => {
    const live = items().filter((i) => i.parkedUntil === undefined)
    const explicit = live.map((i) => ({ ...i, parkedUntil: undefined }))
    expect(lay(explicit, IDS)).toEqual(lay(live, IDS))
    expect(lay(live, IDS).some((p) => p.id === groupHeadId(PARKED_GROUP.id))).toBe(false)
  })

  it('the reserved name: no configured wall group may take the Parked id or label', () => {
    expect(wallGroupProblems([{ id: 'parked', label: 'Waiting', services: ['A'] }]).join(' ')).toContain('reserved')
    expect(wallGroupProblems([{ id: 'waiting', label: 'Parked', services: ['A'] }]).join(' ')).toContain('reserved')
    expect(wallGroupProblems([{ id: 'waiting', label: 'Waiting', services: ['A'] }])).toEqual([])
  })
})

describe('the reading order of the wall', () => {
  const tile = (id: string, tier: Tile['tier'], over: Partial<Tile> = {}): Tile => ({ id, tier, R: 5, kind: 'incident', wallGroup: { id: 'product', label: 'Product', order: 0 }, ...over }) as Tile
  const cell = (id: string): Tile => ({ id, tier: 'quiet', R: 1, kind: 'service' })
  const read = (entries: Entry[]): string[] => entries.map((e) => (e.kind === 'head' ? `# ${e.group.label}` : e.kind === 'cells' ? '## cells' : e.tile.id))
  const defs = [{ id: 'product', label: 'Product', order: 0 }]
  const order = [tile('i:live', 'page'), tile('i:silenced', 'quiet'), tile('i:late', 'quiet', { parkedUntil: T0 + 9 * H }), tile('i:soon', 'quiet', { parkedUntil: T0 + H }), cell('s:a')]

  it('with headings: the sections, then a Parked heading and its tiles soonest first, then the cells, and the group heading counts no parked incident', () => {
    const entries = wallEntries(order, ['product'], defs)
    expect(read(entries)).toEqual(['# Product', 'i:live', 'i:silenced', '# Parked', 'i:soon', 'i:late', '## cells', 's:a'])
    const product = entries[0]
    expect(product.kind === 'head' && product.counts.firing).toBe(2)
    const parked = entries.find((e) => e.kind === 'head' && e.group.id === PARKED_GROUP.id)
    expect(parked?.kind === 'head' && groupCountText(parked.counts)).toBe('2 waiting')
  })

  it('without headings: the tiles as given, the parked ones under their own heading at the end; on a phone before the healthy cells', () => {
    expect(read(flatEntries(order, false))).toEqual(['i:live', 'i:silenced', 's:a', '# Parked', 'i:soon', 'i:late'])
    expect(read(flatEntries(order, true))).toEqual(['i:live', 'i:silenced', '# Parked', 'i:soon', 'i:late', 's:a'])
    expect(read(flatEntries(order.filter((t) => t.parkedUntil === undefined), true))).toEqual(['i:live', 'i:silenced', 's:a'])
  })

  it('an ordinary group heading still says only what fires', () => {
    expect(groupCountText({ firing: 3, acknowledged: 1, silenced: 1 })).toBe('3 firing, 1 acknowledged, 1 silenced')
  })
})

// ---- the words ------------------------------------------------------------------------------------------------------------------

describe('the words on a tile and in a sheet', () => {
  const park = { state: 'fixed_undeployed' as const, until: iso(T0 + 20 * H), since: iso(T0 - 2 * H), ref: 'SB-4412', note: 'Fix merged, waits for the edge deploy' }

  it('the tile says when the park ends, then why and the ticket', () => {
    const p = parkedParts(park)
    expect(p.who).toMatch(/^Parked until [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}$/)
    expect(p.when).toBe('Fix not deployed, SB-4412')
    expect(parkedParts({ ...park, state: 'deferred', ref: null }).when).toBe('Deferred')
    expect(parkedLine(park)).toBe(`${p.who}. ${p.when}`)
  })

  it('the sheet says the reason, the ticket, the sender\'s line, when it began and what happens at the end', () => {
    const d = parkedDetail(park)
    expect(d).toContain('Reason: fix not deployed.')
    expect(d).toContain('Ticket SB-4412.')
    expect(d).toContain('Fix merged, waits for the edge deploy.')
    expect(d).toMatch(/Parked since [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}\./)
    expect(d).toContain('comes back unattended when the park ends')
    expect(parkedDetail({ ...park, since: null, ref: null, note: null })).toBe('Reason: fix not deployed. It is not paged while it is parked, and comes back unattended when the park ends.')
  })

  it('the status line counts the parked beside the firing, and leaves them out at zero', () => {
    expect(statusCounts({ firing: 4, acknowledged: 1, parked: 2 })).toEqual({ firing: '4 firing', acknowledged: '1 acknowledged', parked: '2 parked' })
    expect(statusCounts({ firing: 4, acknowledged: 1, parked: 0 }).parked).toBeUndefined()
    expect(statusCounts({ firing: 4 }).parked).toBeUndefined()
  })

  it('the big number of a parked incident is the time the park has left', () => {
    const s = incidentState({ severity: 'warning', instances: 1, startsAtMs: T0 - H, nowMs: T0, annotations: [ann(T0 + 3 * H)] })
    const h = heroOf({ state: s, startsAt: iso(T0 - H), ackedAt: null }, T0)
    expect(h.label).toBe('until the park ends')
    expect(h.value.replace(/\u00a0/g, ' ')).toBe('3 h')
  })

  it('no copy of the feature holds an em dash or a middle dot', () => {
    for (const f of ['src/web/lib/ack.ts', 'src/web/lib/format.ts', 'src/shared/incident.ts', 'src/server/mcp/shape.ts', 'docs/design.md']) {
      const text = readFileSync(f, 'utf8')
      // the park's own lines only: the files hold older prose that is not under test
      const parkLines = text.split('\n').filter((l) => /\bpark/i.test(l))
      for (const l of parkLines) expect(l).not.toMatch(/[\u2014\u00b7]/)
    }
  })
})

// ---- assistive technology: name, glyph, heading, section ---------------------------------------------------------------------------------

describe('the markup: a parked tile is named, drawn and headed for assistive technology', () => {
  const render = (level: 'h2' | 'h3'): string => {
    const e = fresh()
    e.ingest(push(sweepAlert('CiRed', ann(T0 + 20 * H, 'fixed_undeployed', { parked_since: iso(T0 - 2 * H), parked_ref: 'SB-4412', parked_note: 'Fix merged, waits for the deploy' }))))
    const i = byRule(e, 'CiRed')
    const tile = { id: `i:${i.key}`, tier: i.state.tier, R: i.state.R, kind: 'incident' as const, incident: i, parkedUntil: Date.parse(i.state.park?.until ?? '') }
    return renderToStaticMarkup(createElement(IncidentTile, { tile, i, size: 'compact', style: undefined, nowMs: T0, kinds: { 'sweep': 'webhook' }, titleStyle: 'title', level, active: false, onFocus: () => undefined, onAck: () => undefined }))
  }

  it('the link\'s accessible name says that it is parked, until when and why, and the state is on the element', () => {
    const html = render('h3')
    expect(html).toContain('data-attention="parked"')
    expect(html).toMatch(/aria-label="[^"]*Parked until [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}\. Fix not deployed, SB-4412"/)
    // the whole park, with the sender's line, is the hover text of the two-line summary
    expect(html).toMatch(/<p class="tile__ack" title="[^"]*Reason: fix not deployed\.[^"]*Fix merged, waits for the deploy/)
  })

  it('the pause is decoration (the words carry the state): aria-hidden, and neither the severity glyph nor the acknowledged check', () => {
    const html = render('h3')
    const svgs = [...html.matchAll(/<svg[^>]*>/g)].map((m) => m[0])
    const pause = svgs.filter((t) => t.includes('lucide-circle-pause'))
    expect(pause).toHaveLength(1)
    expect(pause[0]).toContain('aria-hidden="true"')
    expect(html).not.toContain('lucide-circle-check')
    expect(html).not.toContain('lucide-triangle-alert')
    expect(html).not.toContain('lucide-octagon-alert')
  })

  it('the tile is an h3 under the Parked h2 on a wall with sections and an h2 where the wall has no headings, so the outline never skips a level', () => {
    expect(render('h3')).toMatch(/<h3 class="tile__title">/)
    expect(render('h2')).toMatch(/<h2 class="tile__title">/)
    const src = readFileSync('src/web/components/Wall.tsx', 'utf8')
    // a parked tile is always under its Parked heading (an h2), so it is always an h3, whatever the Group toggle says
    expect(src).toContain("level={grouped || t.parkedUntil !== undefined ? 'h3' : 'h2'}")
    const head = renderToStaticMarkup(createElement(GroupHead, { group: { id: PARKED_GROUP.id, label: PARKED_GROUP.label, order: 99 }, counts: { firing: 0, acknowledged: 0, silenced: 0, parked: 2 }, style: undefined }))
    expect(head).toMatch(/<h2 class="wall__group-title">/)
    expect(head).toContain('Parked</span> <span class="wall__group-count">2 waiting</span>')
  })

  it('reading and tab order are the order of the section: the Parked heading and its tiles, soonest first, after every group and before the cells, in every mode', () => {
    const tile = (id: string, over: Partial<Tile> = {}): Tile => ({ id, tier: 'quiet', R: 1, kind: 'incident', ...over }) as Tile
    const cell = (id: string): Tile => ({ id, tier: 'quiet', R: 1, kind: 'service' })
    const list = [tile('i:late', { parkedUntil: T0 + 9 * H }), tile('i:live', { tier: 'warning' }), cell('s:a'), tile('i:soon', { parkedUntil: T0 + H })]
    const ids = (entries: Entry[]): string[] => entries.map((e) => (e.kind === 'head' ? `h:${e.group.id}` : e.kind === 'cells' ? 'cells' : e.tile.id))
    expect(ids(flatEntries(list, false))).toEqual(['i:live', 's:a', 'h:parked', 'i:soon', 'i:late'])
    expect(ids(flatEntries([list[1], list[2], list[0], list[3]], true))).toEqual(['i:live', 'h:parked', 'i:soon', 'i:late', 's:a'])
  })
})

// ---- the look: tokens, markup and styles -----------------------------------------------------------------------------------------------

/** WCAG 2.2 relative luminance and contrast, written out so the proof does not depend on a library. */
const lum = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('the look: one new hue, in both schemes, that holds contrast', () => {
  const tokens = readFileSync('src/web/styles/tokens.css', 'utf8')
  const light = tokens.slice(tokens.indexOf(":root[data-scheme='light']"))
  const dark = tokens.slice(0, tokens.indexOf(":root[data-scheme='light']"))
  const hexOf = (css: string, name: string): string => {
    const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css)
    if (!m) throw new Error(`${name} not found`)
    return m[1]
  }

  it('--color-parked is set for dark and for light, and is neither the severity red nor the severity amber', () => {
    expect(hexOf(dark, '--color-parked')).toBe('#7f9cc9')
    expect(hexOf(light, '--color-parked')).toBe('#43669e')
    for (const css of [dark, light]) {
      expect(hexOf(css, '--color-parked')).not.toBe(hexOf(css, '--color-danger'))
      expect(hexOf(css, '--color-parked')).not.toBe(hexOf(css, '--color-warn'))
    }
  })

  it('its text clears 4.5:1 on the raised surface and the canvas in both schemes, which also clears 3:1 for its outline and glyph', () => {
    for (const [css, name] of [[dark, 'dark'], [light, 'light']] as const) {
      const parked = hexOf(css, '--color-parked')
      expect(contrast(parked, hexOf(css, '--color-raised')), `${name} on raised`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(parked, hexOf(css, '--color-bg')), `${name} on canvas`).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast('#7f9cc9', '#1a1a1c')).toBeCloseTo(6.21, 1)
    expect(contrast('#43669e', '#f0ede5')).toBeCloseTo(4.94, 1)
  })

  const css = readFileSync('src/web/styles/wall.css', 'utf8')
  const block = (selector: string): string => {
    const at = css.indexOf(selector)
    if (at < 0) throw new Error(`${selector} not found`)
    return css.slice(at, css.indexOf('}', at))
  }

  it('the parked tile is the raised surface with one hairline in the parked hue and a glyph in it: no amber, no red, no hex, no glow', () => {
    const tile = block(".tile[data-attention='parked'] {")
    expect(tile).toMatch(/border: var\(--size-hairline\) solid var\(--color-parked\);/)
    expect(tile).toMatch(/background: var\(--color-raised\);/)
    const all = css.split('\n').filter((l) => l.includes("[data-attention='parked']") || l.includes("data-group='parked'") || l.includes("data-tone='parked'"))
    expect(all.length).toBeGreaterThan(3)
    const parkedCss = [tile, block(".tile[data-attention='parked'] .glyph,"), block(".tile[data-attention='parked'] .tile__ack-when {"), block(".chip[data-tone='parked'] {")].join('\n')
    expect(parkedCss).not.toMatch(/--color-warn|--color-danger|#[0-9a-fA-F]{3,8}\b|box-shadow|blur|gradient/)
    expect(parkedCss).toContain('var(--color-parked)')
  })

  it('reads differently from an acknowledged tile (severity outline) and from a silenced one (dotted)', () => {
    expect(block(".tile[data-attention='parked'] {")).not.toMatch(/dotted|--edge-page|--edge-warning/)
    expect(block(".tile[data-attention='silenced'] {")).toMatch(/dotted/)
  })

  it('the markup draws the pause glyph and the park lines, and keeps the acknowledged glyph as it was', () => {
    const wall = readFileSync('src/web/components/Wall.tsx', 'utf8')
    expect(wall).toContain('<ParkedGlyph />')
    expect(wall).toContain('<Glyph severity={acked ? null : i.severity} />')
    expect(wall).toContain('parkedParts(park)')
    const ui = readFileSync('src/web/components/ui.tsx', 'utf8')
    expect(ui).toContain('CirclePause')
  })

  it('adds no animation and no new radius: the parked rules declare neither', () => {
    const parkedRules = css.split('}').filter((r) => /data-attention='parked'|data-group='parked'|data-tone='parked'/.test(r))
    expect(parkedRules.length).toBeGreaterThan(3)
    for (const r of parkedRules) expect(r).not.toMatch(/animation|@keyframes|transition|border-radius/)
  })
})
