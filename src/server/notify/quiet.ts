// Quiet hours: the idea behind Alertmanager's `mute_time_intervals` (prometheus/alertmanager
// docs/configuration.md): a route is silenced while the interval holds. The interval is local wall-clock
// time in an IANA zone, may wrap midnight, and `days` names the ISO weekday (1 Monday .. 7 Sunday) on which
// the interval STARTS, so a Friday 22:00 to 07:00 interval ends on Saturday morning.
// The zone is handled with Intl only, so DST steps come from the platform's tz database.

import type { QuietHoursConfig } from '../config.ts'

export interface QuietState {
  quiet: boolean
  /** UTC ms when the current interval ends, null when not quiet. */
  endsAtMs: number | null
}

const NOT_QUIET: QuietState = { quiet: false, endsAtMs: null }
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7]
const ISO_WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

interface Local {
  year: number
  month: number
  day: number
  minutes: number
  seconds: number
  isoWeekday: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    // hourCycle h23, not hour12:false: the latter prints midnight as "24" in some engines.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric'
    })
    formatters.set(tz, f)
  }
  return f
}

function localParts(tz: string, ms: number): Local {
  const p: Record<string, string> = {}
  for (const part of formatterFor(tz).formatToParts(ms)) p[part.type] = part.value
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    minutes: (Number(p.hour) % 24) * 60 + Number(p.minute),
    seconds: Number(p.second),
    isoWeekday: ISO_WEEKDAY[p.weekday] ?? 1
  }
}

/** The zone's offset from UTC at an instant, in ms: local wall time read as UTC, minus the instant. */
function offsetAt(tz: string, ms: number): number {
  const l = localParts(tz, ms)
  const wall = Date.UTC(l.year, l.month - 1, l.day, 0, l.minutes, l.seconds)
  return wall - Math.floor(ms / 1000) * 1000
}

/** Local wall time to a UTC instant. The second pass settles the guess across a DST step. */
function zonedToUtc(tz: string, year: number, month: number, day: number, minutes: number): number {
  const wall = Date.UTC(year, month - 1, day, 0, minutes)
  const first = wall - offsetAt(tz, wall)
  return wall - offsetAt(tz, first)
}

function parseClock(text: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  const h = m ? Number(m[1]) : NaN
  const min = m ? Number(m[2]) : NaN
  if (!m || min > 59 || h > 24 || (h === 24 && min !== 0)) throw new Error(`quiet hours: bad time "${text}"`)
  return h * 60 + min
}

function previousWeekday(d: number): number {
  return ((d + 5) % 7) + 1
}

function quietUntil(tz: string, local: Local, dayOffset: number, endMinutes: number): QuietState {
  const day = new Date(Date.UTC(local.year, local.month - 1, local.day + dayOffset))
  const endsAtMs = zonedToUtc(tz, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), endMinutes)
  return { quiet: true, endsAtMs }
}

/** Throws on an unknown time zone or a malformed clock time, so a bad config fails at startup. */
export function quietState(cfg: QuietHoursConfig | null, nowMs: number): QuietState {
  if (!cfg) return NOT_QUIET
  const start = parseClock(cfg.start)
  const end = parseClock(cfg.end)
  const local = localParts(cfg.tz, nowMs)
  // start === end is an empty interval, not a 24 hour one: a typo must not mute the pager all day.
  if (start === end) return NOT_QUIET
  const days = cfg.days && cfg.days.length > 0 ? cfg.days : ALL_DAYS
  const startsToday = days.includes(local.isoWeekday)
  if (start < end) {
    const inside = local.minutes >= start && local.minutes < end
    return startsToday && inside ? quietUntil(cfg.tz, local, 0, end) : NOT_QUIET
  }
  if (startsToday && local.minutes >= start) return quietUntil(cfg.tz, local, 1, end)
  if (days.includes(previousWeekday(local.isoWeekday)) && local.minutes < end) {
    return quietUntil(cfg.tz, local, 0, end)
  }
  return NOT_QUIET
}
