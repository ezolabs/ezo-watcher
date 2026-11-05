// The hosted demo's Watcher: answers every /api request the wall makes from a recording of a real Watcher (fixtures/recording.json, made by
// scripts/demo-record.mjs), in the visitor's browser, with no server behind it.
//
// Time: the recording ends at `recordedAt`; the visitor's session starts at `anchorMs`. Every time in the recording moves by the gap between the
// two, so the page that fired 21 minutes before the recording ended fired 21 minutes before the visitor opened the demo, and ages grow from
// there as the visitor stays. What a running Watcher keeps fresh (a source's last answer, a cell's last evaluation, a firing alert's last
// sighting) moves with the clock instead, a minute at a time, as its polls would.
//
// Actions: acknowledge, silence, undo and a channel test are acts. The session keeps them (install.ts holds them in sessionStorage), and every
// answer is the recording with the acts applied in order, through the same state function the engine uses (src/shared/incident.ts), so the
// tile, the header counts and the sheet's history move as they would on a real Watcher. Nothing leaves the browser.

import { REASON_MAX, checkOptionalText, checkPark } from '../../shared/agent.ts'
import { incidentState, incidentTitle } from '../../shared/incident.ts'
import { summaryOf } from '../../shared/summary.ts'
import type { AlertEvent, ChannelProof, HistoryRow, Incident, InstanceInfo, Park, WallState } from '../../shared/types.ts'
import type { AlertRecheck, WallRecheck } from '../../shared/recheck.ts'
import { actorName, cleanName } from '../../shared/who.ts'
import type { IncidentDetail, NotificationsInfo } from '../lib/api.ts'

export interface TestAnswer {
  ok: boolean
  status: string
  latencyMs: number
}

/** What scripts/demo-record.mjs saves: the answers of a real Watcher at the moment its recording ended. */
export interface Recording {
  recordedAt: string
  instance: InstanceInfo
  state: WallState
  incidents: Record<string, IncidentDetail>
  history: HistoryRow[]
  notifications: NotificationsInfo
  rechecks: {
    wall: WallRecheck
    alerts: Record<string, AlertRecheck>
    /** POST /api/incidents/:key/recheck, by incident. */
    incidents: Record<string, { at: string }>
    /** POST /api/incidents/:key/verify, by incident: nothing is fixed in the demo, so each timed out still firing. */
    verify: Record<string, { at: string }>
  }
  tests: Record<string, TestAnswer>
  /** What an agent or the CLI reads: the fix brief and the chat card by incident, each firing alert, the self-check. */
  agent: { fixContext: Record<string, unknown>; cards: Record<string, unknown>; alerts: Record<string, unknown>; doctor: unknown }
}

/** One thing the visitor did, at the visitor's clock. Kept in order; the answers are the recording with every act applied. */
export type DemoAct =
  | { kind: 'ack'; key: string; by: string; at: number }
  | { kind: 'unack'; key: string; by: string; at: number }
  | { kind: 'silence'; key: string; by: string; at: number; minutes: number }
  | { kind: 'park'; key: string; by: string; at: number; state: Park['state']; until: string; note: string; ref: string }
  | { kind: 'unpark'; key: string; by: string; at: number; note: string }
  | { kind: 'test'; channel: string; at: number }

/** The visitor's session: when it started and what was done in it. */
export interface DemoSession {
  anchorMs: number
  acts: DemoAct[]
}

export interface DemoRequest {
  method: string
  /** Path and query, as the page asked: "/api/history?hours=24". */
  path: string
  body?: unknown
  headers?: Record<string, string>
}

export interface DemoResponse {
  status: number
  headers: Record<string, string>
  /** JSON text, or null for a 304. */
  body: string | null
}

const MINUTE = 60_000
const DAY = 86_400_000
/** Numbers this close to `recordedAt` are times in epoch ms (a send's `at`, a certificate's `validToMs`); nothing else in a recording is this large. */
export const EPOCH_WINDOW_MS = 400 * DAY
/** The fields a running Watcher keeps refreshing: they track the visitor's clock instead of staying where the recording left them. */
export const FRESH_KEYS: ReadonlySet<string> = new Set(['generatedAt', 'lastOk', 'lastAttempt', 'evaluatedAt', 'lastSeen', 'lastReportedAt', 'oldestEvaluationAt'])
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z/g
const SILENCE_MAX_MIN = 24 * 60
const RECHECK_GAP_MS = 10_000

const isoAt = (ms: number): string => new Date(ms).toISOString()

/** Every time in `value` moved by `by` ms: ISO instants anywhere in a string (a heartbeat's detail names its due time), epoch-ms numbers near `centerMs`. */
export function shiftTimes<T>(value: T, by: number, centerMs: number): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.includes('T') ? v.replace(ISO, (m) => isoAt(Date.parse(m) + by)) : v
    if (typeof v === 'number') return Math.abs(v - centerMs) <= EPOCH_WINDOW_MS ? v + by : v
    if (Array.isArray(v)) return v.map(walk)
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value) as T
}

/** The FRESH_KEYS fields moved by `by` ms, except inside an object that has resolved: a resolved alert's last sighting stays where it was. */
export function refreshTimes<T>(value: T, by: number): T {
  if (by === 0) return value
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (v === null || typeof v !== 'object') return v
    const live = !('resolvedAt' in v) || (v as { resolvedAt: unknown }).resolvedAt == null
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, live && FRESH_KEYS.has(k) && typeof x === 'string' && x !== '' ? isoAt(Date.parse(x) + by) : walk(x)])
    )
  }
  return walk(value) as T
}

/** A short stable hash for the wall's ETag (FNV-1a, 32 bits). */
function hashOf(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** The fields of a recorded fix brief (src/server/mcp/fix-context.ts `FixContextBrief`) that say who has the incident: the visitor's acts move these. */
interface FixBrief {
  url: string
  state: { firing: boolean; attention: string; ackedBy: string | null; silencedUntil: string | null; parkedState: string | null; parkedUntil: string | null }
  ageSec: number
  related: Array<{ key: string; title: string; severity: string; attention: string; ageSec: number; url: string }>
}

/** The most related incidents a brief lists: `LIST_MAX` in src/server/mcp/fix-context.ts. */
const RELATED_MAX = 10

interface Attention {
  ackedBy: string | null
  ackedAt: string | null
  silencedUntil: string | null
  silencedBy: string | null
}

export class DemoWatcher {
  private readonly base: Recording
  private readonly session: DemoSession
  private readonly now: () => number
  private readonly attention = new Map<string, Attention>()
  private readonly added = new Map<string, AlertEvent[]>()
  private readonly tests: Array<{ channel: string; at: number; answer: TestAnswer }> = []
  private nextEventId: number
  private readonly lastRecheck = new Map<string, number>()
  /** When the visitor's re-checks last polled each source: its last answer is then, so the wall reads "Checked just now". */
  private readonly polledAt = new Map<string, number>()
  /** The park set by hand on each firing incident: the recorded one (the agent's), then whatever the visitor parks or ends. */
  private readonly parks = new Map<string, Park | null>()

  constructor(recording: Recording, session: DemoSession, now: () => number = Date.now) {
    const recordedMs = Date.parse(recording.recordedAt)
    this.base = shiftTimes(recording, session.anchorMs - recordedMs, recordedMs)
    this.session = session
    this.now = now
    this.nextEventId = 1 + Math.max(0, ...Object.values(this.base.incidents).flatMap((d) => d.events.map((e) => e.id)))
    for (const i of this.base.state.incidents) {
      this.attention.set(i.key, { ackedBy: i.ackedBy, ackedAt: i.ackedAt, silencedUntil: i.silencedUntil, silencedBy: i.silencedBy })
      this.parks.set(i.key, i.state.park?.by ? i.state.park : null)
    }
    for (const act of session.acts) this.apply(act)
  }

  /** Answer one request. Anything under /api this demo does not hold is a JSON 404, as a Watcher answers a route it does not have. */
  handle(req: DemoRequest): DemoResponse {
    const url = new URL(req.path, 'http://demo.invalid')
    const path = url.pathname.replace(/\/+$/, '')
    const method = req.method.toUpperCase()
    const body = (req.body !== null && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    const by = (): string => {
      const named = cleanName(body.by)
      return named !== '' && named.toLowerCase() !== 'wall' ? named : actorName(req.headers?.['x-watch-user'])
    }

    if (method === 'GET' && path === '/api/state') return this.wall(req.headers?.['if-none-match'] ?? null)
    if (method === 'GET' && path === '/api/instance') return this.json(200, this.base.instance)
    if (method === 'GET' && path === '/api/summary') return this.json(200, summaryOf(this.state()))
    if (method === 'GET' && path === '/api/history') {
      const asked = Number(url.searchParams.get('hours') ?? 168)
      const hours = Math.min(24 * 30, Math.max(1, Number.isFinite(asked) ? asked : 168))
      const since = this.now() - hours * 3_600_000
      return this.json(200, { hours, rows: this.base.history.filter((r) => Date.parse(r.resolvedAt) >= since) })
    }
    if (method === 'GET' && path === '/api/notifications') return this.json(200, this.notifications())
    if (method === 'POST' && path === '/api/notifications/test') {
      const channel = typeof body.channel === 'string' ? body.channel : ''
      if (!this.base.tests[channel]) return this.json(200, { ok: false, status: 'unknown', latencyMs: 0 })
      return this.json(200, this.act({ kind: 'test', channel, at: this.now() }))
    }
    if (method === 'POST' && (path === '/api/push/subscribe' || path === '/api/push/unsubscribe')) {
      return this.json(501, { error: 'Push notifications are not available in the demo: it has no server to send them.' })
    }
    if (method === 'GET' && path === '/api/fleet') return this.json(503, { error: 'fleet metrics are not part of the demo' })
    if (method === 'POST' && path === '/api/recheck') return this.json(200, this.wallRecheck())

    const recheck = /^\/api\/recheck\/([^/]+)$/.exec(path)
    if (method === 'POST' && recheck) {
      const answer = this.alertRecheck(decodeURIComponent(recheck[1]))
      return answer ? this.json(200, answer) : this.json(404, { error: 'unknown alert' })
    }

    if (method === 'GET' && path === '/api/doctor') return this.json(200, this.fresh(this.base.agent.doctor))
    const recorded = /^\/api\/(alerts|incident-card)\/([^/]+)$/.exec(path)
    if (method === 'GET' && recorded) {
      const key = decodeURIComponent(recorded[2])
      const answer = recorded[1] === 'alerts' ? this.base.agent.alerts[key] : this.base.agent.cards[key]
      return answer ? this.json(200, this.fresh(answer)) : this.json(404, { error: 'not found' })
    }

    const incident = /^\/api\/incidents\/([^/]+)(?:\/(ack|unack|silence|park|unpark|recheck|verify|fix-context))?$/.exec(path)
    if (incident) {
      const key = decodeURIComponent(incident[1])
      const action = incident[2]
      if (!action && method === 'GET') {
        const detail = this.detail(key)
        return detail ? this.json(200, detail) : this.json(404, { error: 'unknown incident' })
      }
      if (action === 'fix-context' && method === 'GET') {
        const brief = this.fixContext(key)
        return brief ? this.json(200, brief) : this.json(404, { error: `no incident ${key}. Use watch_state or list_incidents for the keys the Watcher has.` })
      }
      if ((action === 'recheck' || action === 'verify') && method === 'POST') {
        const answer = (action === 'recheck' ? this.base.rechecks.incidents : this.base.rechecks.verify)[key]
        return answer ? this.json(200, this.restamp(answer)) : this.json(404, { error: 'not found' })
      }
      if (action && method === 'POST') {
        const firing = this.base.state.incidents.some((i) => i.key === key)
        if (action === 'park') {
          const checked = checkPark(body, this.now())
          if (!checked.ok) return this.json(400, { error: checked.error })
          if (!firing) return this.json(404, { error: 'not firing' })
          const was = this.parks.get(key) ?? null
          const replaced = was !== null && Date.parse(was.until) > this.now()
          const who = by()
          this.act({ kind: 'park', key, by: who, at: this.now(), state: checked.state, until: checked.until, note: checked.note, ref: checked.ref })
          return this.json(200, { ok: true, key, by: who, state: checked.state, until: checked.until, replaced })
        }
        if (action === 'unpark') {
          const note = checkOptionalText(body.note, 'note', REASON_MAX)
          if (!note.ok) return this.json(400, { error: note.error })
          if (!firing) return this.json(404, { error: 'not firing' })
          const was = this.parks.get(key) ?? null
          if (!was) return this.json(409, { error: 'not parked by hand' })
          if (Date.parse(was.until) <= this.now()) return this.json(409, { error: `its park already ended at ${was.until}` })
          const at = this.now()
          this.act({ kind: 'unpark', key, by: by(), at, note: note.text })
          return this.json(200, { ok: true, key, at: isoAt(at) })
        }
        if (action === 'unack') {
          if (firing) this.act({ kind: 'unack', key, by: by(), at: this.now() })
          return this.json(200, { ok: true })
        }
        if (!firing) return this.json(404, { error: 'not firing' })
        if (action === 'ack') {
          this.act({ kind: 'ack', key, by: by(), at: this.now() })
          return this.json(200, { ok: true })
        }
        const asked = Number(body.minutes ?? 60)
        const minutes = Math.min(SILENCE_MAX_MIN, Math.max(1, Number.isFinite(asked) ? asked : 60))
        this.act({ kind: 'silence', key, by: by(), at: this.now(), minutes })
        return this.json(200, { ok: true, minutes })
      }
    }
    return this.json(404, { error: 'not found' })
  }

  /** The wall as it stands now: the recording's incidents with the visitor's acts applied and every state recomputed at this moment. */
  state(): WallState {
    const now = this.now()
    const incidents = this.base.state.incidents.map((i) => this.incidentNow(i, now))
    const header = {
      ...this.base.state.header,
      firing: incidents.filter((i) => i.state.firing).length,
      acknowledged: incidents.filter((i) => i.state.attention === 'acked').length,
      parked: incidents.filter((i) => i.state.attention === 'parked').length
    }
    const state = this.fresh({ ...this.base.state, generatedAt: isoAt(now), header, incidents, channels: this.base.state.channels.map((c) => this.proof(c)) })
    const sources = state.sources.map((s) => {
      const polled = this.polledAt.get(s.id)
      return polled !== undefined && (s.lastOk === null || polled > Date.parse(s.lastOk)) ? { ...s, lastOk: isoAt(polled), lastAttempt: isoAt(polled) } : s
    })
    return { ...state, sources }
  }

  private wall(ifNoneMatch: string | null): DemoResponse {
    const state = this.state()
    const etag = `W/"${hashOf(JSON.stringify({ ...state, generatedAt: '' }))}"`
    if (ifNoneMatch === etag) return { status: 304, headers: { etag, 'x-server-time': isoAt(this.now()) }, body: null }
    const res = this.json(200, state)
    res.headers.etag = etag
    return res
  }

  private incidentNow(i: Incident, now: number): Incident {
    const a = this.attention.get(i.key) as Attention
    const park = this.parks.get(i.key) ?? null
    const state = incidentState({
      severity: i.severity,
      instances: i.state.instances,
      startsAtMs: Date.parse(i.startsAt),
      nowMs: now,
      ackedAtMs: a.ackedAt ? Date.parse(a.ackedAt) : null,
      silencedUntilMs: a.silencedUntil ? Date.parse(a.silencedUntil) : null,
      manualPark: park
    })
    // A silence that ran out is no silence: the engine reads it the same way, so its words go with it.
    const silenced = state.attention === 'silenced'
    return {
      ...i,
      ...a,
      silencedUntil: silenced ? a.silencedUntil : null,
      silencedBy: silenced ? a.silencedBy : null,
      state,
      nextStep: state.attention === 'none' ? i.nextStep : null
    }
  }

  /**
   * The fix brief as the Watcher would answer it now: the recording's, with who has the incident, its age and its service's other firing
   * incidents read from the wall as the visitor's acts left it (`fixContextOf` in src/server/mcp/fix-context.ts reads the same fields from
   * the engine). An acknowledgement or a park the visitor makes is then in the brief an agent reads.
   */
  private fixContext(key: string): FixBrief | null {
    const recorded = this.base.agent.fixContext[key] as FixBrief | undefined
    if (!recorded) return null
    const brief = this.fresh(recorded)
    const now = this.now()
    const incidents = this.base.state.incidents.map((i) => this.incidentNow(i, now))
    const inc = incidents.find((i) => i.key === key)
    if (!inc) return brief
    const ageSec = (iso: string): number => Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
    const base = brief.url.slice(0, Math.max(0, brief.url.indexOf('/#/')))
    return {
      ...brief,
      state: {
        ...brief.state,
        attention: inc.state.attention,
        ackedBy: inc.ackedBy,
        silencedUntil: inc.silencedUntil,
        parkedState: inc.state.park?.state ?? null,
        parkedUntil: inc.state.park?.until ?? null
      },
      ageSec: ageSec(inc.startsAt),
      related: incidents
        .filter((i) => i.key !== key && i.state.firing && i.service.toLowerCase() === inc.service.toLowerCase())
        .slice(0, RELATED_MAX)
        .map((i) => ({ key: i.key, title: incidentTitle(i), severity: i.severity, attention: i.state.attention, ageSec: ageSec(i.startsAt), url: `${base}/#/i/${encodeURIComponent(i.key)}` }))
    }
  }

  private detail(key: string): IncidentDetail | null {
    const base = this.base.incidents[key]
    if (!base) return null
    const firing = this.base.state.incidents.find((i) => i.key === key)
    if (!firing) return base
    return this.fresh({ ...base, incident: this.incidentNow(firing, this.now()), events: [...(this.added.get(key) ?? []), ...base.events] })
  }

  private notifications(): NotificationsInfo {
    const n = this.base.notifications
    const tests = this.tests.map((t) => ({
      at: t.at,
      incident_key: '-',
      route_id: '-',
      channel_id: t.channel,
      kind: 'test',
      ok: t.answer.ok ? 1 : 0,
      status: t.answer.status,
      latency_ms: t.answer.latencyMs
    }))
    return { ...n, channels: n.channels.map((c) => this.proof(c)), results: [...tests.reverse(), ...n.results] }
  }

  /** A channel's proof with the visitor's latest test of it. */
  private proof(c: ChannelProof): ChannelProof {
    const last = this.tests.filter((t) => t.channel === c.id).at(-1)
    return last ? { ...c, lastTestAt: isoAt(last.at), lastTestOk: last.answer.ok, lastTest: last.answer.ok ? 'passed' : 'failed' } : c
  }

  /** The recorded re-check, moved to now. Inside the runner's gap a second ask polls nothing, as on a real Watcher, and says so. */
  private wallRecheck(): WallRecheck {
    const rec = this.restamp(this.base.rechecks.wall)
    const throttled = this.throttled('*')
    return { ...rec, sources: rec.sources.map((s) => (throttled ? { ...s, ran: false, throttled: true } : this.polled(s))) }
  }

  private alertRecheck(key: string): AlertRecheck | null {
    const recorded = this.base.rechecks.alerts[key]
    if (!recorded) return null
    const rec = this.restamp(recorded)
    const throttled = this.throttled(key)
    return { ...rec, sources: rec.sources.map((s) => (throttled ? { ...s, ran: false, throttled: true } : this.polled(s))) }
  }

  private polled<S extends { id: string; ran: boolean; ok: boolean }>(s: S): S {
    if (s.ran && s.ok) this.polledAt.set(s.id, this.now())
    return s
  }

  private throttled(key: string): boolean {
    const now = this.now()
    const last = this.lastRecheck.get(key)
    if (last !== undefined && now - last < RECHECK_GAP_MS) return true
    this.lastRecheck.set(key, now)
    return false
  }

  private restamp<T extends { at: string }>(answer: T): T {
    return shiftTimes(answer, this.now() - Date.parse(answer.at), Date.parse(answer.at))
  }

  /** Record an act for the session and apply it. */
  private act(a: DemoAct): TestAnswer {
    this.session.acts.push(a)
    return this.apply(a)
  }

  private apply(a: DemoAct): TestAnswer {
    if (a.kind === 'test') {
      const answer = this.base.tests[a.channel]
      this.tests.push({ channel: a.channel, at: a.at, answer })
      return answer
    }
    const cur = this.attention.get(a.key)
    if (!cur) return { ok: false, status: 'not firing', latencyMs: 0 }
    const at = isoAt(a.at)
    if (a.kind === 'park') {
      const alertKeys = this.base.state.incidents.find((i) => i.key === a.key)?.alerts.map((x) => x.key) ?? []
      this.parks.set(a.key, { state: a.state, until: a.until, since: at, ref: a.ref || null, note: a.note, by: a.by, alertKeys })
      this.event(a.key, at, 'park', { by: a.by, state: a.state, until: a.until, note: a.note, ...(a.ref ? { ref: a.ref } : {}) })
    } else if (a.kind === 'unpark') {
      const was = this.parks.get(a.key)
      if (!was) return { ok: false, status: 'not parked by hand', latencyMs: 0 }
      // ending a park writes its end as now, so the incident's unattended clock starts here (Engine.unpark)
      this.parks.set(a.key, { ...was, until: at })
      this.event(a.key, at, 'unpark', { by: a.by, state: was.state, wasUntil: was.until, ...(a.note ? { note: a.note } : {}) })
    } else if (a.kind === 'ack') {
      this.attention.set(a.key, { ...cur, ackedBy: a.by, ackedAt: at })
      this.event(a.key, at, 'ack', { by: a.by })
    } else if (a.kind === 'unack') {
      this.attention.set(a.key, { ackedBy: null, ackedAt: null, silencedUntil: null, silencedBy: null })
      this.event(a.key, at, 'unack', { by: a.by })
    } else if (a.kind === 'silence') {
      const until = isoAt(a.at + a.minutes * MINUTE)
      this.attention.set(a.key, { ...cur, silencedUntil: until, silencedBy: a.by })
      this.event(a.key, at, 'silence', { by: a.by, until, minutes: a.minutes })
    }
    return { ok: true, status: 'ok', latencyMs: 0 }
  }

  private event(key: string, at: string, kind: AlertEvent['kind'], detail: Record<string, unknown>): void {
    const list = this.added.get(key) ?? []
    list.unshift({ id: this.nextEventId++, at, kind, alertKey: null, incidentKey: key, detail })
    this.added.set(key, list)
  }

  /** What a running Watcher keeps fresh, at the minute the visitor's clock is on. */
  private fresh<T>(value: T): T {
    const since = this.now() - this.session.anchorMs
    return refreshTimes(value, since - (since % MINUTE))
  }

  private json(status: number, body: unknown): DemoResponse {
    return { status, headers: { 'content-type': 'application/json; charset=utf-8', 'x-server-time': isoAt(this.now()) }, body: JSON.stringify(body) }
  }
}
