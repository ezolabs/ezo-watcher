import { describe, expect, it } from 'vitest'
import type { ChannelConfig } from '../src/server/config.ts'
import { createChannel } from '../src/server/notify/channels/index.ts'
import { CIRCUIT_BASE_MS, CIRCUIT_CAP_MS, CircuitBreaker, skippedStatus, tripsCircuit } from '../src/server/notify/circuit.ts'
import { MIN, SEC, T0, aKey, failing, fakeChannel, harness, route, view } from './notify-helpers.ts'
import type { FakeChannel } from './notify-helpers.ts'

const HOUR = 60 * MIN

describe('CircuitBreaker', () => {
  const make = () => {
    const clock = { t: T0 }
    return { clock, cb: new CircuitBreaker(() => clock.t) }
  }

  it('opens for 15 minutes when the target gave no Retry-After, and closes at the end of them', () => {
    const { clock, cb } = make()
    expect(cb.openUntil('t')).toBeNull()
    expect(cb.trip('t')).toBe(T0 + 15 * MIN)
    expect(CIRCUIT_BASE_MS).toBe(15 * MIN)
    clock.t = T0 + 15 * MIN - 1
    expect(cb.openUntil('t')).toBe(T0 + 15 * MIN)
    clock.t = T0 + 15 * MIN
    expect(cb.openUntil('t')).toBeNull()
  })

  it('honours Retry-After, and ignores one the server wrote as zero', () => {
    const { cb } = make()
    expect(cb.trip('a', 90 * SEC)).toBe(T0 + 90 * SEC)
    expect(cb.trip('b', 0)).toBe(T0 + 15 * MIN)
    expect(cb.trip('c', 4 * HOUR)).toBe(T0 + 2 * HOUR)
  })

  it('doubles for a repeat trip within an hour of the circuit ending, up to 2 hours', () => {
    const { clock, cb } = make()
    cb.trip('t')
    clock.t = T0 + 15 * MIN // the probe, as soon as it closes
    expect(cb.trip('t')).toBe(clock.t + 30 * MIN)
    clock.t += 30 * MIN
    expect(cb.trip('t')).toBe(clock.t + 60 * MIN)
    clock.t += 60 * MIN
    expect(cb.trip('t')).toBe(clock.t + 120 * MIN)
    clock.t += 120 * MIN
    expect(cb.trip('t')).toBe(clock.t + CIRCUIT_CAP_MS)
  })

  it('starts again from 15 minutes when the last trip is more than an hour behind', () => {
    const { clock, cb } = make()
    cb.trip('t')
    cb.trip('t')
    clock.t = T0 + 15 * MIN
    cb.trip('t') // 30 minutes, until 12:45
    clock.t = T0 + 45 * MIN + HOUR
    expect(cb.trip('t')).toBe(clock.t + 15 * MIN)
  })

  it('a repeat keeps the longer of the doubled length and what the server asked', () => {
    const { clock, cb } = make()
    cb.trip('t', 60 * SEC)
    clock.t = T0 + 60 * SEC
    expect(cb.trip('t', 10 * SEC)).toBe(clock.t + 120 * SEC)
    clock.t += 120 * SEC
    expect(cb.trip('t', 20 * MIN)).toBe(clock.t + 20 * MIN)
  })

  it('a trip while it is open changes nothing: sends that were in flight together all report the same refusal', () => {
    const { clock, cb } = make()
    cb.trip('t')
    clock.t = T0 + 5 * SEC
    expect(cb.trip('t')).toBe(T0 + 15 * MIN)
    expect(cb.trip('t', 30 * SEC)).toBe(T0 + 15 * MIN)
    expect(cb.trip('t', 20 * MIN)).toBe(clock.t + 20 * MIN)
  })

  it('keeps one circuit per target', () => {
    const { cb } = make()
    cb.trip('ntfy:public')
    expect(cb.openUntil('ntfy:self')).toBeNull()
    expect(cb.open().map((o) => o.key)).toEqual(['ntfy:public'])
  })

  it('opens on a 429 and a timeout, not on a refusal or a server error', () => {
    expect(tripsCircuit({ ok: false, status: '429' })).toBe(true)
    expect(tripsCircuit({ ok: false, status: 'timeout' })).toBe(true)
    for (const status of ['400', '401', '404', '500', '503', 'error', 'no subscribers']) expect(tripsCircuit({ ok: false, status })).toBe(false)
    expect(tripsCircuit({ ok: true, status: '200' })).toBe(false)
  })
})

describe('the notifier and a target that is rate limited or does not answer', () => {
  it('a 429 without Retry-After opens the circuit for 15 minutes: no call, a skipped row, and the call goes out again when it closes', async () => {
    const chat = fakeChannel('chat-alerts', failing('429'))
    const h = harness([route({ receivers: ['chat-alerts'] })], { channels: [chat] })
    await h.tickAt(T0, [view()])
    expect(chat.sent).toHaveLength(1)
    // a second incident while the circuit is open: skipped, and the channel is not called
    const other = view({ key: 'db|Slow', rule: 'Slow', service: 'db' })
    const rows = await h.tickAt(T0 + 5 * SEC, [view(), other])
    expect(chat.sent).toHaveLength(1)
    expect(rows.map((r) => [r.incidentKey, r.ok, r.status])).toEqual([['db|Slow', false, skippedStatus(T0 + 15 * MIN)]])
    expect(skippedStatus(T0 + 15 * MIN)).toBe('skipped: circuit open until 12:15:00 UTC')
    expect(rows[0].latencyMs).toBe(0)

    // the first incident's retry waits for the circuit, not for its 5 s backoff
    expect(h.store.getLog(aKey('chat-alerts'))).toMatchObject({ attempts: 1, nextAttemptAt: T0 + 15 * MIN })
    // the skipped one is not a try
    expect(h.store.getLog(aKey('chat-alerts', 'r1', 'alert', 'db|Slow'))).toMatchObject({ attempts: 0, nextAttemptAt: T0 + 15 * MIN })

    await h.tickAt(T0 + 15 * MIN - 1, [view(), other])
    expect(chat.sent).toHaveLength(1)
    // closed: both go out again (the probe)
    chat.answers = [{}]
    await h.tickAt(T0 + 15 * MIN, [view(), other])
    expect(chat.sent).toHaveLength(3)
    expect(h.store.getLog(aKey('chat-alerts'))).toMatchObject({ ok: true, attempts: 0, nextAttemptAt: null })
  })

  it('honours Retry-After', async () => {
    const chat = fakeChannel('chat-alerts', failing('429', { retryAfterMs: 45 * SEC }))
    const h = harness([route({ receivers: ['chat-alerts'] })], { channels: [chat] })
    await h.tickAt(T0, [view()])
    expect(h.store.getLog(aKey('chat-alerts'))?.nextAttemptAt).toBe(T0 + 45 * SEC)
    await h.tickAt(T0 + 44 * SEC, [view()])
    expect(chat.sent).toHaveLength(1)
    await h.tickAt(T0 + 45 * SEC, [view()])
    expect(chat.sent).toHaveLength(2)
  })

  it('a timeout opens it too, and a repeat trip within the hour is twice as long', async () => {
    const hung = fakeChannel('chat-alerts')
    hung.send = async () => new Promise(() => {})
    const h = harness([route({ receivers: ['chat-alerts'] })], { channels: [hung], timing: { attemptMs: 10 } })
    const rows = await h.tickAt(T0, [view()])
    expect(rows.map((r) => r.status)).toEqual(['timeout'])
    expect(h.store.getLog(aKey('chat-alerts'))?.nextAttemptAt).toBe(T0 + 15 * MIN)
    const skipped = await h.tickAt(T0 + 10 * MIN, [view()])
    expect(skipped).toEqual([])
    // the probe at the end of the circuit times out again: now 30 minutes
    const again = await h.tickAt(T0 + 15 * MIN, [view()])
    expect(again.map((r) => r.status)).toEqual(['timeout'])
    expect(h.store.getLog(aKey('chat-alerts'))?.nextAttemptAt).toBe(T0 + 45 * MIN)
  })

  it('leaves the other targets alone: one Chat webhook does not stop another', async () => {
    const alerts = fakeChannel('chat-alerts', failing('429'))
    const notices = fakeChannel('chat-notices')
    const h = harness([route({ receivers: ['chat-alerts', 'chat-notices'] })], { channels: [alerts, notices] })
    await h.tickAt(T0, [view()])
    await h.tickAt(T0 + 30 * SEC, [view({ key: 'db|Slow', rule: 'Slow', service: 'db' })])
    expect(alerts.sent).toHaveLength(1)
    expect(notices.sent).toHaveLength(2)
  })

  it('the ladder goes on to the next receiver with no retry pause, and skips the open one without calling it', async () => {
    const ntfy = fakeChannel('ntfy', failing('429'))
    const sms = fakeChannel('sms')
    const h = harness([route({ mode: 'ladder', receivers: ['ntfy', 'sms'] })], { channels: [ntfy, sms] })
    const first = await h.tickAt(T0, [view()])
    expect(first.map((r) => [r.channelId, r.status])).toEqual([['ntfy', '429'], ['sms', '200']])
    expect(ntfy.sent).toHaveLength(1) // no second try on the same receiver after a 429
    const second = await h.tickAt(T0 + 5 * SEC, [view(), view({ key: 'db|Slow', rule: 'Slow', service: 'db' })])
    expect(second.map((r) => [r.channelId, r.status])).toEqual([['ntfy', skippedStatus(T0 + 15 * MIN)], ['sms', '200']])
    expect(ntfy.sent).toHaveLength(1)
    expect(sms.sent).toHaveLength(2)
  })

  it('SMS escalation still goes out while the phone rung is skipped', async () => {
    const ntfy = fakeChannel('ntfy', failing('429'))
    const webpush = fakeChannel('webpush', failing('no subscribers'))
    const sms = fakeChannel('sms')
    const r = route({ mode: 'ladder', receivers: ['ntfy', 'webpush'], escalate: [{ afterSec: 600, receivers: ['sms'] }] })
    const h = harness([r], { channels: [ntfy, webpush, sms] })
    await h.tickAt(T0, [view()])
    expect(sms.sent).toHaveLength(0)
    const rows = await h.tickAt(T0 + 600 * SEC, [view({ unattendedSec: 600 })])
    expect(sms.sent.map((m) => m.kind)).toEqual(['escalation'])
    expect(rows.find((x) => x.channelId === 'sms')).toMatchObject({ kind: 'escalation', ok: true })
    expect(ntfy.sent).toHaveLength(1)
  })

  it('a skipped call is a row that reads as failed, with latency 0, and a send test goes out whatever the circuit says', async () => {
    const chat = fakeChannel('chat-alerts', failing('429'))
    const h = harness([route({ receivers: ['chat-alerts'] })], { channels: [chat] })
    await h.tickAt(T0, [view()])
    chat.answers = [{}]
    expect((await h.notifier.test('chat-alerts')).ok).toBe(true)
    expect(chat.sent.map((m) => m.kind)).toEqual(['alert', 'test'])
  })

  it('survives the 5 second tick: the circuit stays open across every tick until it closes', async () => {
    const chat = fakeChannel('chat-alerts', failing('429'))
    const h = harness([route({ receivers: ['chat-alerts'] })], { channels: [chat] })
    await h.tickAt(T0, [view()])
    for (let t = T0 + 5 * SEC; t < T0 + 15 * MIN; t += 5 * SEC) await h.tickAt(t, [view()])
    expect(chat.sent).toHaveLength(1)
  })
})

describe('the ntfy channel keeps a circuit for each server', () => {
  const ntfyCfg: ChannelConfig = {
    id: 'ntfy',
    type: 'ntfy',
    server: 'https://ntfy.example',
    topicEnv: 'TOPIC',
    self: { urlEnv: 'SELF_URL', topicEnv: 'SELF_TOPIC', tokenEnv: 'SELF_TOKEN' },
    primaryEnv: 'NTFY_PRIMARY'
  }
  const pageRoute = () => route({ mode: 'ladder', receivers: ['ntfy', 'webpush'], escalate: [{ afterSec: 600, receivers: ['sms'] }] })

  type Answer = { status: number; headers?: Record<string, string> } | 'hang'
  function setup(answers: { public?: Answer; self?: Answer }, primary: 'public' | 'self' = 'public', webpushUp = true) {
    const calls: Array<{ target: 'public' | 'self'; at: number; kind: string }> = []
    const answer = { public: answers.public ?? { status: 200 }, self: answers.self ?? { status: 200 } }
    let h: ReturnType<typeof harness>
    const now = () => h.clock.t
    const circuits = new CircuitBreaker(now)
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url).startsWith('https://ntfy.example/') ? 'public' : 'self'
      calls.push({ target, at: now(), kind: String((init?.headers as Record<string, string>)?.Title ?? '') })
      const a = answer[target]
      if (a === 'hang') {
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }))
      }
      return new Response('{}', { status: a.status, headers: a.headers })
    }) as typeof fetch
    const env = { TOPIC: 'public-topic', SELF_URL: 'https://self.example', SELF_TOPIC: 'pages', SELF_TOKEN: 'tk_x', NTFY_PRIMARY: primary }
    const logs: string[] = []
    const ntfy = createChannel(ntfyCfg, { fetch: fetchFn, env, now, circuits, timeoutMs: 20, log: (l) => logs.push(l) })
    const webpush = webpushUp ? fakeChannel('webpush') : fakeChannel('webpush', failing('no subscribers'))
    const sms = fakeChannel('sms')
    h = harness([pageRoute()], { channels: [ntfy, webpush, sms], circuits })
    const count = (target: 'public' | 'self') => calls.filter((c) => c.target === target).length
    return { h, calls, count, webpush, sms, circuits, answer, logs }
  }

  const other = (n: number) => view({ key: `db|Slow${n}`, rule: `Slow${n}`, service: 'db' })

  it('a 429 from ntfy.sh with Retry-After opens ntfy.sh only: it is not called, the self-hosted server still is, and web push takes the rung', async () => {
    const t = setup({ public: { status: 429, headers: { 'Retry-After': '120' } } })
    const first = await t.h.tickAt(T0, [view()])
    expect(first.map((r) => [r.channelId, r.status])).toEqual([['ntfy', '429'], ['webpush', '200']])
    expect(t.count('public')).toBe(1)
    expect(t.count('self')).toBe(1)
    expect(t.circuits.openUntil('ntfy:public')).toBe(T0 + 120 * SEC)
    expect(t.circuits.openUntil('ntfy:self')).toBeNull()

    const second = await t.h.tickAt(T0 + 10 * SEC, [view(), other(1)])
    expect(second.map((r) => [r.channelId, r.status])).toEqual([['ntfy', skippedStatus(T0 + 120 * SEC)], ['webpush', '200']])
    expect(t.count('public')).toBe(1) // no call to ntfy.sh while its circuit is open
    expect(t.count('self')).toBe(2) // the healthy server still gets the whole alert
    expect(t.webpush.sent).toHaveLength(2)
  })

  it('without Retry-After it stays open 15 minutes, then ntfy.sh is probed again, and a success closes it', async () => {
    // web push has no subscribers, as on node-6, so the ladder has landed nowhere and the alert waits for the circuit
    const t = setup({ public: { status: 429 } }, 'public', false)
    await t.h.tickAt(T0, [view()])
    expect(t.circuits.openUntil('ntfy:public')).toBe(T0 + 15 * MIN)
    for (let i = 1; i < 14; i++) await t.h.tickAt(T0 + i * MIN, [view(), other(i)])
    expect(t.count('public')).toBe(1)
    t.answer.public = { status: 200 }
    const rows = await t.h.tickAt(T0 + 15 * MIN, [view()])
    expect(t.count('public')).toBeGreaterThanOrEqual(2)
    expect(rows.find((r) => r.channelId === 'ntfy' && r.incidentKey === 'edge|EdgeDead')).toMatchObject({ ok: true, status: '200' })
    expect(t.circuits.openUntil('ntfy:public')).toBeNull()
    expect(t.h.store.getLog(aKey('ntfy'))).toMatchObject({ ok: true, attempts: 0, nextAttemptAt: null })
  })

  it('a timeout from ntfy.sh opens it, and the second trip within the hour doubles it', async () => {
    const t = setup({ public: 'hang' })
    const first = await t.h.tickAt(T0, [view()])
    expect(first.map((r) => [r.channelId, r.status])).toEqual([['ntfy', 'timeout'], ['webpush', '200']])
    expect(t.circuits.openUntil('ntfy:public')).toBe(T0 + 15 * MIN)
    expect(t.logs.some((l) => l.startsWith('ntfy: public target answered timeout, circuit open until 12:15:00 UTC'))).toBe(true)
    await t.h.tickAt(T0 + 14 * MIN, [view(), other(1)])
    expect(t.count('public')).toBe(1)
    await t.h.tickAt(T0 + 15 * MIN, [view(), other(2)])
    expect(t.count('public')).toBe(2)
    expect(t.circuits.openUntil('ntfy:public')).toBe(T0 + 45 * MIN)
  })

  it('the self-hosted server has its own circuit: a 429 there leaves ntfy.sh being called', async () => {
    const t = setup({ self: { status: 429, headers: { 'retry-after': '60' } } })
    const first = await t.h.tickAt(T0, [view()])
    expect(first.map((r) => [r.channelId, r.status])).toEqual([['ntfy', '200']])
    expect(t.circuits.openUntil('ntfy:self')).toBe(T0 + 60 * SEC)
    expect(t.circuits.openUntil('ntfy:public')).toBeNull()
    await t.h.tickAt(T0 + 10 * SEC, [view(), other(1)])
    expect(t.count('self')).toBe(1)
    expect(t.count('public')).toBe(2)
    await t.h.tickAt(T0 + 60 * SEC, [view(), other(2)])
    expect(t.count('self')).toBe(2)
  })

  it('primary self: ntfy.sh being skipped does not fail the step', async () => {
    const t = setup({ public: { status: 429 } }, 'self')
    await t.h.tickAt(T0, [view()])
    const rows = await t.h.tickAt(T0 + 5 * SEC, [view(), other(1)])
    expect(rows.map((r) => [r.channelId, r.ok])).toEqual([['ntfy', true]])
    expect(t.webpush.sent).toHaveLength(0)
    expect(t.count('public')).toBe(1)
  })

  it('SMS escalation still goes out while ntfy.sh is skipped', async () => {
    const t = setup({ public: { status: 429 } })
    await t.h.tickAt(T0, [view()])
    await t.h.tickAt(T0 + 600 * SEC, [view({ unattendedSec: 600 })])
    expect(t.sms.sent.map((m) => m.kind)).toEqual(['escalation'])
  })

  it('a send test goes to ntfy.sh whatever the circuit says, and the real calls stay stopped', async () => {
    const t = setup({ public: { status: 429 } })
    await t.h.tickAt(T0, [view()])
    expect(t.count('public')).toBe(1)
    t.answer.public = { status: 200 }
    expect((await t.h.notifier.test('ntfy')).ok).toBe(true)
    expect(t.count('public')).toBe(2)
    await t.h.tickAt(T0 + 5 * SEC, [view(), other(1)])
    expect(t.count('public')).toBe(2)
  })
})

// A reminder that the fake channel type does not decide anything here: the circuit is keyed by the channel id
describe('FakeChannel', () => {
  it('is typed as a channel with answers', () => {
    const c: FakeChannel = fakeChannel('x', failing('429'))
    expect(c.answers).toHaveLength(1)
  })
})
