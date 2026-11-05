// Heartbeat source: one scheduled job (a cron job, a systemd timer, a container entrypoint) proves it is alive by pinging
// GET|POST /ingest/heartbeat/<id> after each run. The job's schedule lives in the source's config, so Watch itself computes
// whether a run was missed: silence past the next due run plus its grace is a page, and an ok ping resolves it.
//
// The ping paths are healthchecks.io's (https://healthchecks.io/docs/http_api/, retrieved 2026-11-04): /<id> for a success,
// /<id>/start for a run that just began, /<id>/fail for a declared failure, and /<id>/<exit-code> for a shell exit status
// (0 is a success, anything else a failure). The monitor model, and the reason a source is one job, is Sentry's cron
// monitor (https://raw.githubusercontent.com/getsentry/sentry-for-ai/main/src/references/concepts/crons.md): a monitor is
// crontab-or-interval plus a check-in margin, and the monitor's slug is the stable identity. Here the source id is that slug:
// it is the alert's origin and the cell's name, so renaming it replaces the monitor and orphans the alert it was firing.
//
// A ping, an ok one included, hands the engine the source's WHOLE state (`complete: true`): the one HeartbeatDown alert when
// the job is failing or late, and no alert when it is healthy. So a later ok ping resolves the incident without the engine
// needing to know how a heartbeat works, and a Watch restart resolves nothing it cannot still verify.
//
// Nothing here throws for a ping: a bad token, an unknown suffix or a job that never pinged all have ordinary answers, and
// the poll is arithmetic only (no network). Config mistakes are refused at load (heartbeatProblems, src/server/config.ts's
// checkHeartbeat), the poller is started from src/server/source-registry.ts (POLLED.heartbeat), and the route lives in
// src/server/app.ts beside the webhook ingest.

import { createHash, timingSafeEqual } from 'node:crypto'
import type { Alert, Observation, RuleCell, SourceDiscovery, SourceKind } from '../../shared/types.ts'
import { deriveService, makeAlert } from '../derive.ts'
import { clip } from './shared.ts'
import type { HeartbeatPingKind, HeartbeatState, HeartbeatStateRecord, HeartbeatStateStore, PolledSource, SourceDeps } from './types.ts'

/** Re-exported for the callers that named the ping kind and the state through this module. */
export type { HeartbeatPingKind, HeartbeatState } from './types.ts'

/** The SourceKind this module reports, and the kind its config entries carry. */
const KIND: SourceKind = 'heartbeat'

/** The alert class a late or failed run fires under. One class for both, so a job that fails and then stops running stays one incident. */
export const HEARTBEAT_RULE = 'HeartbeatDown'
/** What a green heartbeat cell asserts (RuleCell.asserts, src/shared/types.ts): not merely "seen", but "ran on time". */
export const HEARTBEAT_ASSERT = 'heartbeat:on-time'
/** Seconds between the source's own evaluations, at most. A poll is arithmetic only, so this is the clock's resolution, not a request rate. */
export const HEARTBEAT_POLL_SEC = 15
/** How late a run may be before it counts as missed, when the config names no grace. */
export const HEARTBEAT_DEFAULT_GRACE = '2m'
/** The IANA zone a crontab is read in when the config names none. */
export const HEARTBEAT_DEFAULT_TIMEZONE = 'UTC'
/** A crontab that matches nothing inside this many days is refused: "0 0 30 2 *" is a typo, not a schedule. */
const CRON_LOOKAHEAD_DAYS = 5 * 366
const DAY_MS = 86_400_000
const MINUTE_MS = 60_000
const MAX_NAME = 80
const MAX_SERVICE = 80

/**
 * One heartbeat job. The field names are the brief's: `every` or `schedule`, `grace`, `tokenEnv`. The discriminator is `type`,
 * as it is for every other source in src/server/config.ts (`engine.sources()` reads `c.type` as the SourceKind), so a
 * heartbeat entry in the config file is `{ "type": "heartbeat", ... }`.
 */
export interface HeartbeatSourceConfig {
  id: string
  type: 'heartbeat'
  /** The job's name in its alert's words and on its cell. Default the id (the id is what the alert's identity is built from). */
  name?: string
  /** How often the job runs: "30s", "5m", "2h", "1d". Exactly one of `every` and `schedule`. */
  every?: string
  /** A five-field crontab ("0 4 * * *"). Exactly one of `every` and `schedule`. */
  schedule?: string
  /** The IANA zone `schedule` is written in, "America/Chicago". Default UTC. */
  timezone?: string
  /** How late a ping may be before the run counts as missed: "2m" (the default), "30s". */
  grace?: string
  /** The token the job sends (Bearer, or `?token=`), by the env var name that holds it. Never the token itself. */
  tokenEnv: string
  /** The wall tile its alert and cell land on. Default the serviceMap's tile, else the source id. */
  service?: string
  /** Where the schedule was found in the project (`watcher add --found-at`): provenance only, a warning when absent (source.untraced); it never gates. */
  discovered?: SourceDiscovery
}

/** The ping kind and the state live in types.ts beside the store that persists them. */

/** What the schedule says about one instant: healthy, a run that is overdue, or a run that said it failed. */
export interface HeartbeatReading {
  health: 'ok' | 'missed' | 'failed'
  /** When the next run was due: the base for a missed run, and the next expected run otherwise. Null only when the crontab can never match again. */
  dueAtMs: number | null
  lastPingMs: number | null
  /** When the trouble began: the missed run's due time, or the failing ping's time. Null when healthy. */
  badSinceMs: number | null
  /** One line for the cell and the alert: what happened and when. */
  detail: string
  /** The exit status that opened a declared failure, when the last failing ping was a `/<code>`. */
  exitCode?: number
}

/** The answer to one ping, and the Observation to hand the engine when the ping was accepted. */
export interface HeartbeatAnswer {
  status: number
  body: Record<string, unknown>
  observation?: Observation
}

/** The heartbeat cell: a RuleCell plus the assertion a green one makes, narrowed so a reader cannot forget it. */
export interface HeartbeatCell extends RuleCell {
  asserts: string[]
}

// ---- durations ---------------------------------------------------------------------------------------

const DURATION = /^(\d{1,7})(s|m|h|d)$/
const UNIT_SEC: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 }

/**
 * "30s", "5m", "2h" or "1d" as seconds. Throws for anything else, zero included: a zero interval would be due before it was
 * scheduled. The message names the shape, never a value the caller sent.
 */
export function parseDurationSec(text: string): number {
  const m = DURATION.exec(typeof text === 'string' ? text.trim() : '')
  if (!m) throw new Error('a duration is a whole number followed by s, m, h or d, for example "5m" or "2h"')
  const sec = Number(m[1]) * UNIT_SEC[m[2]]
  if (!(sec > 0)) throw new Error('a duration must be above zero')
  return sec
}

/** A span of time in words, for a cell's one line: "40s", "12m", "3h", "2d". */
export function humanDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  const hours = Math.round(min / 60)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

// ---- crontab -----------------------------------------------------------------------------------------

/** A parsed five-field crontab. `domStar`/`dowStar` remember which of the two last fields was `*`, since cron ORs them only when both are restricted. */
export interface CronSpec {
  minutes: number[]
  hours: number[]
  daysOfMonth: number[]
  months: number[]
  daysOfWeek: number[]
  domStar: boolean
  dowStar: boolean
}

interface Field {
  values: number[]
  star: boolean
}

/**
 * One crontab field: "*", a number, a range "a-b", a step "a-b/n" or "*" with a step, and any of those joined by commas.
 * Names ("mon", "jan") are not accepted: a schedule is read once at load, and a typo must be refused, not guessed.
 */
function parseField(text: string, lo: number, hi: number, name: string): Field {
  if (text === '') throw new Error(`the ${name} field is empty`)
  const values = new Set<number>()
  let star = false
  for (const part of text.split(',')) {
    if (part === '') throw new Error(`the ${name} field has an empty list item`)
    const slash = part.indexOf('/')
    const range = slash === -1 ? part : part.slice(0, slash)
    let step = 1
    if (slash !== -1) {
      const stepText = part.slice(slash + 1)
      if (!/^\d{1,3}$/.test(stepText) || Number(stepText) === 0) throw new Error(`"${part}" is not a step in the ${name} field`)
      step = Number(stepText)
    }
    let from: number
    let to: number
    if (range === '*') {
      from = lo
      to = hi
      if (slash === -1) star = true
    } else {
      const m = /^(\d{1,3})(?:-(\d{1,3}))?$/.exec(range)
      if (!m) throw new Error(`"${part}" is not a number, a range or "*" in the ${name} field`)
      from = Number(m[1])
      to = m[2] === undefined ? from : Number(m[2])
    }
    if (from < lo || to > hi || from > to) throw new Error(`"${part}" is outside ${lo} to ${hi} in the ${name} field`)
    for (let v = from; v <= to; v += step) values.add(v)
  }
  if (values.size === 0) throw new Error(`the ${name} field matches nothing`)
  return { values: [...values].sort((a, b) => a - b), star }
}

/**
 * A five-field crontab: minute hour day-of-month month day-of-week, in that order. Day of week takes 0 (Sunday) through 7
 * (Sunday again). As in Vixie cron, a restricted day-of-month and a restricted day-of-week are ORed: "0 0 13 * 5" runs on the
 * 13th and on every Friday. A field whose type is understood but whose values leave it empty is refused.
 */
export function parseCron(text: string): CronSpec {
  const fields = typeof text === 'string' ? text.trim().split(/\s+/) : []
  if (fields.length !== 5) throw new Error('a crontab has five fields: minute hour day-of-month month day-of-week')
  const [minute, hour, dom, month, dow] = fields
  const minutes = parseField(minute, 0, 59, 'minute')
  const hours = parseField(hour, 0, 23, 'hour')
  const daysOfMonth = parseField(dom, 1, 31, 'day-of-month')
  const months = parseField(month, 1, 12, 'month')
  const daysOfWeek = parseField(dow, 0, 7, 'day-of-week')
  // 7 is Sunday, as in Vixie cron; it is the same day as 0.
  const weekdays = [...new Set(daysOfWeek.values.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b)
  return {
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: daysOfMonth.values,
    months: months.values,
    daysOfWeek: weekdays,
    domStar: daysOfMonth.star,
    dowStar: daysOfWeek.star
  }
}

// ---- the zone ----------------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>()

/** One formatter per zone: `formatToParts` is the only zone conversion the platform offers, and building one per call is slow. */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    })
    formatters.set(timeZone, f)
  }
  return f
}

/** True for an IANA zone this runtime knows. A config's `timezone` must pass, or every computation below would be a guess. */
export function isTimeZone(text: string): boolean {
  try {
    formatterFor(text)
    return true
  } catch {
    return false
  }
}

interface Parts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** The wall-clock parts of an instant in a zone. */
function zonedParts(ms: number, timeZone: string): Parts {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms))
  const at = (type: string): number => Number(parts.find((p) => p.type === type)?.value)
  return { year: at('year'), month: at('month'), day: at('day'), hour: at('hour'), minute: at('minute'), second: at('second') }
}

/** How far ahead of UTC the zone is at an instant, in ms (negative west of Greenwich). */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone)
  const whole = ms - (ms % 1000)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole
}

/**
 * The instant a wall-clock time in a zone names, or null when that time does not exist there (the hour a spring DST change
 * skips). An ambiguous time (the hour a fall change repeats) resolves to the first of the two, which is what a scheduler does.
 */
export function zonedTimeToMs(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number | null {
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  // The offset at the UTC guess and the offset at the instant it proposes can differ across a DST change, so try both and keep the one whose
  // wall-clock parts round-trip. A spring gap matches neither and is a time that does not exist.
  const candidates = [guess - zoneOffsetMs(guess, timeZone)]
  candidates.push(guess - zoneOffsetMs(candidates[0], timeZone))
  for (const at of candidates) {
    const p = zonedParts(at, timeZone)
    if (p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute) return at
  }
  return null
}

function dayMatches(spec: CronSpec, year: number, month: number, day: number): boolean {
  if (!spec.months.includes(month)) return false
  const domOk = spec.daysOfMonth.includes(day)
  const dowOk = spec.daysOfWeek.includes(new Date(Date.UTC(year, month - 1, day)).getUTCDay())
  if (spec.domStar && spec.dowStar) return true
  if (spec.domStar) return dowOk
  if (spec.dowStar) return domOk
  return domOk || dowOk
}

/**
 * The first instant strictly after `afterMs` at which the crontab runs in `timeZone`, or null when it matches nothing inside
 * five years (a February 30th). Days are walked in the zone's calendar, so a DST change neither skips nor doubles a run: a
 * daily 04:00 stays 04:00 local, which is a different UTC instant on either side of the change, and a 02:30 that the spring
 * change skips is simply not a run that day (the same answer cron gives).
 */
export function nextCronTick(spec: CronSpec, afterMs: number, timeZone: string): number | null {
  const start = zonedParts(afterMs, timeZone)
  const firstDay = Date.UTC(start.year, start.month - 1, start.day)
  for (let offset = 0; offset <= CRON_LOOKAHEAD_DAYS; offset++) {
    const day = new Date(firstDay + offset * DAY_MS)
    const year = day.getUTCFullYear()
    const month = day.getUTCMonth() + 1
    const dom = day.getUTCDate()
    if (!dayMatches(spec, year, month, dom)) continue
    for (const hour of spec.hours) {
      for (const minute of spec.minutes) {
        const at = zonedTimeToMs(year, month, dom, hour, minute, timeZone)
        if (at !== null && at > afterMs) return at
      }
    }
  }
  return null
}

// ---- the plan and the reading -------------------------------------------------------------------------

interface Plan {
  everySec: number | null
  cron: CronSpec | null
  graceSec: number
  timeZone: string
}

function planOf(cfg: HeartbeatSourceConfig): Plan {
  const everySec = cfg.every !== undefined ? parseDurationSec(cfg.every) : null
  const cron = cfg.schedule !== undefined ? parseCron(cfg.schedule) : null
  const timeZone = cfg.timezone ?? HEARTBEAT_DEFAULT_TIMEZONE
  if (!isTimeZone(timeZone)) throw new Error(`"${timeZone}" is not an IANA time zone`)
  return { everySec, cron, graceSec: parseDurationSec(cfg.grace ?? HEARTBEAT_DEFAULT_GRACE), timeZone }
}

/** The gap between two consecutive crontab runs (a day for a daily job), the cell's expected interval. Null for a crontab that can never match. */
function cronIntervalMs(plan: Plan, baseMs: number): number | null {
  const first = nextCronTick(plan.cron as CronSpec, baseMs, plan.timeZone)
  if (first === null) return null
  const second = nextCronTick(plan.cron as CronSpec, first, plan.timeZone)
  return second === null ? null : second - first
}

/** The wall-clock instant the run after `baseMs` is due, and the interval it implies. Null for a crontab that can never match. */
function dueAfter(plan: Plan, baseMs: number): { dueMs: number; intervalMs: number } | null {
  if (plan.everySec !== null) {
    const intervalMs = plan.everySec * 1000
    return { dueMs: baseMs + intervalMs, intervalMs }
  }
  const dueMs = nextCronTick(plan.cron as CronSpec, baseMs, plan.timeZone)
  return dueMs === null ? null : { dueMs, intervalMs: Math.max(MINUTE_MS, dueMs - baseMs) }
}

/**
 * The job's state at one instant. A failure the job declared (`/fail` or a non-zero exit) holds until an ok ping, whatever the
 * clock says; silence past the next due run plus the grace is a missed run. A `/start` is liveness only: it moves the next
 * deadline forward, and it never resolves a failure (the brief's words: "a later ok ping resolves").
 */
export function evaluateHeartbeat(cfg: HeartbeatSourceConfig, state: HeartbeatState, nowMs: number): HeartbeatReading {
  const plan = planOf(cfg)
  const baseMs = state.lastPingMs ?? state.startedMs
  const due = dueAfter(plan, baseMs)
  const declared = state.failedSinceMs !== null
  if (declared) {
    const since = state.failedSinceMs as number
    const code = state.exitCode !== undefined ? ` (exit ${state.exitCode})` : ''
    return {
      health: 'failed',
      dueAtMs: due?.dueMs ?? null,
      lastPingMs: state.lastPingMs,
      badSinceMs: since,
      detail: `the run at ${new Date(since).toISOString()} reported failure${code}`,
      ...(state.exitCode !== undefined ? { exitCode: state.exitCode } : {})
    }
  }
  if (due === null) {
    return {
      health: 'missed',
      dueAtMs: null,
      lastPingMs: state.lastPingMs,
      badSinceMs: state.lastPingMs ?? state.startedMs,
      detail: 'the crontab matches no future run'
    }
  }
  const deadlineMs = due.dueMs + plan.graceSec * 1000
  if (nowMs > deadlineMs) {
    const late = humanDuration(nowMs - due.dueMs)
    return {
      health: 'missed',
      dueAtMs: due.dueMs,
      lastPingMs: state.lastPingMs,
      badSinceMs: due.dueMs,
      detail: `the run due at ${new Date(due.dueMs).toISOString()} is ${late} overdue (grace ${humanDuration(plan.graceSec * 1000)})`
    }
  }
  const last = state.lastKind === 'start' ? 'a run started' : state.lastPingMs === null ? 'no ping yet' : 'the last run was ok'
  return {
    health: 'ok',
    dueAtMs: due.dueMs,
    lastPingMs: state.lastPingMs,
    badSinceMs: null,
    detail: `${last}; the next run is due at ${new Date(due.dueMs).toISOString()}`
  }
}

// ---- the alert and the cell ---------------------------------------------------------------------------

function serviceOf(cfg: HeartbeatSourceConfig, deps: SourceDeps): string {
  const labels: Record<string, string> = { alertname: HEARTBEAT_RULE, job: cfg.id, ...(cfg.service ? { service: cfg.service } : {}) }
  return deriveService(cfg.id, HEARTBEAT_RULE, labels, deps.serviceMap)
}

function scheduleText(cfg: HeartbeatSourceConfig): string {
  return cfg.every !== undefined ? `every ${cfg.every}` : `on the schedule "${cfg.schedule}" (${cfg.timezone ?? HEARTBEAT_DEFAULT_TIMEZONE})`
}

/** The one alert class: a page, named for the job, with the same fingerprint every time so a restart or a mode change cannot fork it. */
function heartbeatAlert(cfg: HeartbeatSourceConfig, deps: SourceDeps, reading: HeartbeatReading, nowIso: string): Alert {
  const name = cfg.name ?? cfg.id
  const late = reading.health === 'missed'
  const code = reading.exitCode !== undefined ? ` (exit ${reading.exitCode})` : ''
  const summary = late ? `${name} missed a scheduled run` : `${name} reported a failed run${code}`
  return makeAlert(
    {
      origin: cfg.id,
      rule: HEARTBEAT_RULE,
      labels: { alertname: HEARTBEAT_RULE, severity: 'page', job: cfg.id, instance: cfg.id, ...(cfg.service ? { service: cfg.service } : {}) },
      annotations: {
        summary: clip(summary, 220),
        description: clip(
          `Watch expects the job ${name} to ping ${scheduleText(cfg)}, and pages when a run is later than its grace. ` +
            'An ok ping resolves this; /fail or a non-zero exit status raises it at once. ' +
            reading.detail,
          600
        ),
        page_reason: clip(summary, 220)
      },
      startsAt: new Date(reading.badSinceMs ?? Date.parse(nowIso)).toISOString(),
      via: { source: cfg.id, kind: KIND, lastSeen: nowIso },
      raw: { job: cfg.id, health: reading.health, detail: reading.detail }
    },
    deps.serviceMap,
    nowIso
  )
}

/** The cell a healthy job fills with a solid mark and a failing one fills: the same rule cell model as every other source, plus the assertion. */
function heartbeatCell(cfg: HeartbeatSourceConfig, deps: SourceDeps, reading: HeartbeatReading, nowIso: string, intervalSec: number): HeartbeatCell {
  return {
    id: `heartbeat:${cfg.id}`,
    source: cfg.id,
    name: cfg.name ?? cfg.id,
    service: serviceOf(cfg, deps),
    state: reading.health === 'ok' ? 'ok' : 'firing',
    evaluatedAt: nowIso,
    intervalSec,
    staleAfterSec: intervalSec + parseDurationSec(cfg.grace ?? HEARTBEAT_DEFAULT_GRACE),
    detail: clip(reading.detail, 240),
    checkId: HEARTBEAT_RULE,
    asserts: [HEARTBEAT_ASSERT]
  }
}

/**
 * The source's whole state as one Observation. `complete: true` is the point: the engine resolves the heartbeat alert whenever
 * this list is empty, so an ok ping and a poll that finds the job healthy both clear it without either side knowing the other.
 */
function observationOf(cfg: HeartbeatSourceConfig, deps: SourceDeps, state: HeartbeatState, nowIso: string): Observation {
  const nowMs = Date.parse(nowIso)
  const reading = evaluateHeartbeat(cfg, state, nowMs)
  const plan = planOf(cfg)
  const baseMs = state.lastPingMs ?? state.startedMs
  const expectedMs = plan.everySec !== null ? plan.everySec * 1000 : cronIntervalMs(plan, baseMs)
  const intervalSec = expectedMs !== null ? Math.max(1, Math.round(expectedMs / 1000)) : plan.graceSec
  const firing = reading.health === 'ok' ? [] : [heartbeatAlert(cfg, deps, reading, nowIso)]
  return {
    source: cfg.id,
    kind: KIND,
    at: nowIso,
    firing,
    resolved: [],
    complete: true,
    rules: [heartbeatCell(cfg, deps, reading, nowIso, intervalSec)]
  }
}

// ---- the proof ----------------------------------------------------------------------------------------

/** One mutation of a heartbeat's state, and what the evaluator made of it (http-probe.ts's ProveRun, repeated here so this source needs no prober). */
export interface HeartbeatProveRun {
  /** What was changed, in words ("no ping after the run due at …"). */
  mutation: string
  /** True when the mutated state stayed green, which is what a proof must not do. */
  ok: boolean
  /** The assertions the mutation reddened. */
  failed: string[]
}

export interface HeartbeatProveOutcome {
  /** True when a healthy job that goes silent was shown to fire HeartbeatDown. */
  red: boolean
  runs: HeartbeatProveRun[]
}

/**
 * Prove a heartbeat's alert by taking its healthiest state (an ok ping at `nowMs`, no open failure) and
 * evaluating the same schedule at the first instant after the next due run plus its grace, with no new
 * ping. `HeartbeatDown` must fire, or the rule is not a rule. Pure: no clock, no network, no server — the
 * seam `doctor --prove` runs for a job-only install.
 */
export function proveHeartbeat(cfg: HeartbeatSourceConfig, nowMs: number): HeartbeatProveOutcome {
  const state: HeartbeatState = { startedMs: nowMs, lastPingMs: nowMs, lastKind: 'ok', failedSinceMs: null }
  const healthy = evaluateHeartbeat(cfg, state, nowMs)
  if (healthy.health !== 'ok' || healthy.dueAtMs === null) {
    return { red: false, runs: [{ mutation: 'take a healthy ok ping at now', ok: true, failed: [] }] }
  }
  const graceMs = parseDurationSec(cfg.grace ?? HEARTBEAT_DEFAULT_GRACE) * 1000
  const atMs = healthy.dueAtMs + graceMs + 1
  const atIso = new Date(atMs).toISOString()
  // The same evaluator and alert builder the poll uses: nothing here copies the rule.
  const deps: SourceDeps = { fetch, env: {}, nowIso: () => atIso, serviceMap: [] }
  const obs = observationOf(cfg, deps, state, atIso)
  const fired = obs.firing.some((a) => a.rule === HEARTBEAT_RULE)
  const mutation = `no ping after the run due at ${new Date(healthy.dueAtMs).toISOString()} (evaluated at ${atIso}, after the grace)`
  return { red: fired, runs: [{ mutation, ok: !fired, failed: [] }] }
}

// ---- the source ----------------------------------------------------------------------------------------

const sources = new Map<string, HeartbeatSource>()

// The process's heartbeat store. The Engine constructor sets it once the database is open (engine.ts): every process builds an
// engine before it builds any source, and a test that builds a source with no engine gets memory-only state, as before. The
// module-global mirrors the source map above: one process, one store, the same lifetime as the polled source it feeds.
let defaultHeartbeatStore: HeartbeatStateStore | null = null

/** Wire the ping history to the process's database. Called by the Engine constructor; `null` returns to memory-only. */
export function setHeartbeatStore(store: HeartbeatStateStore | null): void {
  defaultHeartbeatStore = store
}

/** A ping as the path spells it: undefined or "0" is a success, "start", "fail", else an exit status. Null when the suffix is none of those. */
export function parseHeartbeatAction(action: string | undefined): { kind: HeartbeatPingKind; exitCode?: number } | null {
  if (action === undefined || action === '') return { kind: 'ok' }
  if (action === 'start') return { kind: 'start' }
  if (action === 'fail') return { kind: 'fail' }
  if (/^\d{1,3}$/.test(action)) {
    const code = Number(action)
    return code === 0 ? { kind: 'ok' } : { kind: 'exit', exitCode: code }
  }
  return null
}

/**
 * One job's heartbeat. `handle` is the whole HTTP answer and its side effect, so the route in src/server/app.ts is three lines:
 * find the config entry, call `heartbeatSource(entry, deps).handle(action, token, authorization)`, and, when an Observation comes
 * back, `engine.ingest` it and record the source. `poll` re-evaluates the same state on the timer, which is how a missed run
 * becomes an incident with no ping at all.
 */
export class HeartbeatSource implements PolledSource {
  readonly id: string
  readonly kind: SourceKind = KIND
  readonly name: string
  /** The evaluation cadence: the schedule's own resolution, so a fast job is checked twice per run and a slow one every 15 s. */
  readonly pollSec: number
  private readonly cfg: HeartbeatSourceConfig
  private readonly deps: SourceDeps
  private readonly state: HeartbeatState
  private readonly store: HeartbeatStateStore | null

  constructor(cfg: HeartbeatSourceConfig, deps: SourceDeps) {
    // Refuse a broken config here rather than on every poll: a factory that cannot read its schedule must not start.
    const problems = heartbeatProblems(cfg)
    if (problems.length > 0) throw new Error(`heartbeat source ${cfg.id}: ${problems[0]}`)
    this.cfg = cfg
    this.deps = deps
    this.id = cfg.id
    this.name = cfg.name ?? cfg.id
    // A job that runs every 4 s must be decided on faster than the default tick, or its cell would dash between two evaluations.
    const everySec = cfg.every !== undefined ? parseDurationSec(cfg.every) : null
    this.pollSec = everySec !== null ? Math.max(1, Math.min(HEARTBEAT_POLL_SEC, Math.floor(everySec / 2))) : HEARTBEAT_POLL_SEC
    // The ping history outlives the process (src/server/stores.ts): a restart must not resolve a live HeartbeatDown, and a job that
    // never pinged keeps counting from its first-ever registration rather than from this process's start.
    this.store = deps.heartbeatStore ?? defaultHeartbeatStore
    const stored = this.store?.load(cfg.id) ?? null
    this.state = stored
      ? {
          startedMs: stored.registeredMs,
          lastPingMs: stored.lastPingMs,
          lastKind: stored.lastKind,
          lastStartMs: stored.lastStartMs,
          failedSinceMs: stored.lastFailMs,
          ...(stored.exitCode !== null ? { exitCode: stored.exitCode } : {})
        }
      : { startedMs: Date.parse(deps.nowIso()), lastPingMs: null, lastKind: null, lastStartMs: null, failedSinceMs: null }
    this.persist()
  }

  /** Write the state through the store, when the host gave one. Called on construction (the first-ever registration) and on every ping. */
  private persist(): void {
    this.store?.save({
      source: this.id,
      registeredMs: this.state.startedMs,
      lastPingMs: this.state.lastPingMs,
      lastKind: this.state.lastKind,
      lastStartMs: this.state.lastStartMs ?? null,
      lastFailMs: this.state.failedSinceMs,
      exitCode: this.state.exitCode ?? null
    })
  }

  /** The whole current state at one instant. Used by the route after a ping and by the poll on the timer. */
  observation(nowIso: string = this.deps.nowIso()): Observation {
    return observationOf(this.cfg, this.deps, this.state, nowIso)
  }

  /** A ping's side effect on the state. `start` is liveness only; only an ok clears a failure. */
  ping(action: string, nowIso: string = this.deps.nowIso()): HeartbeatAnswer {
    const parsed = parseHeartbeatAction(action)
    if (!parsed) return { status: 404, body: { error: 'unknown ping', detail: 'the path is /ingest/heartbeat/<id>, /start, /fail or /<exit-code>' } }
    const atMs = Date.parse(nowIso)
    if (!Number.isFinite(atMs)) return { status: 500, body: { error: 'clock unreadable' } }
    this.state.lastPingMs = atMs
    this.state.lastKind = parsed.kind
    if (parsed.kind === 'start') this.state.lastStartMs = atMs
    if (parsed.kind === 'ok') {
      this.state.failedSinceMs = null
      this.state.exitCode = undefined
    } else if (parsed.kind === 'fail' || parsed.kind === 'exit') {
      // The first failing ping of a streak starts the clock; a later one keeps it, so the incident's age is the outage's, not the last ping's.
      this.state.failedSinceMs = this.state.failedSinceMs ?? atMs
      this.state.exitCode = parsed.exitCode
    }
    this.persist()
    const observation = this.observation(nowIso)
    const reading = evaluateHeartbeat(this.cfg, this.state, atMs)
    return { status: 200, body: { ok: true, at: nowIso, health: reading.health }, observation }
  }

  /** A request as src/server/app.ts hands it over: the action segment, the `?token=` query and the Authorization header. */
  handle(action: string | undefined, token: string | null | undefined, authorization: string | null | undefined): HeartbeatAnswer {
    // An empty query token is not a credential: fall through to the header.
    const query = (token ?? '').trim()
    if (!this.accepts(query !== '' ? query : bearerOf(authorization))) return { status: 401, body: { error: 'unauthorized' } }
    return this.ping(action ?? '', this.deps.nowIso())
  }

  private accepts(given: string): boolean {
    const expected = this.deps.env[this.cfg.tokenEnv] ?? ''
    if (expected === '' || given === '') return false
    const digest = (v: string): Buffer => createHash('sha256').update(v).digest()
    return timingSafeEqual(digest(given), digest(expected))
  }

  /** The timer's evaluation. It reads no network and never throws: a heartbeat that cannot say it is late is a broken Watch, not a broken job. */
  async poll(): Promise<Observation> {
    return this.observation(this.deps.nowIso())
  }
}

function bearerOf(authorization: string | null | undefined): string {
  const header = authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice(7) : ''
}

/**
 * The one source for an id, so the poller the registry started and the request the route takes share the same last ping.
 * The first caller's deps win (they are the same process's config and clock).
 */
export function heartbeatSource(cfg: HeartbeatSourceConfig, deps: SourceDeps): HeartbeatSource {
  const held = sources.get(cfg.id)
  if (held) return held
  const made = new HeartbeatSource(cfg, deps)
  sources.set(cfg.id, made)
  return made
}

/** The source an id names, when one was started in this process. */
export function heartbeatSourceOf(id: string): HeartbeatSource | undefined {
  return sources.get(id)
}

/** Forget every source. For a test that builds one process's worth of state more than once. */
export function resetHeartbeatSources(): void {
  sources.clear()
}

// ---- config ------------------------------------------------------------------------------------------

function text(v: unknown, max: number, what: string, problems: string[]): string | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'string') {
    problems.push(`${what} must be a string`)
    return undefined
  }
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  if (s === '') problems.push(`${what} must not be empty`)
  else if (s.length > max) problems.push(`${what} must be at most ${max} characters`)
  return s
}

/**
 * Every problem with one heartbeat entry, as sentences that name the field. src/server/config.ts's `checkHeartbeat` is one
 * call: `const p = heartbeatProblems(s); if (p.length) throw new Error(`config: source ${s.id}: ${p[0]}`)`.
 */
export function heartbeatProblems(raw: unknown): string[] {
  const problems: string[] = []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return ['a heartbeat source must be an object with id, type, tokenEnv and every or schedule']
  const cfg = raw as Record<string, unknown>
  if (cfg.type !== 'heartbeat') problems.push('type must be "heartbeat"')
  if (typeof cfg.id !== 'string' || cfg.id.trim() === '') problems.push('id must name the job: it is the alert identity and cannot be empty')
  else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(cfg.id)) problems.push('id must be letters, digits, dots, dashes and underscores, at most 64, since it is the ping URL')
  text(cfg.name, MAX_NAME, 'name', problems)
  text(cfg.service, MAX_SERVICE, 'service', problems)
  if (typeof cfg.tokenEnv !== 'string' || cfg.tokenEnv.trim() === '') problems.push('tokenEnv must name the env var that holds the ping token')
  const hasEvery = cfg.every !== undefined
  const hasSchedule = cfg.schedule !== undefined
  if (hasEvery === hasSchedule) problems.push('give exactly one of every and schedule')
  // The zone first: a crontab's next run is computed in it, and a typo there must be named as a zone, not as a schedule that matches nothing.
  const zoneOk = cfg.timezone === undefined || (typeof cfg.timezone === 'string' && isTimeZone(cfg.timezone))
  if (!zoneOk) problems.push('timezone must be an IANA zone such as "America/Chicago"')
  if (hasEvery) {
    if (typeof cfg.every !== 'string') problems.push('every must be a duration such as "5m"')
    else try {
      parseDurationSec(cfg.every)
    } catch (err) {
      problems.push(`every: ${(err as Error).message}`)
    }
  }
  if (hasSchedule) {
    if (typeof cfg.schedule !== 'string') problems.push('schedule must be a five-field crontab such as "0 4 * * *"')
    else {
      try {
        const spec = parseCron(cfg.schedule)
        const zone = typeof cfg.timezone === 'string' && zoneOk ? cfg.timezone : HEARTBEAT_DEFAULT_TIMEZONE
        if (nextCronTick(spec, Date.parse('2026-01-01T00:00:00Z'), zone) === null) problems.push('schedule matches no run in the next five years')
      } catch (err) {
        problems.push(`schedule: ${(err as Error).message}`)
      }
    }
  }
  if (cfg.grace !== undefined) {
    if (typeof cfg.grace !== 'string') problems.push('grace must be a duration such as "2m"')
    else try {
      parseDurationSec(cfg.grace)
    } catch (err) {
      problems.push(`grace: ${(err as Error).message}`)
    }
  }
  return problems
}
