import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ChannelConfig, QuietHoursConfig, RouteConfig } from '../src/server/config.ts'
import { createChannel } from '../src/server/notify/channels/index.ts'
import { createNotifier } from '../src/server/notify/notifier.ts'
import type { LadderTiming } from '../src/server/notify/notifier.ts'
import { fingerprintDigest, logKey } from '../src/server/notify/plan.ts'
import { verifyAckSignature } from '../src/server/notify/message.ts'
import type { Channel, LogRow, Message, NotifyStore, NotifyView, ResolvedView, ResultRow, SendResult } from '../src/server/notify/types.ts'

const T0 = Date.parse('2026-10-14T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const SEC = 1000
const ACK_SECRET = `canary-ack-${'7c1e'}`

function view(over: Partial<NotifyView> = {}): NotifyView {
  return {
    key: 'edge|EdgeDead',
    service: 'edge',
    rule: 'EdgeDead',
    summary: 'API edge dead',
    severity: 'page',
    severityLabel: 'critical',
    origin: 'grafana',
    labels: {},
    instances: [{ fingerprint: 'fp1', name: 'web-1', value: '0', startsAt: iso(T0) }],
    startsAt: iso(T0),
    firstSeen: iso(T0),
    attention: 'none',
    unattendedSec: 0,
    flapping: false,
    links: {},
    ...over
  }
}

function resolvedView(over: Partial<ResolvedView> = {}): ResolvedView {
  return {
    key: 'edge|EdgeDead',
    service: 'edge',
    rule: 'EdgeDead',
    summary: 'API edge dead',
    severity: 'page',
    origin: 'grafana',
    labels: {},
    startsAt: iso(T0),
    resolvedAt: iso(T0 + 1_800_000),
    durationSec: 1800,
    stableForSec: 600,
    wasNotified: true,
    ...over
  }
}

function route(over: Partial<RouteConfig> = {}): RouteConfig {
  return {
    id: 'r1',
    match: {},
    receivers: ['ntfy'],
    mode: 'all',
    groupWaitSec: 30,
    groupIntervalSec: 300,
    repeatIntervalSec: 3600,
    ...over
  }
}

class MemStore implements NotifyStore {
  logs = new Map<string, LogRow>()
  results: ResultRow[] = []
  held = new Map<string, string[]>()
  getLog(key: string) {
    return this.logs.get(key) ?? null
  }
  putLog(row: LogRow) {
    this.logs.set(row.key, row)
  }
  addResult(row: ResultRow) {
    this.results.push(row)
  }
  getHeld(routeId: string) {
    return this.held.get(routeId) ?? []
  }
  putHeld(routeId: string, keys: string[]) {
    this.held.set(routeId, keys)
  }
}

interface FakeChannel extends Channel {
  sent: Message[]
  ok: boolean
}

function fakeChannel(id: string, ok = true, behaviour?: (msg: Message) => Promise<SendResult>): FakeChannel {
  const ch: FakeChannel = {
    id,
    type: 'fake',
    sent: [],
    ok,
    async send(msg) {
      ch.sent.push(msg)
      if (behaviour) return behaviour(msg)
      return ch.ok ? { ok: true, status: '200', latencyMs: 4 } : { ok: false, status: '500', latencyMs: 4 }
    }
  }
  return ch
}

interface Options {
  log?: (line: string) => void
  channels?: FakeChannel[]
  quiet?: QuietHoursConfig | null
  timing?: Partial<LadderTiming>
  start?: number
}

function harness(routes: RouteConfig[], opts: Options = {}) {
  const clock = { t: opts.start ?? T0 }
  const channels = opts.channels ?? [fakeChannel('ntfy'), fakeChannel('sms'), fakeChannel('zulip')]
  const store = new MemStore()
  const sleeps: number[] = []
  const notifier = createNotifier({
    routes,
    channels: new Map(channels.map((c) => [c.id, c])),
    quiet: opts.quiet ?? null,
    store,
    now: () => clock.t,
    baseUrl: 'https://watch.example',
    ackSecret: ACK_SECRET,
    log: opts.log,
    timing: {
      sleep: async (ms) => {
        sleeps.push(ms)
        clock.t += ms
      },
      ...opts.timing
    }
  })
  const by = (id: string) => channels.find((c) => c.id === id) as FakeChannel
  const tickAt = (t: number, views: NotifyView[], resolved: ResolvedView[] = []) => {
    clock.t = t
    return notifier.tick(views, resolved)
  }
  return { clock, store, notifier, by, sleeps, tickAt }
}

const aKey = (receiver = 'ntfy', routeId = 'r1', stage = 'alert', incident = 'edge|EdgeDead') => logKey(incident, routeId, receiver, stage)

describe('alert cadence (group_wait, group_interval, repeat_interval)', () => {
  it('sends the first alert only after group_wait and logs it', async () => {
    const h = harness([route()])
    expect(await h.tickAt(T0 + 29 * SEC, [view()])).toEqual([])
    expect(h.by('ntfy').sent).toHaveLength(0)
    const rows = await h.tickAt(T0 + 30 * SEC, [view()])
    expect(h.by('ntfy').sent).toHaveLength(1)
    expect(rows).toEqual([
      { at: T0 + 30 * SEC, incidentKey: 'edge|EdgeDead', routeId: 'r1', channelId: 'ntfy', kind: 'alert', ok: true, status: '200', latencyMs: 4 }
    ])
    expect(h.store.results).toEqual(rows)
    expect(h.store.getLog(aKey())).toEqual({
      key: 'edge|EdgeDead|r1|ntfy|alert',
      sentAt: T0 + 30 * SEC,
      digest: fingerprintDigest(view()),
      ok: true,
      attempts: 0,
      nextAttemptAt: null
    })
  })

  it('does not repeat inside the repeat interval across 20 replays, and repeats exactly at it', async () => {
    const h = harness([route()])
    await h.tickAt(T0 + 30 * SEC, [view()])
    for (let i = 1; i <= 20; i++) await h.tickAt(T0 + 30 * SEC + i * 10 * SEC, [view()])
    expect(h.by('ntfy').sent).toHaveLength(1)
    await h.tickAt(T0 + 30 * SEC + 3600 * SEC - 1, [view()])
    expect(h.by('ntfy').sent).toHaveLength(1)
    await h.tickAt(T0 + 30 * SEC + 3600 * SEC, [view()])
    expect(h.by('ntfy').sent).toHaveLength(2)
    await h.tickAt(T0 + 30 * SEC + 3600 * SEC + 10 * SEC, [view()])
    expect(h.by('ntfy').sent).toHaveLength(2)
  })

  it('sends a second instance exactly once, and only after group_interval', async () => {
    const h = harness([route()])
    await h.tickAt(T0 + 30 * SEC, [view()])
    const two = view({
      instances: [
        { fingerprint: 'fp1', name: 'web-1', value: '0', startsAt: iso(T0) },
        { fingerprint: 'fp2', name: 'web-2', value: '0', startsAt: iso(T0 + 60 * SEC) }
      ]
    })
    for (let t = T0 + 60 * SEC; t < T0 + 330 * SEC; t += 10 * SEC) await h.tickAt(t, [two])
    expect(h.by('ntfy').sent).toHaveLength(1)
    await h.tickAt(T0 + 330 * SEC, [two])
    expect(h.by('ntfy').sent).toHaveLength(2)
    for (let t = T0 + 340 * SEC; t < T0 + 1000 * SEC; t += 10 * SEC) await h.tickAt(t, [two])
    expect(h.by('ntfy').sent).toHaveLength(2)
    expect(h.by('ntfy').sent[1].body).toContain('2 instances')
  })

  it('backs off 5 s, 10 s after failures, then succeeds and resets', async () => {
    const ntfy = fakeChannel('ntfy', false)
    const h = harness([route()], { channels: [ntfy] })
    const t = T0 + 30 * SEC
    await h.tickAt(t, [view()])
    expect(h.store.getLog(aKey())).toEqual({ key: aKey(), sentAt: 0, digest: '', ok: false, attempts: 1, nextAttemptAt: t + 5 * SEC, firstFailedAt: t })
    await h.tickAt(t + 5 * SEC - 1, [view()])
    expect(ntfy.sent).toHaveLength(1)
    await h.tickAt(t + 5 * SEC, [view()])
    expect(ntfy.sent).toHaveLength(2)
    expect(h.store.getLog(aKey())).toMatchObject({ attempts: 2, nextAttemptAt: t + 5 * SEC + 10 * SEC })
    await h.tickAt(t + 15 * SEC - 1, [view()])
    expect(ntfy.sent).toHaveLength(2)
    ntfy.ok = true
    const rows = await h.tickAt(t + 15 * SEC, [view()])
    expect(ntfy.sent).toHaveLength(3)
    expect(rows.map((r) => r.ok)).toEqual([true])
    expect(h.store.getLog(aKey())).toEqual({ key: aKey(), sentAt: t + 15 * SEC, digest: fingerprintDigest(view()), ok: true, attempts: 0, nextAttemptAt: null })
    expect(h.store.results.map((r) => r.ok)).toEqual([false, false, true])
    await h.tickAt(t + 25 * SEC, [view()])
    expect(ntfy.sent).toHaveLength(3)
  })

  it('keeps the old row on a failed repeat, so the repeat is retried, not forgotten', async () => {
    const ntfy = fakeChannel('ntfy')
    const h = harness([route()], { channels: [ntfy] })
    const first = T0 + 30 * SEC
    await h.tickAt(first, [view()])
    ntfy.ok = false
    const repeatAt = first + 3600 * SEC
    await h.tickAt(repeatAt, [view()])
    expect(h.store.getLog(aKey())).toEqual({
      key: aKey(),
      sentAt: first,
      digest: fingerprintDigest(view()),
      ok: true,
      attempts: 1,
      nextAttemptAt: repeatAt + 5 * SEC,
      firstFailedAt: repeatAt
    })
    ntfy.ok = true
    await h.tickAt(repeatAt + 5 * SEC, [view()])
    expect(ntfy.sent).toHaveLength(3)
    expect(h.store.getLog(aKey())).toMatchObject({ sentAt: repeatAt + 5 * SEC, attempts: 0, nextAttemptAt: null })
  })

  it('retries only the receiver that failed in mode all', async () => {
    const ntfy = fakeChannel('ntfy')
    const sms = fakeChannel('sms', false)
    const h = harness([route({ receivers: ['ntfy', 'sms'] })], { channels: [ntfy, sms] })
    const t = T0 + 30 * SEC
    await h.tickAt(t, [view()])
    sms.ok = true
    await h.tickAt(t + 5 * SEC, [view()])
    expect(ntfy.sent).toHaveLength(1)
    expect(sms.sent).toHaveLength(2)
  })

  it('stops sending and escalating once acked or silenced, and resumes when attention returns', async () => {
    const r = route({ escalate: [{ afterSec: 600, receivers: ['sms'] }] })
    const h = harness([r])
    await h.tickAt(T0 + 30 * SEC, [view()])
    expect(h.by('ntfy').sent).toHaveLength(1)
    for (const attention of ['acked', 'silenced'] as const) {
      await h.tickAt(T0 + 700 * SEC, [view({ attention, unattendedSec: 650 })])
      await h.tickAt(T0 + 7200 * SEC, [view({ attention, unattendedSec: 650 })])
    }
    expect(h.by('ntfy').sent).toHaveLength(1)
    expect(h.by('sms').sent).toHaveLength(0)
    await h.tickAt(T0 + 7300 * SEC, [view({ attention: 'none', unattendedSec: 650 })])
    expect(h.by('ntfy').sent).toHaveLength(2)
    expect(h.by('sms').sent).toHaveLength(1)
  })

  it('sends nothing for an incident acked before group_wait ends', async () => {
    const h = harness([route()])
    await h.tickAt(T0 + 60 * SEC, [view({ attention: 'acked' })])
    expect(h.store.results).toEqual([])
  })
})

describe('escalation', () => {
  const r = route({ escalate: [{ afterSec: 600, receivers: ['sms'] }] })

  it('fires its step once at the edge and then repeats at the repeat interval', async () => {
    const h = harness([r])
    await h.tickAt(T0 + 30 * SEC, [view({ unattendedSec: 30 })])
    await h.tickAt(T0 + 599 * SEC, [view({ unattendedSec: 599 })])
    expect(h.by('sms').sent).toHaveLength(0)
    const rows = await h.tickAt(T0 + 600 * SEC, [view({ unattendedSec: 600 })])
    expect(h.by('sms').sent).toHaveLength(1)
    expect(h.by('sms').sent[0]).toMatchObject({ kind: 'escalation', title: 'Escalated page: API edge dead' })
    expect(h.by('sms').sent[0].body.split('\n')[0]).toBe('Unattended for 10m.')
    expect(rows.map((x) => [x.channelId, x.kind])).toEqual([['sms', 'escalation']])
    expect(h.store.getLog(aKey('sms', 'r1', 'esc0'))).toMatchObject({ ok: true, sentAt: T0 + 600 * SEC })
    for (let i = 1; i <= 10; i++) await h.tickAt(T0 + 600 * SEC + i * 60 * SEC, [view({ unattendedSec: 600 + i * 60 })])
    expect(h.by('sms').sent).toHaveLength(1)
    await h.tickAt(T0 + 600 * SEC + 3600 * SEC, [view({ unattendedSec: 4200 })])
    expect(h.by('sms').sent).toHaveLength(2)
  })

  it('never fires once the incident is acked before the edge', async () => {
    const h = harness([r])
    await h.tickAt(T0 + 30 * SEC, [view()])
    await h.tickAt(T0 + 900 * SEC, [view({ attention: 'acked', unattendedSec: 400 })])
    expect(h.by('sms').sent).toHaveLength(0)
  })
})

describe('ladder', () => {
  it('falls through a failing first receiver to the second inside the time budget', async () => {
    const ntfy = fakeChannel('ntfy', false)
    const sms = fakeChannel('sms')
    const h = harness([route({ receivers: ['ntfy', 'sms'], mode: 'ladder' })], { channels: [ntfy, sms] })
    const t = T0 + 30 * SEC
    const rows = await h.tickAt(t, [view()])
    expect(ntfy.sent).toHaveLength(2) // one try and one retry
    expect(sms.sent).toHaveLength(1)
    expect(h.sleeps).toEqual([1000])
    expect(h.clock.t - t).toBeLessThanOrEqual(8000)
    expect(rows.map((x) => [x.channelId, x.ok, x.status])).toEqual([['ntfy', false, '500'], ['sms', true, '200']])
    expect(h.store.getLog(aKey('ntfy'))).toMatchObject({ ok: false, attempts: 1 })
    expect(h.store.getLog(aKey('sms'))).toMatchObject({ ok: true, attempts: 0 })

    // The ladder landed: ntfy's backoff passing does not send again, and no receiver is retried early.
    await h.tickAt(t + 20 * SEC, [view()])
    expect(ntfy.sent).toHaveLength(2)
    expect(sms.sent).toHaveLength(1)
    // At the repeat interval the ladder starts from the top again.
    ntfy.ok = true
    await h.tickAt(t + 3600 * SEC + 2000, [view()])
    expect(ntfy.sent).toHaveLength(3)
    expect(sms.sent).toHaveLength(1)
  })

  it('stops at the first receiver that succeeds', async () => {
    const h = harness([route({ receivers: ['ntfy', 'sms'], mode: 'ladder' })])
    await h.tickAt(T0 + 30 * SEC, [view()])
    expect(h.by('ntfy').sent).toHaveLength(1)
    expect(h.by('sms').sent).toHaveLength(0)
    expect(h.sleeps).toEqual([])
  })

  it('succeeds on the single retry without moving to the next receiver', async () => {
    let n = 0
    const flaky = fakeChannel('ntfy', true, async () => (++n === 1 ? { ok: false, status: '503', latencyMs: 3000 } : { ok: true, status: '200', latencyMs: 80 }))
    const h = harness([route({ receivers: ['ntfy', 'sms'], mode: 'ladder' })], { channels: [flaky, fakeChannel('sms')] })
    const rows = await h.tickAt(T0 + 30 * SEC, [view()])
    expect(rows.map((x) => [x.channelId, x.ok])).toEqual([['ntfy', true]])
    expect(h.by('sms').sent).toHaveLength(0)
  })

  it('caps an attempt at the attempt timeout even when a channel hangs', async () => {
    const hung = fakeChannel('ntfy', true, () => new Promise<SendResult>(() => {}))
    const h = harness([route({ receivers: ['ntfy', 'sms'], mode: 'ladder' })], { channels: [hung, fakeChannel('sms')], timing: { attemptMs: 15 } })
    const rows = await h.tickAt(T0 + 30 * SEC, [view()])
    expect(rows.map((x) => [x.channelId, x.ok, x.status])).toEqual([['ntfy', false, 'timeout'], ['sms', true, '200']])
    // A timeout opens the channel's circuit, so the single retry on the same receiver is not made: the ladder goes on to the next one.
    expect(hung.sent).toHaveLength(1)
  })

  it('bounds the whole ladder: no new attempt starts after the budget is spent', async () => {
    const clockRef = { advance: (_ms: number) => {} }
    const slowFail = (id: string) =>
      fakeChannel(id, false, async () => {
        clockRef.advance(3000)
        return { ok: false, status: '503', latencyMs: 3000 }
      })
    const [a, b, c] = [slowFail('a'), slowFail('b'), slowFail('c')]
    const h = harness([route({ receivers: ['a', 'b', 'c'], mode: 'ladder' })], { channels: [a, b, c], timing: { budgetMs: 10_000 } })
    clockRef.advance = (ms) => {
      h.clock.t += ms
    }
    const start = T0 + 30 * SEC
    await h.tickAt(start, [view()])
    expect(a.sent).toHaveLength(2)
    expect(b.sent).toHaveLength(1)
    expect(c.sent).toHaveLength(0)
    expect(h.clock.t - start).toBeLessThanOrEqual(10_000)
  })

  it('skips an unknown receiver without a retry pause', async () => {
    const h = harness([route({ receivers: ['ghost', 'sms'], mode: 'ladder' })])
    const rows = await h.tickAt(T0 + 30 * SEC, [view()])
    expect(rows.map((x) => [x.channelId, x.ok, x.status])).toEqual([['ghost', false, 'unknown channel'], ['sms', true, '200']])
    expect(h.sleeps).toEqual([])
  })
})

describe('record channels', () => {
  it('copies what was sent to the record channel, outside the ladder and its result', async () => {
    const ntfy = fakeChannel('ntfy')
    const chat = fakeChannel('chat-alerts', false)
    const h = harness([route({ record: ['chat-alerts'], mode: 'ladder', receivers: ['ntfy'] })], { channels: [ntfy, chat], timing: { recordRetryMs: [] } })
    const rows = await h.tickAt(T0 + 30 * SEC, [view()])
    expect(chat.sent).toHaveLength(1)
    expect(chat.sent[0]).toEqual(ntfy.sent[0])
    expect(rows.map((x) => [x.channelId, x.ok])).toEqual([['ntfy', true], ['chat-alerts', false]])
    // A failing record channel changes nothing about the notification's own log row.
    expect(h.store.getLog(aKey('ntfy'))).toMatchObject({ ok: true, attempts: 0 })
    expect(h.store.getLog(aKey('chat-alerts'))).toBeNull()
    await h.tickAt(T0 + 60 * SEC, [view()])
    expect(chat.sent).toHaveLength(1)
  })

  it('records nothing when nothing was delivered', async () => {
    const chat = fakeChannel('chat-alerts')
    const h = harness([route({ record: ['chat-alerts'] })], { channels: [fakeChannel('ntfy', false), chat] })
    await h.tickAt(T0 + 30 * SEC, [view()])
    expect(chat.sent).toHaveLength(0)
  })

  describe('a record copy that failed for a reason that may pass', () => {
    const recordRoute = () => route({ record: ['chat-alerts'], mode: 'ladder', receivers: ['ntfy'] })
    const outcomes = (...results: Array<Partial<SendResult>>) => {
      let n = 0
      return (): Promise<SendResult> => {
        const r = results[Math.min(n++, results.length - 1)]
        return Promise.resolve({ ok: false, status: '500', latencyMs: 3, ...r })
      }
    }

    it('is retried after 2 s, 10 s and 30 s, apart from the tick, and every try is a row in the result log', async () => {
      const chat = fakeChannel('chat-alerts', true, outcomes({ status: '502' }, { status: '503' }, { ok: true, status: '200' }))
      const h = harness([recordRoute()], { channels: [fakeChannel('ntfy'), chat] })
      const rows = await h.tickAt(T0 + 30 * SEC, [view()])
      // The tick answered with the first try only; the retries wait behind the sleeps.
      expect(rows.map((x) => [x.channelId, x.status])).toEqual([['ntfy', '200'], ['chat-alerts', '502']])
      await h.notifier.settled()
      expect(h.sleeps).toEqual([2000, 10_000])
      expect(chat.sent).toHaveLength(3)
      expect(chat.sent[2]).toEqual(chat.sent[0])
      expect(h.store.results.filter((x) => x.channelId === 'chat-alerts').map((x) => x.status)).toEqual(['502', '503', '200'])
      expect(h.store.getLog(aKey('chat-alerts'))).toBeNull()
    })

    it('waits as long as the server asked when that is longer, and gives up after the last delay', async () => {
      const chat = fakeChannel('chat-alerts', true, outcomes({ status: '429', retryAfterMs: 20_000 }, { status: '500' }))
      const logs: string[] = []
      const h = harness([recordRoute()], { channels: [fakeChannel('ntfy'), chat], log: (l) => logs.push(l) })
      await h.tickAt(T0 + 30 * SEC, [view()])
      await h.notifier.settled()
      expect(h.sleeps).toEqual([20_000, 10_000, 30_000])
      expect(chat.sent).toHaveLength(4)
      expect(logs).toEqual([
        'notify: chat-alerts answered 429, circuit open until 12:00:50 UTC',
        'notify: record r1 via chat-alerts failed (429)',
        'notify: record r1 via chat-alerts failed again (500)',
        'notify: record r1 via chat-alerts failed again (500)',
        'notify: record r1 via chat-alerts failed again (500)'
      ])
    })

    it('is retried after a timeout or a network error but not after a refusal or a missing credential', async () => {
      for (const [result, tries] of [
        [{ status: 'timeout' }, 1], // opens the circuit: the retries find it open
        [{ status: '429' }, 1],
        [{ status: 'error', detail: 'TypeError' }, 4],
        [{ status: '400' }, 1],
        [{ status: '404' }, 1],
        [{ status: 'error', detail: 'missing credential' }, 1],
        [{ status: 'unknown channel' }, 1]
      ] as Array<[Partial<SendResult>, number]>) {
        const chat = fakeChannel('chat-alerts', true, outcomes(result))
        const h = harness([recordRoute()], { channels: [fakeChannel('ntfy'), chat] })
        await h.tickAt(T0 + 30 * SEC, [view()])
        await h.notifier.settled()
        expect([result.status, chat.sent.length]).toEqual([result.status, tries])
      }
    })

    it('never holds up the ladder: a record that is still retrying does not delay the next tick or the next page', async () => {
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => (release = resolve))
      const chat = fakeChannel('chat-alerts', false, async () => ({ ok: false, status: '429', latencyMs: 1 }))
      const ntfy = fakeChannel('ntfy')
      const h = harness([recordRoute()], { channels: [ntfy, chat], timing: { sleep: () => gate } })
      await h.tickAt(T0 + 30 * SEC, [view()])
      const other = view({ key: 'db|Slow', rule: 'Slow', service: 'db' })
      await h.tickAt(T0 + 40 * SEC, [other])
      expect(ntfy.sent).toHaveLength(2)
      release()
      await h.notifier.settled()
    })
  })
})

describe('quiet hours', () => {
  const quiet: QuietHoursConfig = { tz: 'UTC', start: '22:00', end: '07:00' }
  const night = Date.parse('2026-10-14T23:00:00Z')
  const morning = Date.parse('2026-10-15T07:00:00Z')
  const muted = route({ muteInQuietHours: true, groupWaitSec: 0 })
  const warn = (key: string, rule: string, over: Partial<NotifyView> = {}) =>
    view({ key, rule, summary: rule, severity: 'warning', service: 'svc', firstSeen: iso(night - 3600 * SEC), ...over })

  it('holds a warning, never a page, and sends one digest at quiet end', async () => {
    const h = harness([muted], { quiet, start: night })
    const page = view({ key: 'svc|pg', rule: 'pg', severity: 'page', firstSeen: iso(night - 3600 * SEC) })
    const w1 = warn('svc|w1', 'w1')
    const w2 = warn('svc|w2', 'w2')

    const rows = await h.tickAt(night, [page, w1, w2])
    expect(rows.map((x) => [x.incidentKey, x.kind])).toEqual([['svc|pg', 'alert']])
    expect(h.store.getHeld('r1')).toEqual(['svc|w1', 'svc|w2'])

    // Quiet continues: the page keeps repeating on its own clock, the warnings stay held and unsent.
    await h.tickAt(night + 3 * 3600 * SEC, [page, w1, w2])
    await h.tickAt(morning - SEC, [page, w1])
    expect(h.by('ntfy').sent.map((m) => m.tag)).toEqual(['svc|pg', 'svc|pg', 'svc|pg'])
    expect(h.store.getHeld('r1')).toEqual(['svc|w1', 'svc|w2'])

    // w2 resolved while held. Quiet ends: one digest, listing only w1.
    const digestRows = await h.tickAt(morning, [page, w1])
    const digests = h.by('ntfy').sent.filter((m) => m.kind === 'digest')
    expect(digests).toHaveLength(1)
    expect(digests[0].body.split('\n')).toEqual(['1 alert held during quiet hours is still firing.', 'svc: w1, 1 instance'])
    expect(digestRows.map((x) => [x.incidentKey, x.kind, x.ok])).toEqual([['digest:r1', 'digest', true]])
    expect(h.store.getHeld('r1')).toEqual([])

    // The digest counted as w1's notification: no alert follows it, and the repeat clock starts at the digest.
    await h.tickAt(morning + 30 * SEC, [page, w1])
    expect(h.by('ntfy').sent.filter((m) => m.kind === 'alert' && m.tag === 'svc|w1')).toHaveLength(0)
    expect(h.store.getLog(aKey('ntfy', 'r1', 'alert', 'svc|w1'))).toMatchObject({ ok: true, sentAt: morning })
    await h.tickAt(morning + 3600 * SEC, [page, w1])
    expect(h.by('ntfy').sent.filter((m) => m.kind === 'alert' && m.tag === 'svc|w1')).toHaveLength(1)
  })

  it('sends the digest to every receiver in mode all, and to the first only in a ladder', async () => {
    const all = harness([{ ...muted, receivers: ['ntfy', 'sms'] }], { quiet, start: night })
    await all.tickAt(night, [warn('svc|w1', 'w1')])
    await all.tickAt(morning, [warn('svc|w1', 'w1')])
    expect(all.by('ntfy').sent.map((m) => m.kind)).toEqual(['digest'])
    expect(all.by('sms').sent.map((m) => m.kind)).toEqual(['digest'])

    const ladder = harness([{ ...muted, receivers: ['ntfy', 'sms'], mode: 'ladder' }], { quiet, start: night })
    await ladder.tickAt(night, [warn('svc|w1', 'w1')])
    await ladder.tickAt(morning, [warn('svc|w1', 'w1')])
    expect(ladder.by('ntfy').sent.map((m) => m.kind)).toEqual(['digest'])
    expect(ladder.by('sms').sent).toHaveLength(0)
  })

  it('sends no digest when everything held cleared, and keeps a failed digest for a backed-off retry', async () => {
    const quietEnded = harness([muted], { quiet, start: night })
    await quietEnded.tickAt(night, [warn('svc|w1', 'w1')])
    await quietEnded.tickAt(morning, [])
    expect(quietEnded.by('ntfy').sent).toHaveLength(0)
    expect(quietEnded.store.getHeld('r1')).toEqual([])

    const ntfy = fakeChannel('ntfy')
    const failing = harness([muted], { quiet, start: night, channels: [ntfy] })
    await failing.tickAt(night, [warn('svc|w1', 'w1')])
    ntfy.ok = false
    await failing.tickAt(morning, [warn('svc|w1', 'w1')])
    expect(failing.store.getHeld('r1')).toEqual(['svc|w1'])
    await failing.tickAt(morning + 4 * SEC, [warn('svc|w1', 'w1')])
    expect(ntfy.sent).toHaveLength(1)
    ntfy.ok = true
    await failing.tickAt(morning + 5 * SEC, [warn('svc|w1', 'w1')])
    expect(ntfy.sent.map((m) => m.kind)).toEqual(['digest', 'digest'])
    expect(failing.store.getHeld('r1')).toEqual([])
  })

  it('does not mute a route that does not ask for it', async () => {
    const h = harness([route({ groupWaitSec: 0 })], { quiet, start: night })
    await h.tickAt(night, [warn('svc|w1', 'w1')])
    expect(h.by('ntfy').sent.map((m) => m.kind)).toEqual(['alert'])
  })

  it('rejects a bad time zone at construction', () => {
    expect(() => harness([muted], { quiet: { tz: 'Mars/Base', start: '22:00', end: '07:00' } })).toThrow(RangeError)
  })
})

describe('flapping', () => {
  it('sends one flapping notice instead of alerts, and alerts again once it settles', async () => {
    const h = harness([route()])
    const flapping = view({ flapping: true })
    await h.tickAt(T0 + 30 * SEC, [flapping])
    const changed = view({ flapping: true, instances: [{ fingerprint: 'other', name: 'web-9', startsAt: iso(T0) }] })
    for (let i = 1; i <= 30; i++) await h.tickAt(T0 + 30 * SEC + i * 30 * SEC, [i % 2 ? changed : flapping])
    expect(h.by('ntfy').sent.map((m) => m.kind)).toEqual(['flapping'])
    expect(h.by('ntfy').sent[0].title).toBe('Flapping: API edge dead')
    expect(h.store.getLog(aKey('ntfy', 'r1', 'flap'))).toMatchObject({ ok: true })
    await h.tickAt(T0 + 30 * SEC + 3600 * SEC, [flapping])
    expect(h.by('ntfy').sent.map((m) => m.kind)).toEqual(['flapping', 'flapping'])
    await h.tickAt(T0 + 30 * SEC + 3700 * SEC, [view()])
    expect(h.by('ntfy').sent.map((m) => m.kind)).toEqual(['flapping', 'flapping', 'alert'])
  })
})

describe('resolved', () => {
  const r = route({ sendResolved: true })

  it('waits until the incident is stable, then sends once per resolution', async () => {
    const h = harness([r])
    await h.tickAt(T0, [], [resolvedView({ stableForSec: 599 })])
    expect(h.by('ntfy').sent).toHaveLength(0)
    const rows = await h.tickAt(T0 + 1000, [], [resolvedView({ stableForSec: 600 })])
    expect(rows.map((x) => x.kind)).toEqual(['resolved'])
    const sent = h.by('ntfy').sent[0]
    expect(sent).toMatchObject({ kind: 'resolved', title: 'Resolved: API edge dead', severity: 'page', tag: 'edge|EdgeDead' })
    expect(sent.body).toBe('edge, resolved at 12:30 UTC after 30m.')
    expect(sent.ackUrl).toBeUndefined()
    await h.tickAt(T0 + 2000, [], [resolvedView({ stableForSec: 1300 })])
    expect(h.by('ntfy').sent).toHaveLength(1)
    await h.tickAt(T0 + 3000, [], [resolvedView({ stableForSec: 600, resolvedAt: iso(T0 + 9_000_000) })])
    expect(h.by('ntfy').sent).toHaveLength(2)
  })

  it('does not announce a resolution nobody was told about', async () => {
    const h = harness([r])
    await h.tickAt(T0, [], [resolvedView({ wasNotified: false })])
    await h.tickAt(T0, [], [resolvedView()])
    expect(h.by('ntfy').sent).toHaveLength(1)
    const quiet = harness([route()])
    await quiet.tickAt(T0, [], [resolvedView()])
    expect(quiet.by('ntfy').sent).toHaveLength(0)
  })
})

describe('routing through the notifier', () => {
  it('sends to both routes when the first continues', async () => {
    const a = route({ id: 'a', match: { severity: ['page'] }, receivers: ['ntfy'], continue: true })
    const b = route({ id: 'b', receivers: ['sms'] })
    const h = harness([a, b])
    const rows = await h.tickAt(T0 + 30 * SEC, [view()])
    expect(rows.map((x) => [x.routeId, x.channelId])).toEqual([['a', 'ntfy'], ['b', 'sms']])
    expect(h.store.getLog(aKey('ntfy', 'a'))).toMatchObject({ ok: true })
    expect(h.store.getLog(aKey('sms', 'b'))).toMatchObject({ ok: true })
  })

  it('stops at the first match without continue', async () => {
    const h = harness([route({ id: 'a', receivers: ['ntfy'] }), route({ id: 'b', receivers: ['sms'] })])
    await h.tickAt(T0 + 30 * SEC, [view()])
    expect(h.by('ntfy').sent).toHaveLength(1)
    expect(h.by('sms').sent).toHaveLength(0)
  })

  it('sends nothing for severity info when no route matches it', async () => {
    const h = harness([route({ match: { severity: ['page', 'warning'] } })])
    const rows = await h.tickAt(T0 + 30 * SEC, [view({ severity: 'info' })])
    expect(rows).toEqual([])
    expect(h.store.results).toEqual([])
    expect(h.by('ntfy').sent).toHaveLength(0)
  })

  it('does not send twice when two ticks overlap', async () => {
    let release: (r: SendResult) => void = () => {}
    const slow = fakeChannel('ntfy', true, () => new Promise<SendResult>((resolve) => (release = resolve)))
    const h = harness([route()], { channels: [slow] })
    h.clock.t = T0 + 30 * SEC
    const first = h.notifier.tick([view()], [])
    const second = h.notifier.tick([view()], [])
    await new Promise((resolve) => setTimeout(resolve, 10))
    release({ ok: true, status: '200', latencyMs: 9 })
    await Promise.all([first, second])
    expect(slow.sent).toHaveLength(1)
  })
})

describe('messages', () => {
  it('builds the alert title, a body of at most six lines, and signed links', async () => {
    const h = harness([route()])
    const instances = Array.from({ length: 8 }, (_, i) => ({ fingerprint: `fp${i}`, name: `host-${i}`, value: i === 0 ? undefined : String(i), startsAt: iso(T0) }))
    await h.tickAt(T0 + 12 * 60 * SEC, [view({ instances, key: 'my svc|Rule A/B', startsAt: iso(T0 + 5 * 60 * SEC) })])
    const m = h.by('ntfy').sent[0]
    expect(m.kind).toBe('alert')
    expect(m.title).toBe('Page: API edge dead')
    expect(m.body.split('\n')).toEqual([
      'edge, 8 instances firing since 12:05 UTC, 7m old.',
      'host-0',
      'host-1: 1',
      'host-2: 2',
      'host-3: 3',
      '+4 more'
    ])
    expect(m.tag).toBe('my svc|Rule A/B')
    expect(m.url).toBe('https://watch.example/#/i/my%20svc%7CRule%20A%2FB')
    const hmac = createHmac('sha256', ACK_SECRET).update('my svc|Rule A/B').digest('hex')
    expect(m.ackUrl).toBe(`https://watch.example/api/ack?k=my%20svc%7CRule%20A%2FB&s=${hmac}`)
    expect(verifyAckSignature(ACK_SECRET, 'my svc|Rule A/B', hmac)).toBe(true)
    expect(verifyAckSignature(ACK_SECRET, 'other', hmac)).toBe(false)
  })

  it('shows up to five instances in full and uses the rule when there is no summary', async () => {
    const h = harness([route()])
    const instances = Array.from({ length: 5 }, (_, i) => ({ fingerprint: `fp${i}`, name: `h${i}`, startsAt: iso(T0) }))
    await h.tickAt(T0 + 30 * SEC, [view({ instances, summary: '', severity: 'warning' })])
    const m = h.by('ntfy').sent[0]
    expect(m.title).toBe('Warning: EdgeDead')
    expect(m.body.split('\n')).toHaveLength(6)
    expect(m.body).not.toContain('more')
    expect(m.body.split('\n')[0]).toBe('edge, 5 instances firing since 12:00 UTC, under 1m old.')
  })

  it('writes plain text: no emoji, no em dash, no middle dot', async () => {
    const h = harness([route({ receivers: ['ntfy'], escalate: [{ afterSec: 60, receivers: ['ntfy'] }], sendResolved: true })])
    await h.tickAt(T0 + 70 * SEC, [view({ unattendedSec: 70, flapping: false })])
    await h.tickAt(T0 + 70 * SEC, [], [resolvedView()])
    const text = h.by('ntfy').sent.map((m) => `${m.title}\n${m.body}`).join('\n')
    expect(text).toContain('Escalated page')
    expect(text).not.toMatch(/[\u2014\u00b7\u{1F300}-\u{1FAFF}\u2600-\u27bf]/u)
  })
})

describe('logging', () => {
  it('logs a failed send with its status and no message content', async () => {
    const lines: string[] = []
    const ntfy = fakeChannel('ntfy', false)
    const notifier = createNotifier({
      routes: [route()],
      channels: new Map([['ntfy', ntfy]]),
      quiet: null,
      store: new MemStore(),
      now: () => T0 + 30 * SEC,
      baseUrl: 'https://watch.example',
      ackSecret: ACK_SECRET,
      log: (line) => lines.push(line)
    })
    await notifier.tick([view()], [])
    expect(lines).toEqual(['notify: alert r1 via ntfy failed (500)'])
  })

  it('keeps the other sends when one cannot settle', async () => {
    const lines: string[] = []
    const store = new MemStore()
    const real = store.putLog.bind(store)
    store.putLog = (row) => {
      if (row.key.includes('|a|')) throw new RangeError('disk full at /secret/path')
      real(row)
    }
    const notifier = createNotifier({
      routes: [route({ id: 'a', continue: true }), route({ id: 'b' })],
      channels: new Map([['ntfy', fakeChannel('ntfy')]]),
      quiet: null,
      store,
      now: () => T0 + 30 * SEC,
      baseUrl: 'https://watch.example',
      ackSecret: ACK_SECRET,
      log: (line) => lines.push(line)
    })
    const rows = await notifier.tick([view()], [])
    expect(rows.map((r) => r.routeId)).toEqual(['b'])
    expect(lines).toEqual(['notify: a send failed to settle (RangeError)'])
  })
})

describe('test()', () => {
  it('sends a test message through one channel and returns its result without logging', async () => {
    const h = harness([route()])
    const result = await h.notifier.test('sms')
    expect(result).toEqual({ ok: true, status: '200', latencyMs: 4 })
    expect(h.by('sms').sent).toHaveLength(1)
    expect(h.by('sms').sent[0]).toMatchObject({ kind: 'test', title: 'EZO Watcher test', severity: 'info' })
    expect(h.by('ntfy').sent).toHaveLength(0)
    expect(h.store.results).toEqual([])
    expect(h.store.logs.size).toBe(0)
  })

  it('reports an unknown channel and a failing one', async () => {
    const h = harness([route()], { channels: [fakeChannel('ntfy', false)] })
    expect(await h.notifier.test('ghost')).toEqual({ ok: false, status: 'unknown channel', latencyMs: 0 })
    expect(await h.notifier.test('ntfy')).toMatchObject({ ok: false, status: '500' })
  })

  it('turns a throwing channel into an error result', async () => {
    const boom = fakeChannel('ntfy', true, async () => {
      throw new TypeError('connect ECONNREFUSED https://secret-host.example/topic')
    })
    const h = harness([route()], { channels: [boom] })
    const result = await h.notifier.test('ntfy')
    expect(result).toMatchObject({ ok: false, status: 'error', detail: 'TypeError' })
    expect(JSON.stringify(result)).not.toContain('secret-host')
  })
})

// The page route is a ladder: ntfy, then web push only when the ntfy step failed. The ntfy step has two targets
// (ntfy.sh with a content-free notice, the self-hosted server with the alert) and NTFY_PRIMARY names the one the
// phone listens to. Only that one decides whether web push must fire.
describe('the page ladder with the real ntfy channel', () => {
  const ntfyCfg: ChannelConfig = {
    id: 'ntfy',
    type: 'ntfy',
    server: 'https://ntfy.example',
    topicEnv: 'TOPIC',
    self: { urlEnv: 'SELF_URL', topicEnv: 'SELF_TOPIC', tokenEnv: 'SELF_TOKEN' },
    primaryEnv: 'NTFY_PRIMARY'
  }
  const pageRoute = () => route({ receivers: ['ntfy', 'webpush'], mode: 'ladder', groupWaitSec: 0 })

  function setup(primary: 'public' | 'self', down: 'public' | 'self' | 'none') {
    const calls: Array<{ url: string; body: string }> = []
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      calls.push({ url: u, body: String(init?.body ?? '') })
      const target = u.startsWith('https://ntfy.example/') ? 'public' : 'self'
      return new Response('{}', { status: down === target ? 503 : 200 })
    }) as typeof fetch
    const env = { TOPIC: 'public-topic', SELF_URL: 'https://self.example', SELF_TOPIC: 'pages', SELF_TOKEN: 'tk_x', NTFY_PRIMARY: primary }
    const ntfy = createChannel(ntfyCfg, { fetch: fetchFn, env, now: () => T0 }) as unknown as FakeChannel
    const webpush = fakeChannel('webpush')
    const h = harness([pageRoute()], { channels: [ntfy, webpush] })
    return { h, calls, webpush }
  }
  const to = (calls: Array<{ url: string; body: string }>, host: string) => calls.filter((c) => c.url.startsWith(host))

  it('both targets up: one notice to each, the ladder stops at ntfy, web push does not fire', async () => {
    const { h, calls, webpush } = setup('public', 'none')
    await h.tickAt(T0 + 30 * SEC, [view()])
    expect(to(calls, 'https://ntfy.example/')).toHaveLength(1)
    expect(to(calls, 'https://self.example/')).toHaveLength(1)
    expect(to(calls, 'https://ntfy.example/')[0].body).toBe('Open Watch for details')
    expect(to(calls, 'https://self.example/')[0].body).toContain('instance')
    expect(webpush.sent).toHaveLength(0)
  })

  it('primary public: the self-hosted server being down does not page web push', async () => {
    const { h, webpush } = setup('public', 'self')
    const rows = await h.tickAt(T0 + 30 * SEC, [view()])
    expect(rows.map((x) => [x.channelId, x.ok])).toEqual([['ntfy', true]])
    expect(webpush.sent).toHaveLength(0)
  })

  it('primary public: ntfy.sh down, so the phone would hear nothing: web push fires, and the alert still reached the self-hosted server', async () => {
    const { h, calls, webpush } = setup('public', 'public')
    const rows = await h.tickAt(T0 + 30 * SEC, [view()])
    expect(rows.map((x) => [x.channelId, x.ok])).toEqual([['ntfy', false], ['webpush', true]])
    expect(webpush.sent).toHaveLength(1)
    expect(to(calls, 'https://self.example/').length).toBeGreaterThanOrEqual(1)
  })

  it('primary self: ntfy.sh being down does not page web push', async () => {
    const { h, webpush } = setup('self', 'public')
    const rows = await h.tickAt(T0 + 30 * SEC, [view()])
    expect(rows.map((x) => [x.channelId, x.ok])).toEqual([['ntfy', true]])
    expect(webpush.sent).toHaveLength(0)
  })

  it('primary self: the self-hosted server down, so the phone would hear nothing: web push fires, and ntfy.sh still got its notice', async () => {
    const { h, calls, webpush } = setup('self', 'self')
    const rows = await h.tickAt(T0 + 30 * SEC, [view()])
    expect(rows.map((x) => [x.channelId, x.ok])).toEqual([['ntfy', false], ['webpush', true]])
    expect(webpush.sent).toHaveLength(1)
    expect(to(calls, 'https://ntfy.example/').length).toBeGreaterThanOrEqual(1)
    expect(to(calls, 'https://ntfy.example/')[0].body).toBe('Open Watch for details')
  })
})
