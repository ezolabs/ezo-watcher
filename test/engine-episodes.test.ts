// An incident's episodes: a re-fired incident starts unacknowledged (the attention row outlives the episode it was written in), a silence is
// kept until it runs out and is marked as carried over, a manual resolve leaves the wall and reopens when the source still reports the alert,
// a confirmation needs a resolve the source backs, and comments belong to an incident and outlive its episodes. Written, not run, in the session
// that added it (checks were off).
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'
import { makeAlert } from '../src/server/derive.ts'
import type { AlertDraft } from '../src/server/derive.ts'
import type { WatchConfig } from '../src/server/config.ts'
import { SqliteNotifyStore } from '../src/server/stores.ts'
import { planSends } from '../src/server/notify/plan.ts'
import type { Alert, Observation } from '../src/shared/types.ts'
import type { NoteKind } from '../src/shared/agent.ts'

const T0 = Date.parse('2026-10-15T12:00:00Z')
let clock = T0
const iso = (ms = clock): string => new Date(ms).toISOString()

const cfg: WatchConfig = {
  baseUrl: 'https://watch.test',
  port: 0,
  host: '127.0.0.1',
  dataDir: ':memory:',
  historyHours: 24,
  staleAfterMisses: 3,
  sources: [{ id: 'grafana', type: 'grafana', url: 'http://g', tokenEnv: 'X', pollSec: 10 }],
  serviceMap: [],
  channels: [],
  routes: [{ id: 'page', match: { severity: ['page'] }, receivers: ['ntfy'], mode: 'all', groupWaitSec: 0, groupIntervalSec: 60, repeatIntervalSec: 3600, escalate: [{ afterSec: 600, receivers: ['ntfy'] }] }],
  quietHours: null
}

const draft = (over: Partial<AlertDraft> = {}): AlertDraft => ({
  origin: 'grafana',
  fingerprint: over.fingerprint ?? 'a1b2c3d4e5f60718',
  rule: 'API edge dead',
  labels: { alertname: 'API edge dead', component: 'edge', severity: 'page', instance: 'edge-1:9100' },
  annotations: { summary: 'No http_events for 5 minutes' },
  startsAt: over.startsAt ?? iso(clock - 60_000),
  via: { source: 'grafana', kind: 'grafana', lastSeen: iso() },
  raw: {},
  links: {}
})
const alert = (d: AlertDraft = draft()): Alert => makeAlert(d, cfg.serviceMap, iso())
const poll = (firing: Alert[]): Observation => ({ source: 'grafana', kind: 'grafana', at: iso(), firing, resolved: [], complete: true })

let engine: Engine
beforeEach(() => {
  clock = T0
  engine = new Engine(openDb(':memory:'), cfg, () => clock)
})

function fire(): string {
  engine.ingest(poll([alert()]))
  return engine.wall().incidents[0].key
}

describe('a new episode starts unattended', () => {
  it('a re-fired incident is unacknowledged and pages again, and History keeps the old ack', () => {
    const key = fire()
    engine.ack(key, 'Dana')
    clock += 60_000
    engine.ingest(poll([]))
    expect(engine.wall().incidents).toHaveLength(0)
    // Long enough after the clear to be a new episode, not a flap: the engine's flap window (FLAP_WINDOW_MS, 30 minutes, in engine.ts and not exported) holds
    // fewer than three fire/clear edges by now, so the page below is planned as an alert. The view's `flapping` flag is asserted so a window that grows past this gap fails loudly.
    clock += 2 * 3600_000
    engine.ingest(poll([alert(draft({ startsAt: iso() }))]))
    const again = engine.wall().incidents[0]
    expect(again.state.attention).toBe('none')
    expect(again.ackedBy).toBeNull()
    expect(again.ackedAt).toBeNull()
    const view = engine.notifyViews().views[0]
    expect(view.attention).toBe('none')
    expect(view.flapping).toBe(false)
    // nothing about the first episode's ack is read by the pager: an unattended page is planned for the route's receivers
    const sends = planSends({ routes: cfg.routes, views: [view], resolved: [], nowMs: clock, quiet: false, getLog: () => null, getHeld: () => [] }).sends
    expect(sends.map((s) => s.kind)).toContain('alert')
    // the first episode's ack is still in History
    expect(engine.history(24)[0].ackedBy).toBe('Dana')
  })

  it('keeps an unexpired silence across episodes and says it was set on the previous one', () => {
    const key = fire()
    engine.silence(key, 240, 'agent: claude', 'planned reboot')
    expect(engine.wall().incidents[0].silenceCarried).toBe(false)
    clock += 60_000
    engine.ingest(poll([]))
    clock += 60_000
    engine.ingest(poll([alert(draft({ startsAt: iso() }))]))
    const again = engine.wall().incidents[0]
    expect(again.state.attention).toBe('silenced')
    expect(again.silencedBy).toBe('agent: claude')
    expect(again.silenceCarried).toBe(true)
    clock += 60_000
    engine.silence(key, 30, 'agent: claude', 'still rebooting')
    expect(engine.wall().incidents[0].silenceCarried).toBe(false)
  })
})

describe('resolve by hand', () => {
  it('takes the incident off the wall, says who and why in History, and is not a resolved notice', () => {
    const key = fire()
    engine.ack(key, 'agent: claude')
    const r = engine.resolveManual(key, 'agent: claude', 'fixed in 1a2b3c4')
    expect(r).toMatchObject({ ok: true, alerts: 1 })
    expect(engine.wall().incidents).toHaveLength(0)
    expect(engine.history(24)[0].manual).toEqual({ by: 'agent: claude', reason: 'fixed in 1a2b3c4' })
    expect(engine.notifyViews().resolved).toEqual([])
    // the source still reports it: the Sources page does not count it as firing
    expect(engine.sources().find((s) => s.id === 'grafana')?.firing).toBe(0)
  })

  it('refuses an incident that is not firing', () => {
    expect(engine.resolveManual('nothing|here', 'agent: claude', 'x')).toEqual({ ok: false, error: 'not firing' })
  })

  it('reopens as a new firing when the source still reports the alert: unacknowledged, recorded, the log cleared, the thread told', () => {
    const key = fire()
    engine.ack(key, 'agent: claude')
    const notes: Array<{ key: string; kind: NoteKind; by: string; text: string }> = []
    engine.onNote = (k, kind, by, text) => notes.push({ key: k, kind, by, text })
    const store = new SqliteNotifyStore(engine.db)
    store.putLog({ key: `${key}|page|ntfy|alert`, sentAt: clock, digest: 'd', ok: true, attempts: 0, nextAttemptAt: null })
    engine.resolveManual(key, 'agent: claude', 'fixed in 1a2b3c4')
    clock += 10_000
    engine.ingest(poll([alert(draft({ startsAt: iso(T0 - 60_000) }))]))
    const again = engine.wall().incidents[0]
    expect(again.key).toBe(key)
    expect(again.state.attention).toBe('none')
    expect(again.ackedBy).toBeNull()
    const events = engine.incidentDetail(key).events
    const reopened = events.find((e) => e.kind === 'reopened')
    expect(reopened?.detail).toMatchObject({ by: 'agent: claude', reason: 'fixed in 1a2b3c4', text: 'reopened: source still firing after manual resolve by agent: claude' })
    expect(store.getLog(`${key}|page|ntfy|alert`)).toBeNull()
    expect(notes).toEqual([{ key, kind: 'reopened', by: 'agent: claude', text: 'fixed in 1a2b3c4' }])
  })

  it('does not reopen when the source stops reporting, and a later firing is an ordinary new one', () => {
    const key = fire()
    engine.resolveManual(key, 'agent: claude', 'fixed')
    clock += 10_000
    engine.ingest(poll([]))
    clock += 3600_000
    engine.ingest(poll([alert(draft({ startsAt: iso() }))]))
    expect(engine.wall().incidents).toHaveLength(1)
    expect(engine.incidentDetail(key).events.some((e) => e.kind === 'reopened')).toBe(false)
  })
})

describe('confirm a resolution', () => {
  it('is refused while the incident fires, and for an incident that never resolved', () => {
    const key = fire()
    expect(engine.confirmResolution(key, 'agent: claude', '')).toMatchObject({ ok: false })
    expect(engine.confirmResolution('nothing|here', 'agent: claude', '')).toMatchObject({ ok: false })
  })

  it('records who and the note for an incident its source resolved, and History carries it', () => {
    const key = fire()
    clock += 60_000
    engine.ingest(poll([]))
    const r = engine.confirmResolution(key, 'agent: claude', 'PR 4821 merged')
    expect(r).toMatchObject({ ok: true })
    expect(engine.history(24)[0].confirmed).toMatchObject({ by: 'agent: claude', note: 'PR 4821 merged' })
  })

  it('is refused after a manual resolve while a source still reports the alert, and allowed once it stops', () => {
    const key = fire()
    engine.resolveManual(key, 'agent: claude', 'fixed')
    expect(engine.confirmResolution(key, 'agent: claude', '')).toMatchObject({ ok: false })
    clock += 10_000
    engine.ingest(poll([]))
    expect(engine.confirmResolution(key, 'agent: claude', 'source agrees')).toMatchObject({ ok: true })
  })
})

describe('comments', () => {
  it('belong to an incident, firing or resolved, oldest first, and an unknown incident has none', () => {
    const key = fire()
    expect(engine.comment('nothing|here', 'agent: claude', 'x')).toBeNull()
    const a = engine.comment(key, 'agent: claude', 'looking at the edge deploy')
    clock += 1000
    const b = engine.comment(key, 'agent: codex', 'fix is [1a2b3c4](https://example.test/c/1a2b3c4)')
    expect(a?.id).toBeLessThan(b?.id ?? 0)
    clock += 60_000
    engine.ingest(poll([]))
    expect(engine.comments(key).map((c) => c.by)).toEqual(['agent: claude', 'agent: codex'])
    expect(engine.incidentDetail(key).comments).toHaveLength(2)
    expect(engine.commentCounts([key, 'x|y'])).toEqual(new Map([[key, 2], ['x|y', 0]]))
  })
})
