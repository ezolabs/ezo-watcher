// Page storms, told once. A new source can page dozens of incidents in a few minutes (webhook did: 98% of the pages in its first 80
// minutes); every one of them goes to a phone, and an ntfy.sh that rate-limits the host ends up hearing none. So the pager has a rate per origin:
// the first `maxPages` page notifications from one origin inside a rolling `windowSec` go out as always, and every one after that is held back.
// The held ones are told together, one summary per window, to the same receivers: "webhook: 15 more pages in 10 min, see the wall".
//
// The knob is the route's `coalesce` ({ maxPages, windowSec }); a route without it uses these defaults, so for fewer than 10 pages from one
// origin in 10 minutes nothing changes. Nothing here is state of its own: how many pages went out lately is read from the notification log
// (the alert rows of the origin's incidents), and which alerts a summary holds is read from the rows that were closed with "coalesced into <id>".
// A restart therefore loses nothing: the next tick finds the same window and the same summary.

import type { RouteConfig } from '../config.ts'
import { COALESCED_PREFIX, logKey } from './log.ts'
import { matchedRoutes } from './match.ts'
import type { LogRow, NotifyView, ResolvedView } from './types.ts'

/** More than this many page notifications from one origin inside the window are coalesced. */
export const COALESCE_MAX_PAGES = 10
/** The rolling window, and the length of the window one summary covers. */
export const COALESCE_WINDOW_SEC = 600

export interface CoalesceLimits {
  maxPages: number
  windowMs: number
}

/** The route's limits, or null when it sends nobody anything or has the knob at 0. */
export function coalesceLimits(route: RouteConfig): CoalesceLimits | null {
  if (route.receivers.length === 0) return null
  const maxPages = route.coalesce?.maxPages ?? COALESCE_MAX_PAGES
  if (!(maxPages >= 1)) return null
  const windowSec = route.coalesce?.windowSec ?? COALESCE_WINDOW_SEC
  return { maxPages: Math.floor(maxPages), windowMs: (windowSec >= 1 ? windowSec : COALESCE_WINDOW_SEC) * 1000 }
}

/** What a summary says: the alerts it holds and how many of them still need someone. */
export interface SummaryView {
  id: string
  routeId: string
  origin: string
  /** Pages held back into this window, firing or since resolved. */
  count: number
  /** Those still firing with nobody on them. */
  open: number
  windowSec: number
  /** ISO. When the window opened. */
  startsAt: string
  /** How long the longest-waiting open alert has gone unattended; the escalation steps count from it. */
  unattendedSec: number
  /** The headlines of up to four open alerts, longest-waiting first. */
  sample: string[]
}

export function summaryId(routeId: string, origin: string, startMs: number): string {
  return `summary:${routeId}:${origin}@${new Date(startMs).toISOString()}`
}

export function parseSummaryId(id: string): { routeId: string; origin: string; startMs: number } | null {
  if (!id.startsWith('summary:')) return null
  const at = id.lastIndexOf('@')
  const colon = id.indexOf(':', 'summary:'.length)
  if (at < 0 || colon < 0 || colon > at) return null
  const startMs = Date.parse(id.slice(at + 1))
  if (Number.isNaN(startMs)) return null
  return { routeId: id.slice('summary:'.length, colon), origin: id.slice(colon + 1, at), startMs }
}

export interface CoalesceInput {
  routes: RouteConfig[]
  views: NotifyView[]
  resolved: ResolvedView[]
  nowMs: number
  getLog(key: string): LogRow | null
}

type Paged = NotifyView | ResolvedView

/** The page incidents of one origin that go through this route: the firing ones and the ones resolved in the last two hours. */
function scopeItems(route: RouteConfig, origin: string, input: CoalesceInput): Paged[] {
  const seen = new Set<string>()
  const out: Paged[] = []
  for (const item of [...input.views, ...input.resolved] as Paged[]) {
    if (item.origin !== origin || item.severity !== 'page' || seen.has(item.key)) continue
    if (!matchedRoutes(input.routes, item).some((r) => r.id === route.id)) continue
    seen.add(item.key)
    out.push(item)
  }
  return out
}

/** When this incident was last paged on the route (epoch ms), counting a page that failed as the moment it was first tried; null when it was not paged lately. */
function pagedAt(route: RouteConfig, key: string, input: CoalesceInput, windowMs: number): number | null {
  let best: number | null = null
  for (const receiver of route.receivers) {
    const row = input.getLog(logKey(key, route.id, receiver, 'alert'))
    if (!row || row.closed?.startsWith(COALESCED_PREFIX)) continue
    const at = row.ok ? row.sentAt : (row.firstFailedAt ?? row.sentAt)
    if (at > input.nowMs - windowMs && at <= input.nowMs && (best === null || at > best)) best = at
  }
  return best
}

/** How many incidents of this origin were paged on the route inside the window, leaving out the ones named (they are being decided now). */
export function recentPages(route: RouteConfig, origin: string, exclude: ReadonlySet<string>, input: CoalesceInput): number {
  const limits = coalesceLimits(route)
  if (!limits) return 0
  return scopeItems(route, origin, input).filter((i) => !exclude.has(i.key) && pagedAt(route, i.key, input, limits.windowMs) !== null).length
}

/** The id of the origin's summary window that is still open at `nowMs`, if one is: the newest one that began less than a window ago. */
export function openSummaryId(route: RouteConfig, origin: string, input: CoalesceInput): string | null {
  const limits = coalesceLimits(route)
  if (!limits) return null
  let best: { id: string; startMs: number } | null = null
  for (const item of scopeItems(route, origin, input)) {
    for (const receiver of route.receivers) {
      const closed = input.getLog(logKey(item.key, route.id, receiver, 'alert'))?.closed
      if (!closed?.startsWith(COALESCED_PREFIX)) continue
      const id = closed.slice(COALESCED_PREFIX.length)
      const parsed = parseSummaryId(id)
      if (parsed && parsed.routeId === route.id && parsed.origin === origin && (best === null || parsed.startMs > best.startMs)) best = { id, startMs: parsed.startMs }
    }
  }
  return best !== null && input.nowMs < best.startMs + limits.windowMs ? best.id : null
}

/** Every summary the log knows for this route, by id, with the alerts it holds. */
export function summariesOf(route: RouteConfig, input: CoalesceInput): SummaryView[] {
  const limits = coalesceLimits(route)
  if (!limits) return []
  const groups = new Map<string, Map<string, NotifyView | null>>()
  const add = (id: string, key: string, view: NotifyView | null): void => {
    let g = groups.get(id)
    if (!g) groups.set(id, (g = new Map()))
    g.set(key, view)
  }
  const origins = new Set<string>([...input.views, ...input.resolved].filter((i) => i.severity === 'page').map((i) => i.origin))
  for (const origin of origins) {
    for (const item of scopeItems(route, origin, input)) {
      for (const receiver of route.receivers) {
        const closed = input.getLog(logKey(item.key, route.id, receiver, 'alert'))?.closed
        if (!closed?.startsWith(COALESCED_PREFIX)) continue
        const id = closed.slice(COALESCED_PREFIX.length)
        const parsed = parseSummaryId(id)
        if (!parsed || parsed.routeId !== route.id || parsed.origin !== origin) continue
        add(id, item.key, 'attention' in item ? item : null)
      }
    }
  }
  const out: SummaryView[] = []
  for (const [id, members] of groups) {
    const parsed = parseSummaryId(id)
    if (!parsed) continue
    const open = [...members.values()].filter((v): v is NotifyView => v !== null && v.attention === 'none').sort((a, b) => b.unattendedSec - a.unattendedSec)
    out.push({
      id,
      routeId: route.id,
      origin: parsed.origin,
      count: members.size,
      open: open.length,
      windowSec: limits.windowMs / 1000,
      startsAt: new Date(parsed.startMs).toISOString(),
      unattendedSec: open[0]?.unattendedSec ?? 0,
      sample: open.slice(0, 4).map((v) => v.summary || v.rule)
    })
  }
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id))
}

