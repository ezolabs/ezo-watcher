import { describe, expect, it } from 'vitest'
import { MAX_ATTEMPTS, MAX_RETRY_AGE_MS, logKey, planAbandons } from '../src/server/notify/plan.ts'
import type { LogRow } from '../src/server/notify/types.ts'
import { MIN, MemStore, SEC, T0, aKey, failing, fakeChannel, harness, iso, resolvedView, route, view } from './notify-helpers.ts'

const pending = (over: Partial<LogRow> & { key: string }): LogRow => ({
  sentAt: 0,
  digest: '',
  ok: false,
  attempts: 1,
  nextAttemptAt: T0 + 5 * SEC,
  firstFailedAt: T0,
  ...over
})

describe('bounded retries: attempts', () => {
  it('stops after 8 attempts, records why, and says nothing more until the repeat gate', async () => {
    expect(MAX_ATTEMPTS).toBe(8)
    const ntfy = fakeChannel('ntfy', failing('500'))
    const h = harness([route()], { channels: [ntfy] })
    let t = T0
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      await h.tickAt(t, [view()])
      expect(ntfy.sent).toHaveLength(i)
      const row = h.store.getLog(aKey())!
      if (i < MAX_ATTEMPTS) {
        expect(row).toMatchObject({ attempts: i, firstFailedAt: T0 })
        expect(row.closed).toBeUndefined()
        t = row.nextAttemptAt as number
      }
    }
    // the 8th failure was the last allowed one
    expect(h.store.getLog(aKey())).toMatchObject({ attempts: 8, ok: false, nextAttemptAt: null, sentAt: t, closed: 'abandoned: max attempts' })
    expect(h.store.statuses()).toEqual([...Array<string>(8).fill('500'), 'abandoned: max attempts'])
    expect(h.store.results.at(-1)).toMatchObject({ kind: 'alert', ok: false, channelId: 'ntfy', routeId: 'r1', incidentKey: 'edge|EdgeDead', latencyMs: 0 })
    expect(h.store.listPending()).toEqual([])

    // The old schedule would have retried every 300 s for ever. Now nothing goes out until the repeat interval.
    for (let s = 5; s < 1800; s += 295) await h.tickAt(t + s * SEC, [view()])
    expect(ntfy.sent).toHaveLength(8)
    await h.tickAt(t + 1800 * SEC, [view()])
    expect(ntfy.sent).toHaveLength(9)
    // ... and that is a fresh round: one failure, not nine
    expect(h.store.getLog(aKey())).toMatchObject({ attempts: 1, firstFailedAt: t + 1800 * SEC })
    expect(h.store.getLog(aKey())?.closed).toBeUndefined()
  })

  it('starts a fresh round for an alert that changed, after group_interval, not at once', async () => {
    const ntfy = fakeChannel('ntfy', failing('500'))
    const h = harness([route()], { channels: [ntfy] })
    let t = T0
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      await h.tickAt(t, [view()])
      t = h.store.getLog(aKey())?.nextAttemptAt ?? t
    }
    const given = h.store.getLog(aKey())!.sentAt
    const two = view({ instances: [...view().instances, { fingerprint: 'fp2', name: 'web-2', value: '0', startsAt: iso(given) }] })
    await h.tickAt(given + 119 * SEC, [two])
    expect(ntfy.sent).toHaveLength(8)
    await h.tickAt(given + 120 * SEC, [two])
    expect(ntfy.sent).toHaveLength(9)
  })

  it('ends a ladder as one unit: both rungs give up together', async () => {
    const ntfy = fakeChannel('ntfy', failing('500'))
    const webpush = fakeChannel('webpush', failing('no subscribers'))
    const h = harness([route({ mode: 'ladder', receivers: ['ntfy', 'webpush'] })], { channels: [ntfy, webpush] })
    let t = T0
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      await h.tickAt(t, [view()])
      t = Math.max(h.store.getLog(aKey('ntfy'))?.nextAttemptAt ?? 0, h.store.getLog(aKey('webpush'))?.nextAttemptAt ?? 0)
    }
    expect(h.store.getLog(aKey('ntfy'))).toMatchObject({ closed: 'abandoned: max attempts', nextAttemptAt: null })
    expect(h.store.getLog(aKey('webpush'))).toMatchObject({ closed: 'abandoned: max attempts', nextAttemptAt: null })
    expect(h.store.statuses('ntfy').filter((s) => s.startsWith('abandoned'))).toEqual(['abandoned: max attempts'])
    expect(h.store.statuses('webpush').filter((s) => s.startsWith('abandoned'))).toEqual(['abandoned: max attempts'])
    expect(h.store.listPending()).toEqual([])
  })
})

describe('bounded retries: age', () => {
  it('stops 30 minutes after the first failure even with attempts left', async () => {
    expect(MAX_RETRY_AGE_MS).toBe(30 * MIN)
    const ntfy = fakeChannel('ntfy', failing('500'))
    const h = harness([route()], { channels: [ntfy] })
    await h.tickAt(T0, [view()])
    // a stalled notifier: the next tick is 20 minutes late
    await h.tickAt(T0 + 20 * MIN, [view()])
    expect(ntfy.sent).toHaveLength(2)
    expect(h.store.getLog(aKey())).toMatchObject({ attempts: 2, firstFailedAt: T0 })
    // one millisecond short of 30 minutes: still owed
    await h.tickAt(T0 + 30 * MIN - 1, [view()])
    expect(ntfy.sent).toHaveLength(3)
    expect(h.store.getLog(aKey())?.closed).toBeUndefined()
    // 30 minutes: ended before it can run again
    await h.tickAt(T0 + 30 * MIN + 10 * SEC, [view()])
    expect(ntfy.sent).toHaveLength(3)
    expect(h.store.getLog(aKey())).toMatchObject({ closed: 'abandoned: max age', nextAttemptAt: null })
    expect(h.store.statuses().at(-1)).toBe('abandoned: max age')
    expect(h.store.listPending()).toEqual([])
  })

  it('ends a retry that ran out of time while it was waiting on a circuit that makes no tries', async () => {
    const ntfy = fakeChannel('ntfy', failing('429', { retryAfterMs: 3600_000 }))
    const h = harness([route()], { channels: [ntfy] })
    await h.tickAt(T0, [view()])
    // a 429 with an hour of Retry-After opens the circuit for an hour: the next try waits for it, not for the 5 s backoff
    expect(h.store.getLog(aKey())).toMatchObject({ attempts: 1, nextAttemptAt: T0 + 60 * MIN })
    await h.tickAt(T0 + 29 * MIN, [view()])
    expect(h.store.getLog(aKey())?.closed).toBeUndefined()
    await h.tickAt(T0 + 30 * MIN, [view()])
    expect(h.store.getLog(aKey())?.closed).toBe('abandoned: max age')
    expect(ntfy.sent).toHaveLength(1)
  })
})

describe('retries that are no longer owed are dropped before they run', () => {
  const failingRoute = () => route({ sendResolved: true })

  it('a resolved notice whose incident is firing again', async () => {
    const ntfy = fakeChannel('ntfy', failing('500'))
    const h = harness([failingRoute()], { channels: [ntfy] })
    const rv = resolvedView()
    const resolvedKey = aKey('ntfy', 'r1', 'resolved', `${rv.key}@${rv.resolvedAt}`)
    await h.tickAt(T0 + 41 * MIN, [], [rv])
    expect(ntfy.sent.map((m) => m.kind)).toEqual(['resolved'])
    expect(h.store.getLog(resolvedKey)).toMatchObject({ attempts: 1 })
    // it fires again before the retry is due
    const rows = await h.tickAt(T0 + 41 * MIN + 5 * SEC, [view({ firstSeen: iso(T0 + 41 * MIN) })], [])
    expect(ntfy.sent.filter((m) => m.kind === 'resolved')).toHaveLength(1)
    expect(h.store.getLog(resolvedKey)).toMatchObject({ closed: 'abandoned: incident no longer resolved', nextAttemptAt: null })
    expect(rows[0]).toMatchObject({ kind: 'resolved', status: 'abandoned: incident no longer resolved', ok: false, incidentKey: 'edge|EdgeDead', channelId: 'ntfy' })
    // never again for that resolution, however long it stays settled
    await h.tickAt(T0 + 90 * MIN, [], [rv])
    expect(ntfy.sent.filter((m) => m.kind === 'resolved')).toHaveLength(1)
  })

  it('a resolved notice that left the two-hour resolved window', async () => {
    const ntfy = fakeChannel('ntfy', failing('500'))
    const h = harness([failingRoute()], { channels: [ntfy] })
    const rv = resolvedView()
    await h.tickAt(T0 + 41 * MIN, [], [rv])
    await h.tickAt(T0 + 41 * MIN + 5 * SEC, [], [])
    expect(ntfy.sent).toHaveLength(1)
    expect(h.store.statuses().at(-1)).toBe('abandoned: resolved notice expired')
  })

  it('an alert whose incident resolved', async () => {
    const ntfy = fakeChannel('ntfy', failing('500'))
    const h = harness([route()], { channels: [ntfy] })
    await h.tickAt(T0, [view()])
    expect(ntfy.sent).toHaveLength(1)
    const rows = await h.tickAt(T0 + 5 * SEC, [], [])
    expect(ntfy.sent).toHaveLength(1)
    expect(rows).toEqual([
      { at: T0 + 5 * SEC, incidentKey: 'edge|EdgeDead', routeId: 'r1', channelId: 'ntfy', kind: 'alert', ok: false, status: 'abandoned: incident resolved', latencyMs: 0 }
    ])
    expect(h.store.listPending()).toEqual([])
  })

  it('an alert whose incident was acknowledged, and sends at once when the acknowledgement is taken off', async () => {
    const ntfy = fakeChannel('ntfy', failing('500'))
    const h = harness([route()], { channels: [ntfy] })
    await h.tickAt(T0, [view()])
    await h.tickAt(T0 + 5 * SEC, [view({ attention: 'acked' })])
    expect(ntfy.sent).toHaveLength(1)
    expect(h.store.statuses().at(-1)).toBe('abandoned: incident acknowledged')
    expect(h.store.listPending()).toEqual([])
    await h.tickAt(T0 + 60 * SEC, [view({ attention: 'acked' })])
    expect(ntfy.sent).toHaveLength(1)
    // back to unattended: the alert was never delivered, so it is owed now, as a new round of retries
    await h.tickAt(T0 + 90 * SEC, [view()])
    expect(ntfy.sent).toHaveLength(2)
    expect(h.store.getLog(aKey())).toMatchObject({ attempts: 1, firstFailedAt: T0 + 90 * SEC })
    expect(h.store.getLog(aKey())?.closed).toBeUndefined()
  })

  it('says silenced and parked in their own words', async () => {
    for (const [attention, words] of [
      ['silenced', 'abandoned: incident silenced'],
      ['parked', 'abandoned: incident parked']
    ] as const) {
      const ntfy = fakeChannel('ntfy', failing('500'))
      const h = harness([route()], { channels: [ntfy] })
      await h.tickAt(T0, [view()])
      await h.tickAt(T0 + 5 * SEC, [view({ attention })])
      expect(h.store.statuses().at(-1)).toBe(words)
    }
  })

  it('an escalation whose incident was acknowledged', async () => {
    const sms = fakeChannel('sms', failing('500'))
    const h = harness([route({ escalate: [{ afterSec: 600, receivers: ['sms'] }] })], { channels: [fakeChannel('ntfy'), sms] })
    await h.tickAt(T0 + 600 * SEC, [view({ unattendedSec: 600 })])
    expect(sms.sent).toHaveLength(1)
    await h.tickAt(T0 + 605 * SEC, [view({ unattendedSec: 605, attention: 'acked' })])
    expect(sms.sent).toHaveLength(1)
    expect(h.store.results.at(-1)).toMatchObject({ kind: 'escalation', channelId: 'sms', status: 'abandoned: incident acknowledged' })
  })

  it('a flapping notice whose incident stopped flapping, and an alert whose incident started', async () => {
    const ntfy = fakeChannel('ntfy', failing('500'))
    const h = harness([route()], { channels: [ntfy] })
    await h.tickAt(T0, [view({ flapping: true })])
    expect(ntfy.sent.map((m) => m.kind)).toEqual(['flapping'])
    await h.tickAt(T0 + 5 * SEC, [view()])
    expect(h.store.results.find((r) => r.status.startsWith('abandoned'))).toMatchObject({ kind: 'flapping', status: 'abandoned: incident no longer flapping' })

    const h2 = harness([route()], { channels: [fakeChannel('ntfy', failing('500'))] })
    await h2.tickAt(T0, [view()])
    await h2.tickAt(T0 + 5 * SEC, [view({ flapping: true })])
    expect(h2.store.results.find((r) => r.status.startsWith('abandoned'))).toMatchObject({ kind: 'alert', status: 'abandoned: incident flapping' })
  })

  it('a page whose incident dropped to a warning is another route\'s now: the page route\'s retry is not owed', async () => {
    const ntfy = fakeChannel('ntfy', failing('500'))
    const pageOnly = route({ match: { severity: ['page'] } })
    const h = harness([pageOnly], { channels: [ntfy] })
    await h.tickAt(T0, [view()])
    expect(h.store.listPending()).toHaveLength(1)
    await h.tickAt(T0 + 5 * SEC, [view({ severity: 'warning' })])
    expect(ntfy.sent).toHaveLength(1)
    expect(h.store.statuses().at(-1)).toBe('abandoned: route no longer matches')
    expect(h.store.listPending()).toEqual([])
  })

  it('a retry whose incident moved on says so, not that it ran out of attempts', async () => {
    const store = new MemStore()
    store.putLog(pending({ key: aKey(), attempts: 12 }))
    const h = harness([route()], { channels: [fakeChannel('ntfy', failing('500'))], store })
    await h.tickAt(T0 + 10 * SEC, [], [])
    expect(store.getLog(aKey())?.closed).toBe('abandoned: incident resolved')
  })

  it('a failed repeat of an alert that had been delivered goes back to being that delivered alert', async () => {
    const ntfy = fakeChannel('ntfy', {}, failing('500'))
    const h = harness([route()], { channels: [ntfy] })
    await h.tickAt(T0, [view()])
    expect(h.store.getLog(aKey())).toMatchObject({ ok: true, sentAt: T0 })
    await h.tickAt(T0 + 1800 * SEC, [view()])
    expect(h.store.getLog(aKey())).toMatchObject({ ok: true, attempts: 1 })
    await h.tickAt(T0 + 1805 * SEC, [view({ attention: 'acked' })])
    expect(h.store.getLog(aKey())).toEqual({ key: aKey(), sentAt: T0, digest: h.store.getLog(aKey())?.digest, ok: true, attempts: 0, nextAttemptAt: null })
    expect(h.store.statuses().at(-1)).toBe('abandoned: incident acknowledged')
  })
})

describe('the stuck queue of 2026-10-20', () => {
  it('ends in one tick every row that is over, and sends nothing for any of them', async () => {
    const store = new MemStore()
    const live = view({ key: 'API router|live', service: 'API router', rule: 'live' })
    const rv = resolvedView({ key: 'API router|spike', service: 'API router', rule: 'spike' })
    // Rows from before the caps existed: 5 to 22 attempts, no first-failure time, for an incident that is still firing, one that
    // resolved long ago, and a resolved notice that is still inside its window.
    for (let i = 0; i < 18; i++) {
      for (const receiver of ['ntfy', 'webpush']) {
        const incident = i === 0 ? live.key : `API router|gone-${i}`
        store.putLog({ key: logKey(incident, 'r1', receiver, 'alert'), sentAt: 0, digest: '', ok: false, attempts: 5 + i, nextAttemptAt: T0 + 100 * SEC })
      }
    }
    store.putLog({ key: logKey(`${rv.key}@${rv.resolvedAt}`, 'r1', 'ntfy', 'resolved'), sentAt: 0, digest: '', ok: false, attempts: 22, nextAttemptAt: T0 + 100 * SEC })
    expect(store.listPending()).toHaveLength(37)
    const channels = [fakeChannel('ntfy', failing('500')), fakeChannel('webpush', failing('500'))]
    const h = harness([route({ mode: 'ladder', receivers: ['ntfy', 'webpush'], sendResolved: true })], { channels, store })
    const rows = await h.tickAt(T0 + 10 * SEC, [live], [rv])
    const count = (status: string) => rows.filter((r) => r.status === status).length
    expect(count('abandoned: incident resolved')).toBe(34)
    // the resolved notice has 22 attempts and no age: over by count
    expect(count('abandoned: max attempts')).toBe(1)
    expect(rows).toHaveLength(35)
    // what is left is the live incident's own two rows, at 5 attempts: inside the caps, waiting for their backoff, so nothing is sent yet
    expect(store.listPending().map((r) => [r.key, r.attempts])).toEqual([
      [logKey(live.key, 'r1', 'ntfy', 'alert'), 5],
      [logKey(live.key, 'r1', 'webpush', 'alert'), 5]
    ])
    expect(channels.flatMap((c) => (c as ReturnType<typeof fakeChannel>).sent)).toEqual([])
  })
})

describe('planAbandons', () => {
  const input = (rows: LogRow[], extra: Partial<Parameters<typeof planAbandons>[0]> = {}) => ({
    pending: rows,
    routes: [route()],
    views: [view()],
    resolved: [],
    nowMs: T0 + 100 * SEC,
    getHeld: () => [],
    ...extra
  })

  it('leaves a retry that is owed and inside its caps', () => {
    expect(planAbandons(input([pending({ key: aKey(), attempts: 7 })]))).toEqual([])
  })

  it('ends a retry whose route is gone', () => {
    const [a] = planAbandons(input([pending({ key: aKey('ntfy', 'old-route') })]))
    expect(a.reason).toBe('route no longer configured')
  })

  it('ends a digest that nothing is held for, and gives one that ran out of tries the route repeat interval before another round', () => {
    const digestKey = logKey('digest:r1', 'r1', 'ntfy', 'digest')
    const [none] = planAbandons(input([pending({ key: digestKey })]))
    expect(none).toMatchObject({ reason: 'nothing held', kind: 'digest', incidentKey: 'digest:r1' })
    const [spent] = planAbandons(input([pending({ key: digestKey, attempts: 8 })], { getHeld: () => ['edge|EdgeDead'] }))
    expect(spent.row).toMatchObject({ closed: 'abandoned: max attempts', sentAt: T0 + 100 * SEC, nextAttemptAt: T0 + 100 * SEC + 1800 * SEC })
  })

  it('writes the current digest into a row that ran out of tries, so the repeat gate runs from it', () => {
    const [a] = planAbandons(input([pending({ key: aKey(), attempts: 8 })]))
    expect(a.row).toMatchObject({ ok: false, sentAt: T0 + 100 * SEC, closed: 'abandoned: max attempts', nextAttemptAt: null })
    expect(a.row.digest).not.toBe('')
  })
})
