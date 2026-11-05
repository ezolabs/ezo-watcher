import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/server/config.ts'
import type { RouteConfig } from '../src/server/config.ts'
import { COALESCE_MAX_PAGES, COALESCE_WINDOW_SEC, coalesceLimits, parseSummaryId, summaryId } from '../src/server/notify/coalesce.ts'
import { createNotifier } from '../src/server/notify/notifier.ts'
import type { NotifyView } from '../src/server/notify/types.ts'
import { MIN, MemStore, SEC, T0, failing, fakeChannel, harness, iso, route, view } from './notify-helpers.ts'
import type { FakeChannel } from './notify-helpers.ts'

const ORIGIN = 'webhook'

/** The n-th page incident of an origin; each first seen a second after the one before (all of them before the first tick), so the order they were seen in is the order of n. */
function page(n: number, over: Partial<NotifyView> = {}): NotifyView {
  const key = `API router|spike-${String(n).padStart(3, '0')}`
  return view({
    key,
    service: 'API router',
    rule: `spike-${n}`,
    summary: `Request spike ${n}`,
    origin: ORIGIN,
    firstSeen: iso(T0 - 300 * SEC + n * SEC),
    startsAt: iso(T0 - 300 * SEC + n * SEC),
    instances: [{ fingerprint: `fp${n}`, name: `host-${n}`, value: '1', startsAt: iso(T0 - 300 * SEC + n * SEC) }],
    ...over
  })
}
const pages = (from: number, to: number, over: Partial<NotifyView> = {}) => Array.from({ length: to - from + 1 }, (_, i) => page(from + i, over))

const pageRoute = (over: Partial<RouteConfig> = {}) =>
  route({ mode: 'ladder', receivers: ['ntfy', 'webpush'], record: ['chat-alerts'], escalate: [{ afterSec: 600, receivers: ['sms'] }, { afterSec: 3600, receivers: ['email'] }], ...over })

function setup(over: Partial<RouteConfig> = {}, extra: { store?: MemStore } = {}) {
  const channels = ['ntfy', 'webpush', 'sms', 'email', 'chat-alerts'].map((id) => fakeChannel(id))
  const h = harness([pageRoute(over)], { channels, store: extra.store })
  const sent = (id: string) => h.by<FakeChannel>(id).sent
  const kinds = (id: string) => sent(id).map((m) => m.kind)
  return { h, sent, kinds }
}

const SUMMARY_AT_START = summaryId('r1', ORIGIN, T0)

describe('the defaults', () => {
  it('are 10 pages in 600 s, and a route with no knob uses them', () => {
    expect([COALESCE_MAX_PAGES, COALESCE_WINDOW_SEC]).toEqual([10, 600])
    expect(coalesceLimits(route())).toEqual({ maxPages: 10, windowMs: 600_000 })
    expect(coalesceLimits(route({ coalesce: { maxPages: 3, windowSec: 120 } }))).toEqual({ maxPages: 3, windowMs: 120_000 })
    expect(coalesceLimits(route({ coalesce: { maxPages: 0 } }))).toBeNull()
    expect(coalesceLimits(route({ receivers: [] }))).toBeNull()
  })

  it('a summary id names the route, the origin and when its window opened, and reads back', () => {
    expect(SUMMARY_AT_START).toBe('summary:r1:webhook@2026-10-20T12:00:00.000Z')
    expect(parseSummaryId(SUMMARY_AT_START)).toEqual({ routeId: 'r1', origin: ORIGIN, startMs: T0 })
    expect(parseSummaryId('edge|EdgeDead')).toBeNull()
  })
})

describe('an existing route without the knob', () => {
  it('behaves as before for fewer than 10 pages: every one goes out on its own, nothing is held back, no summary', async () => {
    const { h, sent } = setup()
    const rows = await h.tickAt(T0 + 30 * SEC, pages(1, 9))
    expect(sent('ntfy')).toHaveLength(9)
    expect(sent('chat-alerts')).toHaveLength(9)
    expect(rows.filter((r) => r.status.startsWith('coalesced'))).toEqual([])
    await h.tickAt(T0 + 30 * SEC + 11 * MIN, pages(1, 9))
    expect(sent('ntfy').filter((m) => m.kind === 'summary')).toEqual([])
    expect(h.store.results.filter((r) => r.kind === 'summary')).toEqual([])
  })

  it('exactly 10 pages is still not a storm', async () => {
    const { h, sent } = setup()
    await h.tickAt(T0 + 30 * SEC, pages(1, 10))
    expect(sent('ntfy')).toHaveLength(10)
    await h.tickAt(T0 + 11 * MIN, pages(1, 10))
    expect(sent('ntfy').map((m) => m.kind)).not.toContain('summary')
  })

  it('maxPages 0 switches it off: 25 pages go out on their own', async () => {
    const { h, sent } = setup({ coalesce: { maxPages: 0 } })
    await h.tickAt(T0 + 30 * SEC, pages(1, 25))
    expect(sent('ntfy')).toHaveLength(25)
  })
})

describe('11 pages from one origin', () => {
  it('sends the first 10, holds the 11th with the summary id on its row, and tells the window once when it ends', async () => {
    const { h, sent } = setup()
    const rows = await h.tickAt(T0, pages(1, 11))
    expect(sent('ntfy')).toHaveLength(10)
    // the newest to be seen is the one held back
    expect(sent('ntfy').map((m) => m.tag)).not.toContain(page(11).key)
    const held = rows.filter((r) => r.status.startsWith('coalesced'))
    expect(held).toEqual([
      { at: T0, incidentKey: page(11).key, routeId: 'r1', channelId: 'ntfy', kind: 'alert', ok: false, status: `coalesced into ${SUMMARY_AT_START}`, latencyMs: 0 }
    ])
    expect(h.store.getLog(`${page(11).key}|r1|ntfy|alert`)).toMatchObject({ closed: `coalesced into ${SUMMARY_AT_START}`, ok: false, nextAttemptAt: null })
    expect(h.store.getLog(`${page(11).key}|r1|webpush|alert`)).toMatchObject({ closed: `coalesced into ${SUMMARY_AT_START}` })

    // the window is still open: nothing more goes out, however many ticks
    for (let t = T0 + 5 * SEC; t < T0 + 10 * MIN; t += 30 * SEC) await h.tickAt(t, pages(1, 11))
    expect(sent('ntfy')).toHaveLength(10)

    const end = await h.tickAt(T0 + 10 * MIN, pages(1, 11))
    expect(sent('ntfy')).toHaveLength(11)
    const summary = sent('ntfy')[10]
    expect(summary.kind).toBe('summary')
    expect(summary.title).toBe('webhook: 1 more page in 10 min, see the wall')
    expect(summary.url).toBe('https://watch.example/')
    expect(summary.tag).toBe(SUMMARY_AT_START)
    expect(summary.ackUrl).toBeUndefined()
    expect(end.filter((r) => r.kind === 'summary').map((r) => [r.channelId, r.ok, r.incidentKey])).toEqual([['ntfy', true, SUMMARY_AT_START], ['chat-alerts', true, SUMMARY_AT_START]])
    // the same receivers get it: the ladder's first, and the record channel a copy
    expect(sent('chat-alerts').at(-1)?.kind).toBe('summary')
    expect(sent('webpush')).toHaveLength(0)

    // once per window
    await h.tickAt(T0 + 10 * MIN + 5 * SEC, pages(1, 11))
    await h.tickAt(T0 + 20 * MIN, pages(1, 11))
    expect(sent('ntfy').filter((m) => m.kind === 'summary')).toHaveLength(1)
  })
})

describe('25 pages from one origin', () => {
  it('sends 10, holds 15, and sends one summary: "webhook: 15 more pages in 10 min, see the wall"', async () => {
    const { h, sent } = setup()
    const rows = await h.tickAt(T0, pages(1, 25))
    expect(sent('ntfy')).toHaveLength(10)
    expect(sent('ntfy').map((m) => m.tag)).toEqual(pages(1, 10).map((v) => v.key))
    expect(rows.filter((r) => r.status === `coalesced into ${SUMMARY_AT_START}`)).toHaveLength(15)
    await h.tickAt(T0 + 10 * MIN, pages(1, 25))
    const summaries = sent('ntfy').filter((m) => m.kind === 'summary')
    expect(summaries).toHaveLength(1)
    expect(summaries[0].title).toBe('webhook: 15 more pages in 10 min, see the wall')
    expect(summaries[0].body.split('\n')[0]).toBe('15 of them are still firing with nobody on them.')
    expect(summaries[0].body).toContain('Request spike 11')
    expect(summaries[0].url).toBe('https://watch.example/')
    // the held pages are each on the wall and in the log; none of them was sent on its own
    expect(sent('ntfy').filter((m) => m.kind === 'alert')).toHaveLength(10)
  })

  it('holds a page that arrives while the window is open, in the same summary', async () => {
    const { h, sent } = setup()
    await h.tickAt(T0, pages(1, 12))
    const later = await h.tickAt(T0 + 2 * MIN, pages(1, 15))
    expect(later.filter((r) => r.status.startsWith('coalesced')).map((r) => r.status)).toEqual(Array(3).fill(`coalesced into ${SUMMARY_AT_START}`))
    await h.tickAt(T0 + 10 * MIN, pages(1, 15))
    expect(sent('ntfy').filter((m) => m.kind === 'summary').map((m) => m.title)).toEqual(['webhook: 5 more pages in 10 min, see the wall'])
  })
})

describe('the rolling window and a second window', () => {
  it('lets pages through again once the first ten are more than 10 minutes old, and opens a second summary window for the next storm', async () => {
    const { h, sent } = setup()
    await h.tickAt(T0, pages(1, 25))
    await h.tickAt(T0 + 10 * MIN, pages(1, 25))
    expect(sent('ntfy').filter((m) => m.kind === 'summary')).toHaveLength(1)

    // 11 minutes in the 10 pages of the first window have aged out of the rolling window: 5 new pages go out on their own
    const t2 = T0 + 11 * MIN
    const calm = await h.tickAt(t2, [...pages(1, 25), ...pages(26, 30)])
    expect(calm.filter((r) => r.status.startsWith('coalesced'))).toEqual([])
    expect(sent('ntfy').filter((m) => m.kind === 'alert')).toHaveLength(15)

    // a second storm: 15 more at once. The 5 just sent still count, so room for 5, and the other 10 start a second window
    const second = await h.tickAt(t2 + 5 * SEC, [...pages(1, 30), ...pages(31, 45)])
    const secondId = summaryId('r1', ORIGIN, t2 + 5 * SEC)
    expect(second.filter((r) => r.status.startsWith('coalesced')).map((r) => r.status)).toEqual(Array(10).fill(`coalesced into ${secondId}`))
    expect(secondId).not.toBe(SUMMARY_AT_START)
    await h.tickAt(t2 + 5 * SEC + 10 * MIN, pages(1, 45))
    const summaries = sent('ntfy').filter((m) => m.kind === 'summary')
    expect(summaries.map((m) => m.title)).toEqual([
      'webhook: 15 more pages in 10 min, see the wall',
      'webhook: 10 more pages in 10 min, see the wall'
    ])
    expect(summaries.map((m) => m.tag)).toEqual([SUMMARY_AT_START, secondId])
  })

  it('counts 10 pages per origin: another origin has its own budget, and a warning is not a page', async () => {
    const { h, sent } = setup()
    const other = pages(101, 110, { origin: 'grafana' })
    const rows = await h.tickAt(T0, [...pages(1, 10), ...other])
    expect(sent('ntfy')).toHaveLength(20)
    expect(rows.filter((r) => r.status.startsWith('coalesced'))).toEqual([])
  })

  it('follows the knob: 3 pages in 2 minutes', async () => {
    const { h, sent } = setup({ coalesce: { maxPages: 3, windowSec: 120 } })
    await h.tickAt(T0, pages(1, 5))
    expect(sent('ntfy')).toHaveLength(3)
    await h.tickAt(T0 + 119 * SEC, pages(1, 5))
    expect(sent('ntfy')).toHaveLength(3)
    await h.tickAt(T0 + 120 * SEC, pages(1, 5))
    expect(sent('ntfy').at(-1)?.title).toBe('webhook: 2 more pages in 2 min, see the wall')
  })

  it('a page that is being retried was let through when it first went out: it is not held back on the retry', async () => {
    const channels = ['ntfy', 'webpush', 'sms', 'email', 'chat-alerts'].map((id) => (id === 'ntfy' || id === 'webpush' ? fakeChannel(id, failing('500')) : fakeChannel(id)))
    const h = harness([pageRoute()], { channels })
    await h.tickAt(T0, pages(1, 12))
    const ntfy = h.by<FakeChannel>('ntfy')
    const firstRound = ntfy.sent.length
    expect(h.store.results.filter((r) => r.status.startsWith('coalesced'))).toHaveLength(2)
    await h.tickAt(T0 + 60 * SEC, pages(1, 12))
    // the ten that went out are tried again; the two that were held stay held
    expect(ntfy.sent.length).toBe(firstRound * 2)
    expect(h.store.results.filter((r) => r.status.startsWith('coalesced'))).toHaveLength(2)
  })
})

describe('SMS and email follow the summary, not each held page', () => {
  it('sends the escalation steps for the 10 pages that went out, and one for the summary', async () => {
    const { h, sent } = setup()
    await h.tickAt(T0, pages(1, 12))
    const unattended = pages(1, 12).map((v) => ({ ...v, unattendedSec: 600 }))
    await h.tickAt(T0 + 10 * MIN, unattended)
    const sms = sent('sms')
    // 10 individual escalations, none for the two held pages, and the summary's own
    expect(sms.filter((m) => m.tag.startsWith('API router|'))).toHaveLength(10)
    expect(sms.map((m) => m.tag)).not.toContain(page(11).key)
    expect(sms.map((m) => m.tag)).not.toContain(page(12).key)
    const summarySms = sms.filter((m) => m.tag === SUMMARY_AT_START)
    expect(summarySms).toHaveLength(1)
    expect(summarySms[0].kind).toBe('escalation')
    expect(summarySms[0].title).toBe('Escalated: webhook: 2 more pages in 10 min, see the wall')
    expect(summarySms[0].body).toContain('at the longest')
  })

  it('goes to email at the second step, once, for the summary', async () => {
    const { h, sent } = setup()
    await h.tickAt(T0, pages(1, 14))
    await h.tickAt(T0 + 10 * MIN, pages(1, 14).map((v) => ({ ...v, unattendedSec: 3600 })))
    expect(sent('email').filter((m) => m.tag === SUMMARY_AT_START)).toHaveLength(1)
    expect(sent('email').map((m) => m.tag)).not.toContain(page(14).key)
  })

  it('has no escalation for a summary whose alerts are acknowledged', async () => {
    const { h, sent } = setup()
    await h.tickAt(T0, pages(1, 12))
    const attended = pages(1, 12).map((v) => (v.key === page(11).key || v.key === page(12).key ? { ...v, attention: 'acked' as const } : { ...v, unattendedSec: 600 }))
    await h.tickAt(T0 + 10 * MIN, attended)
    expect(sent('ntfy').filter((m) => m.kind === 'summary')).toHaveLength(0)
    expect(sent('sms').map((m) => m.tag)).not.toContain(SUMMARY_AT_START)
  })
})

describe('a summary that nobody needs', () => {
  it('is not sent when every held page cleared before the window ended', async () => {
    const { h, sent } = setup()
    await h.tickAt(T0, pages(1, 13))
    // the three held ones resolve; the ten that went out are still firing
    await h.tickAt(T0 + 10 * MIN, pages(1, 10))
    expect(sent('ntfy').filter((m) => m.kind === 'summary')).toEqual([])
  })
})

describe('the window survives a restart', () => {
  it('a new notifier on the same store sends the summary of a window the old one opened', async () => {
    const store = new MemStore()
    const first = setup({}, { store })
    await first.h.tickAt(T0, pages(1, 13))
    expect(first.sent('ntfy')).toHaveLength(10)

    const channels = ['ntfy', 'webpush', 'sms', 'email', 'chat-alerts'].map((id) => fakeChannel(id))
    const clock = { t: T0 + 4 * MIN }
    const restarted = createNotifier({
      routes: [pageRoute()],
      channels: new Map(channels.map((c) => [c.id, c])),
      quiet: null,
      store,
      now: () => clock.t,
      baseUrl: 'https://watch.example',
      ackSecret: 'x'
    })
    // 4 minutes in: the ten are still inside the rolling window, and a fourteenth page joins the open window
    await restarted.tick(pages(1, 14), [])
    expect(channels[0].sent).toEqual([])
    expect(store.results.filter((r) => r.status === `coalesced into ${SUMMARY_AT_START}`)).toHaveLength(4)
    clock.t = T0 + 10 * MIN
    await restarted.tick(pages(1, 14), [])
    expect((channels[0] as FakeChannel).sent.map((m) => m.title)).toEqual(['webhook: 4 more pages in 10 min, see the wall'])
  })
})

describe('a summary that fails', () => {
  it('is tried again like any send, and ends with the same abandoned status when it never lands', async () => {
    const channels = ['ntfy', 'webpush', 'sms', 'email', 'chat-alerts'].map((id) => (id === 'ntfy' || id === 'webpush' ? fakeChannel(id, failing('500')) : fakeChannel(id)))
    const h = harness([pageRoute()], { channels })
    await h.tickAt(T0, pages(1, 11))
    let t = T0 + 10 * MIN
    for (let i = 0; i < 8; i++) {
      await h.tickAt(t, pages(1, 11))
      t = Math.max(h.store.getLog(`${SUMMARY_AT_START}|r1|ntfy|summary`)?.nextAttemptAt ?? t, t + 1)
    }
    expect(h.store.getLog(`${SUMMARY_AT_START}|r1|ntfy|summary`)).toMatchObject({ closed: 'abandoned: max attempts' })
    expect(h.store.results.filter((r) => r.kind === 'summary' && r.status === 'abandoned: max attempts').length).toBeGreaterThan(0)
  })

  it('is dropped when its alerts were all acknowledged while it was waiting', async () => {
    const channels = ['ntfy', 'webpush', 'sms', 'email', 'chat-alerts'].map((id) => (id === 'ntfy' || id === 'webpush' ? fakeChannel(id, failing('500')) : fakeChannel(id)))
    const h = harness([pageRoute()], { channels })
    await h.tickAt(T0, pages(1, 11))
    await h.tickAt(T0 + 10 * MIN, pages(1, 11))
    expect(h.store.getLog(`${SUMMARY_AT_START}|r1|ntfy|summary`)).toMatchObject({ attempts: 1 })
    await h.tickAt(T0 + 10 * MIN + 6 * SEC, [...pages(1, 10), page(11, { attention: 'acked' })])
    expect(h.store.getLog(`${SUMMARY_AT_START}|r1|ntfy|summary`)).toMatchObject({ closed: 'abandoned: summary no longer owed' })
  })
})

describe('the coalesce knob in the config', () => {
  const withCoalesce = (coalesce: unknown) => {
    const cfg = JSON.parse(readFileSync(new URL('./fixtures/watch.config.json', import.meta.url), 'utf8')) as { routes: Array<Record<string, unknown>> }
    cfg.routes.find((r) => r.id === 'page')!.coalesce = coalesce
    const path = join(mkdtempSync(join(tmpdir(), 'watch-cfg-')), 'watch.json')
    writeFileSync(path, JSON.stringify(cfg))
    return path
  }

  it('config/watch.example.json names the page routes\' knob, 10 pages in 600 s', () => {
    const cfg = loadConfig(fileURLToPath(new URL('./fixtures/watch.config.json', import.meta.url)))
    for (const id of ['page', 'netdata-unreachable']) {
      expect(cfg.routes.find((r) => r.id === id)?.coalesce).toEqual({ maxPages: COALESCE_MAX_PAGES, windowSec: COALESCE_WINDOW_SEC })
    }
  })

  it('accepts a knob, and refuses one that is not a whole number in range', () => {
    expect(loadConfig(withCoalesce({ maxPages: 5, windowSec: 300 })).routes.find((r) => r.id === 'page')?.coalesce).toEqual({ maxPages: 5, windowSec: 300 })
    expect(loadConfig(withCoalesce({ maxPages: 0 })).routes.find((r) => r.id === 'page')?.coalesce).toEqual({ maxPages: 0 })
    for (const bad of [{ maxPages: 1.5 }, { maxPages: -1 }, { maxPages: '10' }, { windowSec: 30 }, { windowSec: 600.5 }, 'ten', [], null]) {
      expect(() => loadConfig(withCoalesce(bad)), JSON.stringify(bad)).toThrow(/route page: coalesce/)
    }
  })
})
