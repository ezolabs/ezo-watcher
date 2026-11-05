// The hosted demo's in-browser Watcher (src/web/demo/watcher.ts, install.ts) over the committed recording: it answers every /api request the
// wall makes, a visitor's acknowledgement changes the next /api/state (and its ETag), and times sit where a visitor expects them.

import { describe, expect, it } from 'vitest'
import recordingJson from '../src/web/demo/fixtures/recording.json'
import { SESSION_KEY, demoFetch } from '../src/web/demo/install.ts'
import { DemoWatcher, EPOCH_WINDOW_MS, type DemoResponse, type DemoSession, type Recording } from '../src/web/demo/watcher.ts'
import type { HistoryRow, Incident, WallState } from '../src/shared/types.ts'
import type { IncidentDetail, NotificationsInfo } from '../src/web/lib/api.ts'

const recording = recordingJson as unknown as Recording
const RECORDED = Date.parse(recording.recordedAt)
const OPENED = Date.parse('2027-03-14T09:26:53.000Z')

function demo(acts: DemoSession['acts'] = []) {
  const clock = { now: OPENED }
  const session: DemoSession = { anchorMs: OPENED, acts }
  const w = new DemoWatcher(recording, session, () => clock.now)
  const call = (method: string, path: string, body?: unknown, headers?: Record<string, string>): DemoResponse => w.handle({ method, path, body, headers })
  const json = <T>(r: DemoResponse): T => JSON.parse(r.body as string) as T
  return { clock, session, w, call, json }
}

const byService = (s: WallState, service: string): Incident => s.incidents.find((i) => i.service === service) as Incident
const PAGE = 'Checkout API'

describe('the demo Watcher', () => {
  it('answers every endpoint the wall calls', () => {
    const { call, json } = demo()
    const state = call('GET', '/api/state')
    expect(state.status).toBe(200)
    expect(state.headers.etag).toMatch(/^W\/".+"$/)
    expect(Date.parse(state.headers['x-server-time'])).toBe(OPENED)
    const wall = json<WallState>(state)
    expect(wall.incidents.map((i) => `${i.severity}/${i.state.attention}`).sort()).toEqual(['page/none', 'warning/acked', 'warning/none', 'warning/parked'])
    expect(wall.health.length).toBeGreaterThanOrEqual(15)

    expect(json<{ brand: { name: string } }>(call('GET', '/api/instance')).brand.name).toBeTruthy()
    const week = json<{ rows: HistoryRow[] }>(call('GET', '/api/history?hours=168')).rows
    const day = json<{ rows: HistoryRow[] }>(call('GET', '/api/history?hours=24')).rows
    expect(week.length).toBeGreaterThan(day.length)
    expect(day.length).toBeGreaterThan(0)
    const notes = json<NotificationsInfo>(call('GET', '/api/notifications'))
    expect(notes.channels.length).toBe(4)
    expect(notes.results.length).toBeGreaterThan(10)

    for (const i of wall.incidents) {
      const detail = call('GET', `/api/incidents/${encodeURIComponent(i.key)}`)
      expect(detail.status, i.key).toBe(200)
      expect(json<IncidentDetail>(detail).incident?.key).toBe(i.key)
    }
    // a resolved incident's sheet: no live incident, its alerts and history
    for (const r of week) {
      const detail = json<IncidentDetail>(call('GET', `/api/incidents/${encodeURIComponent(r.incidentKey)}`))
      expect(detail.alerts.length, r.incidentKey).toBeGreaterThan(0)
      expect(detail.events.length, r.incidentKey).toBeGreaterThan(0)
    }
    const recheck = json<{ at: string; sources: unknown[] }>(call('POST', '/api/recheck'))
    expect(Date.parse(recheck.at)).toBe(OPENED)
    expect(recheck.sources.length).toBeGreaterThan(0)
    for (const a of wall.incidents.flatMap((i) => i.alerts)) {
      expect(call('POST', `/api/recheck/${encodeURIComponent(a.key)}`).status, a.key).toBe(200)
    }
    const test = json<{ ok: boolean }>(call('POST', '/api/notifications/test', { channel: notes.channels[0].id }))
    expect(test.ok).toBe(true)
    expect(call('POST', '/api/push/subscribe', {}).status).toBe(501)
    expect(call('GET', '/api/fleet').status).toBe(503)
    const unknown = call('GET', '/api/nothing-here')
    expect(unknown.status).toBe(404)
    expect(json<{ error: string }>(unknown).error).toBe('not found')
  })

  it('answers what an agent reads about a firing incident', () => {
    const { call, json } = demo()
    const page = byService(json<WallState>(call('GET', '/api/state')), PAGE)
    const key = encodeURIComponent(page.key)
    expect(call('GET', `/api/incidents/${key}/fix-context`).status).toBe(200)
    expect(call('GET', `/api/incident-card/${key}`).status).toBe(200)
    expect(call('GET', `/api/alerts/${encodeURIComponent(page.alerts[0].key)}`).status).toBe(200)
    expect(Date.parse(json<{ at: string }>(call('POST', `/api/incidents/${key}/recheck`, {})).at)).toBe(OPENED)
    expect(call('POST', `/api/incidents/${key}/verify`, {}).status).toBe(200)
    expect(call('GET', '/api/doctor').status).toBe(200)
  })

  it('moves the recording so it ends the moment the visitor opens the demo', () => {
    const { call, json } = demo()
    const page = byService(json<WallState>(call('GET', '/api/state')), PAGE)
    const recorded = recording.state.incidents.find((i) => i.service === PAGE) as Incident
    expect(OPENED - Date.parse(page.startsAt)).toBe(RECORDED - Date.parse(recorded.startsAt))
    expect(page.state.unattendedSinceMs).toBe((recorded.state.unattendedSinceMs as number) + (OPENED - RECORDED))
  })

  it('an acknowledgement changes the next /api/state, its ETag and the sheet, and undo puts it back', () => {
    const { clock, call, json } = demo()
    const before = call('GET', '/api/state')
    const page = byService(json<WallState>(before), PAGE)
    expect(call('GET', '/api/state', undefined, { 'if-none-match': before.headers.etag }).status).toBe(304)

    clock.now += 4_000
    expect(call('POST', `/api/incidents/${encodeURIComponent(page.key)}/ack`, { by: 'Robin' }).status).toBe(200)
    const after = call('GET', '/api/state', undefined, { 'if-none-match': before.headers.etag })
    expect(after.status).toBe(200)
    expect(after.headers.etag).not.toBe(before.headers.etag)
    const wall = json<WallState>(after)
    const acked = byService(wall, PAGE)
    expect(acked.state.attention).toBe('acked')
    expect(acked.ackedBy).toBe('Robin')
    expect(acked.nextStep).toBeNull()
    expect(wall.header.acknowledged).toBe(json<WallState>(before).header.acknowledged + 1)
    const detail = json<IncidentDetail>(call('GET', `/api/incidents/${encodeURIComponent(page.key)}`))
    expect(detail.events[0]).toMatchObject({ kind: 'ack', detail: { by: 'Robin' } })

    call('POST', `/api/incidents/${encodeURIComponent(page.key)}/unack`, { by: 'Robin' })
    expect(byService(json<WallState>(call('GET', '/api/state')), PAGE).state.attention).toBe('none')
  })

  it('a silence holds until it runs out', () => {
    const { clock, call, json } = demo()
    const page = byService(json<WallState>(call('GET', '/api/state')), PAGE)
    expect(json<{ minutes: number }>(call('POST', `/api/incidents/${encodeURIComponent(page.key)}/silence`, { by: 'Robin', minutes: 30 })).minutes).toBe(30)
    expect(byService(json<WallState>(call('GET', '/api/state')), PAGE).state.attention).toBe('silenced')
    clock.now += 31 * 60_000
    const later = byService(json<WallState>(call('GET', '/api/state')), PAGE)
    expect(later.state.attention).toBe('none')
    expect(later.silencedUntil).toBeNull()
  })

  it('parks and ends a park as the engine does', () => {
    const { call, json } = demo()
    const wall = json<WallState>(call('GET', '/api/state'))
    const parked = byService(wall, 'Payments')
    expect(parked.state.attention).toBe('parked')
    expect(call('POST', `/api/incidents/${encodeURIComponent(parked.key)}/unpark`, { by: 'Robin' }).status).toBe(200)
    expect(byService(json<WallState>(call('GET', '/api/state')), 'Payments').state.attention).toBe('none')
    expect(call('POST', `/api/incidents/${encodeURIComponent(parked.key)}/unpark`, { by: 'Robin' }).status).toBe(409)

    const page = byService(wall, PAGE)
    expect(call('POST', `/api/incidents/${encodeURIComponent(page.key)}/park`, { state: 'sometime' }).status).toBe(400)
    const until = new Date(OPENED + 3_600_000).toISOString()
    expect(call('POST', `/api/incidents/${encodeURIComponent(page.key)}/park`, { by: 'Robin', state: 'deferred', until, note: 'after the freeze' }).status).toBe(200)
    expect(byService(json<WallState>(call('GET', '/api/state')), PAGE).state.attention).toBe('parked')
  })

  it('a re-check polls what it names: those sources answered just now, and a second press inside the gap polls nothing', () => {
    const { clock, call, json } = demo()
    clock.now += 7 * 60_000
    const first = json<{ sources: Array<{ id: string; ran: boolean; ok: boolean }> }>(call('POST', '/api/recheck'))
    const polled = first.sources.filter((s) => s.ran && s.ok).map((s) => s.id)
    expect(polled.length).toBeGreaterThan(0)
    const sources = json<WallState>(call('GET', '/api/state')).sources
    for (const id of polled) expect(Date.parse(sources.find((s) => s.id === id)?.lastOk ?? ''), id).toBe(clock.now)
    clock.now += 3_000
    const again = json<{ sources: Array<{ ran: boolean; throttled: boolean }> }>(call('POST', '/api/recheck'))
    expect(again.sources.every((s) => !s.ran && s.throttled)).toBe(true)
  })

  it("replays a session's acts, so a reload keeps what the visitor did", () => {
    const first = demo()
    const page = byService(first.json<WallState>(first.call('GET', '/api/state')), PAGE)
    first.call('POST', `/api/incidents/${encodeURIComponent(page.key)}/ack`, { by: 'Robin' })
    const again = demo(JSON.parse(JSON.stringify(first.session.acts)) as DemoSession['acts'])
    expect(byService(again.json<WallState>(again.call('GET', '/api/state')), PAGE).ackedBy).toBe('Robin')
  })
})

describe('the demo fetch', () => {
  it('answers /api on its origin, passes everything else through, and keeps the session', async () => {
    const kept = new Map<string, string>()
    const store = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) }
    const passed: string[] = []
    const f = demoFetch({
      recording,
      store,
      origin: 'https://demo.example',
      now: () => OPENED,
      fetch: (async (input: RequestInfo | URL) => {
        passed.push(String(input))
        return new Response('asset')
      }) as typeof fetch
    })
    const state = (await (await f('/api/state')).json()) as WallState
    expect(passed).toEqual([])
    const page = byService(state, PAGE)
    const ack = await f(`/api/incidents/${encodeURIComponent(page.key)}/ack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by: 'Robin' }) })
    expect(ack.status).toBe(200)
    expect(JSON.parse(kept.get(SESSION_KEY) as string)).toMatchObject({ anchorMs: OPENED, acts: [{ kind: 'ack', by: 'Robin' }] })
    expect(await (await f('/favicon.svg')).text()).toBe('asset')
    expect(passed).toEqual(['/favicon.svg'])
  })
})

describe('the recording', () => {
  it('holds epoch-ms numbers only under time keys, so moving them moves nothing else', () => {
    const TIME_KEYS = new Set(['at', 'unattendedSinceMs', 'validToMs'])
    const odd: string[] = []
    const walk = (v: unknown, key: string): void => {
      if (typeof v === 'number' && Math.abs(v - RECORDED) <= EPOCH_WINDOW_MS && !TIME_KEYS.has(key)) odd.push(`${key}=${v}`)
      else if (Array.isArray(v)) v.forEach((x) => walk(x, key))
      else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k)
    }
    walk(recording, '')
    expect(odd).toEqual([])
  })

  it('names nothing of a real machine or network', () => {
    const text = JSON.stringify(recording)
    for (const s of ['localhost', '127.0.0.1', '/Users/', '/home/', 'C:\\\\']) expect(text, s).not.toContain(s)
    const hosts = new Set(text.match(/https?:\/\/[a-z0-9.-]+/gi)?.map((u) => new URL(u).hostname))
    expect([...hosts].filter((h) => !h.endsWith('.example') && h !== 'rdap.org')).toEqual([])
  })
})
