// Check lists: a sender that pushes alerts also says which checks it runs and when each last ran, so a quiet service tile can show
// a real proof-of-watch cell for every one of them instead of a dotted "seen only in the alert history" guess.
//
// The contract (skills/ezo-watcher/references/sources.md, "A `checks` push"). A push to /ingest/<source> (same Bearer, same X-Alert-Source as its alerts) may carry
// a top-level `checks` object, with or without an `alerts` list:
//
//   "checks": {
//     "staleAfterSec": 300,        // optional, 60 s to 7 d, default 6 h: a check whose lastRunAt is older than this is dashed (stale)
//     "complete": true,            // optional, default true: a check of this sender that is not in `list` is gone, its cell is dropped
//     "list": [{
//       "id": "ProbeDown",         // the alertname (class) the check fires under; stable
//       "instance": "api-rooms",   // optional: which one of that class (a prober target). The cell is named by it
//       "service": "Uptime",       // the tile
//       "state": "ok",             // ok | failing | pending | skipped
//       "lastRunAt": "2026-10-15T15:50:00Z",   // optional, default the push time (not for skipped); a future time is read as now
//       "detail": "HTTP 200 in 41ms",          // optional, one line
//       "asserts": ["status 200", "body.ok = true"],  // optional: the predicates the check made, in words
//       "url": "https://..."                   // optional http(s) link
//     }]
//   }
//
// A cell is the Grafana/vmalert cell model: ok is solid (the check last passed), failing is filled, pending is half, skipped
// (the sender could not run it: blind) is dashed "no data", and a check not re-run inside `staleAfterSec` is dashed "stale"
// (engine.cells). The sender is the origin named by X-Alert-Source, else the source id, so two senders of one webhook keep
// separate lists. A body with no `checks` is an ordinary alert push and changes no cell.

import type { CellState, CheckState, ChecksPush, RuleCell } from '../../shared/types.ts'
import { BadPayload, clip, isRecord, safeUrl } from './shared.ts'

export const MAX_CHECKS = 500
/** The assertion a check makes just by being heard: it answered with the default status. A cell that asserts nothing more cannot go red for anything but a dead process. */
export const DEFAULT_ASSERTION = 'status 200'
/** True when a cell's `asserts` says more than the default status: the predicate a wall's `asserted` count is about. */
export const assertsBeyondDefault = (asserts: readonly string[] | undefined): boolean => (asserts ?? []).some((a) => a !== DEFAULT_ASSERTION)
const MAX_ASSERTS = 20
const MAX_ASSERT_LEN = 160
const MIN_STALE_SEC = 60
const MAX_STALE_SEC = 7 * 24 * 3600
const DEFAULT_STALE_SEC = 6 * 3600
/** A sender clock a little ahead of ours is normal; further ahead is a wrong clock and the run is read as now. */
const CLOCK_SLACK_MS = 5 * 60_000

const CELL_OF: Record<CheckState, CellState> = { ok: 'ok', failing: 'firing', pending: 'pending', skipped: 'nodata' }
const STATES = new Set<string>(Object.keys(CELL_OF))
const TEXT = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return s.length > 0 ? clip(s, max) : null
}

export const hasChecks = (payload: Record<string, unknown>): boolean => 'checks' in payload

/** `asserts` of one check: a list of short one-line predicates, each read like every other sender string (control characters out). */
function assertsOf(raw: unknown, i: number): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MAX_ASSERTS) throw new BadPayload(`checks.list[${i}].asserts must be a list of at most ${MAX_ASSERTS} lines`)
  const out: string[] = []
  for (const a of raw) {
    const line = TEXT(a, MAX_ASSERT_LEN)
    if (!line) throw new BadPayload(`checks.list[${i}].asserts must hold non-empty lines of at most ${MAX_ASSERT_LEN} characters`)
    out.push(line)
  }
  return out
}

/** The cell id of a check. Stable across pushes, and unique across senders, services and instances. */
export const checkCellId = (origin: string, service: string, id: string, instance?: string): string => `check:${origin}:${service}/${id}${instance ? `/${instance}` : ''}`

/**
 * One `checks` object as cells. Every message names a field, never a value, so it is safe to send back to the caller.
 * Throws BadPayload for a shape that cannot be read; a single check with a missing id, service or state is a bad payload too
 * (a sender that lists a check wrongly is a bug to see, not a check to guess).
 */
export function parseChecks(raw: unknown, ctx: { origin: string; source: string; now: string }): ChecksPush {
  if (!isRecord(raw)) throw new BadPayload('checks must be an object')
  if (!Array.isArray(raw.list)) throw new BadPayload('checks.list must be an array')
  if (raw.list.length === 0) throw new BadPayload('checks.list is empty')
  if (raw.list.length > MAX_CHECKS) throw new BadPayload(`checks.list holds more than ${MAX_CHECKS} checks`)
  if (raw.complete !== undefined && typeof raw.complete !== 'boolean') throw new BadPayload('checks.complete must be true or false')
  const staleRaw = raw.staleAfterSec
  if (staleRaw !== undefined && (typeof staleRaw !== 'number' || !Number.isFinite(staleRaw))) throw new BadPayload('checks.staleAfterSec must be a number')
  const staleAfterSec = Math.min(MAX_STALE_SEC, Math.max(MIN_STALE_SEC, Math.round(staleRaw ?? DEFAULT_STALE_SEC)))
  const nowMs = Date.parse(ctx.now)
  const cells = new Map<string, RuleCell>()
  for (const [i, c] of raw.list.entries()) {
    if (!isRecord(c)) throw new BadPayload(`checks.list[${i}] must be an object`)
    const id = TEXT(c.id, 120)
    const service = TEXT(c.service, 80)
    if (!id) throw new BadPayload(`checks.list[${i}].id is required`)
    if (!service) throw new BadPayload(`checks.list[${i}].service is required`)
    if (typeof c.state !== 'string' || !STATES.has(c.state)) throw new BadPayload(`checks.list[${i}].state must be ok, failing, pending or skipped`)
    const state = c.state as CheckState
    const instance = c.instance === undefined ? null : TEXT(c.instance, 120)
    if (c.instance !== undefined && !instance) throw new BadPayload(`checks.list[${i}].instance must be a non-empty string`)
    let ranAt: string | undefined
    if (c.lastRunAt !== undefined && c.lastRunAt !== null) {
      const ms = typeof c.lastRunAt === 'string' ? Date.parse(c.lastRunAt) : Number.NaN
      if (!Number.isFinite(ms) || ms <= 0) throw new BadPayload(`checks.list[${i}].lastRunAt must be an ISO time`)
      ranAt = new Date(ms > nowMs + CLOCK_SLACK_MS ? nowMs : Math.min(ms, nowMs)).toISOString()
    } else if (state !== 'skipped') {
      // A check the sender names without a time ran in this push.
      ranAt = new Date(nowMs).toISOString()
    }
    const detail = TEXT(c.detail, 240)
    const url = safeUrl(c.url)
    const asserts = assertsOf(c.asserts, i)
    const cellId = checkCellId(ctx.origin, service, id, instance ?? undefined)
    cells.set(cellId, {
      id: cellId,
      source: ctx.origin,
      name: instance ?? id,
      service,
      state: CELL_OF[state],
      ...(ranAt ? { evaluatedAt: ranAt } : {}),
      staleAfterSec,
      checkId: id,
      ...(detail ? { detail } : {}),
      ...(asserts.length > 0 ? { asserts } : {}),
      ...(url ? { url } : {})
    })
  }
  return { origin: ctx.origin, complete: raw.complete !== false, cells: [...cells.values()] }
}
