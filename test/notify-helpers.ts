// Shared fixtures for the notifier's retry, circuit and coalescing tests: views, routes, an in-memory store and a clock the tests move.

import type { QuietHoursConfig, RouteConfig } from '../src/server/config.ts'
import type { CircuitBreaker } from '../src/server/notify/circuit.ts'
import { createNotifier } from '../src/server/notify/notifier.ts'
import type { LadderTiming } from '../src/server/notify/notifier.ts'
import { logKey } from '../src/server/notify/plan.ts'
import type { Channel, LogRow, Message, NotifyStore, NotifyView, ResolvedView, ResultRow, SendResult } from '../src/server/notify/types.ts'

export const T0 = Date.parse('2026-10-20T12:00:00Z')
export const SEC = 1000
export const MIN = 60 * SEC
export const iso = (ms: number) => new Date(ms).toISOString()

export function view(over: Partial<NotifyView> = {}): NotifyView {
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

export function resolvedView(over: Partial<ResolvedView> = {}): ResolvedView {
  return {
    key: 'edge|EdgeDead',
    service: 'edge',
    rule: 'EdgeDead',
    summary: 'API edge dead',
    severity: 'page',
    origin: 'grafana',
    labels: {},
    startsAt: iso(T0),
    resolvedAt: iso(T0 + 30 * MIN),
    durationSec: 1800,
    stableForSec: 600,
    wasNotified: true,
    ...over
  }
}

export function route(over: Partial<RouteConfig> = {}): RouteConfig {
  return {
    id: 'r1',
    match: {},
    receivers: ['ntfy'],
    mode: 'all',
    groupWaitSec: 0,
    groupIntervalSec: 120,
    repeatIntervalSec: 1800,
    ...over
  }
}

export class MemStore implements NotifyStore {
  logs = new Map<string, LogRow>()
  results: ResultRow[] = []
  held = new Map<string, string[]>()
  getLog(key: string) {
    return this.logs.get(key) ?? null
  }
  putLog(row: LogRow) {
    this.logs.set(row.key, row)
  }
  listPending() {
    return [...this.logs.values()].filter((r) => r.closed === undefined && r.nextAttemptAt !== null)
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
  statuses(channelId?: string) {
    return this.results.filter((r) => channelId === undefined || r.channelId === channelId).map((r) => r.status)
  }
}

export interface FakeChannel extends Channel {
  sent: Message[]
  /** What the next sends answer; the last entry repeats. Empty: 200. */
  answers: Array<Partial<SendResult>>
}

export function fakeChannel(id: string, ...answers: Array<Partial<SendResult>>): FakeChannel {
  const ch: FakeChannel = {
    id,
    type: 'fake',
    sent: [],
    answers,
    async send(msg) {
      ch.sent.push(msg)
      const a = ch.answers.length === 0 ? {} : ch.answers[Math.min(ch.sent.length - 1, ch.answers.length - 1)]
      return { ok: true, status: '200', latencyMs: 4, ...a }
    }
  }
  return ch
}

export const failing = (status = '500', extra: Partial<SendResult> = {}): Partial<SendResult> => ({ ok: false, status, ...extra })

export interface Options {
  log?: (line: string) => void
  channels?: Channel[]
  quiet?: QuietHoursConfig | null
  timing?: Partial<LadderTiming>
  start?: number
  circuits?: CircuitBreaker
  /** The store to use; a fresh one by default. */
  store?: MemStore
}

export function harness(routes: RouteConfig[], opts: Options = {}) {
  const clock = { t: opts.start ?? T0 }
  const channels = opts.channels ?? [fakeChannel('ntfy'), fakeChannel('sms'), fakeChannel('webpush')]
  const store = opts.store ?? new MemStore()
  const notifier = createNotifier({
    routes,
    channels: new Map(channels.map((c) => [c.id, c])),
    quiet: opts.quiet ?? null,
    store,
    now: () => clock.t,
    baseUrl: 'https://watch.example',
    ackSecret: 'test-ack-secret',
    log: opts.log,
    circuits: opts.circuits,
    timing: {
      sleep: async (ms) => {
        clock.t += ms
      },
      ...opts.timing
    }
  })
  const tickAt = (t: number, views: NotifyView[], resolved: ResolvedView[] = []) => {
    clock.t = t
    return notifier.tick(views, resolved)
  }
  const by = <T extends Channel = FakeChannel>(id: string) => channels.find((c) => c.id === id) as T
  return { clock, store, notifier, tickAt, by }
}

export const aKey = (receiver = 'ntfy', routeId = 'r1', stage = 'alert', incident = 'edge|EdgeDead') => logKey(incident, routeId, receiver, stage)
