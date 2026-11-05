// Route matching, Alertmanager style: routes are an ordered list, the first match wins unless the route sets
// `continue`. Label matchers are regexps anchored at both ends (as in Alertmanager) and an absent label reads
// as the empty string, so `team=~".*"` matches an alert with no team label and `team=~".+"` does not.

import type { RouteConfig } from '../config.ts'
import type { Severity } from '../../shared/types.ts'

export interface Matchable {
  severity: Severity
  origin: string
  labels: Record<string, string>
}

const compiled = new Map<string, RegExp | null>()

function anchored(source: string): RegExp | null {
  let re = compiled.get(source)
  if (re === undefined) {
    try {
      re = new RegExp(`^(?:${source})$`)
    } catch {
      re = null
    }
    compiled.set(source, re)
  }
  return re
}

export function routeMatches(route: RouteConfig, item: Matchable): boolean {
  const m = route.match
  if (m.severity && !m.severity.includes(item.severity)) return false
  if (m.origin && !m.origin.includes(item.origin)) return false
  for (const [name, source] of Object.entries(m.labels ?? {})) {
    const re = anchored(source)
    if (!re || !re.test(item.labels[name] ?? '')) return false
  }
  return true
}

/**
 * The routes this host can actually run. A credential that is missing drops its channel from a route and from the
 * escalation steps; a route that loses every receiver that way is dropped (the next route takes over). A route
 * configured with no receivers is a wall-only route and stays, so it still shields its alerts from the routes after it.
 */
export function usableRoutes(routes: RouteConfig[], hasChannel: (id: string) => boolean): RouteConfig[] {
  return routes
    .map((r) => ({
      ...r,
      receivers: r.receivers.filter(hasChannel),
      record: (r.record ?? []).filter(hasChannel),
      escalate: (r.escalate ?? []).map((e) => ({ ...e, receivers: e.receivers.filter(hasChannel) })).filter((e) => e.receivers.length > 0)
    }))
    .filter((r, i) => r.receivers.length > 0 || routes[i].receivers.length === 0)
}

/** Every route the item goes through, in order: stops after the first match unless that route continues. */
export function matchedRoutes(routes: RouteConfig[], item: Matchable): RouteConfig[] {
  const out: RouteConfig[] = []
  for (const route of routes) {
    if (!routeMatches(route, item)) continue
    out.push(route)
    if (!route.continue) break
  }
  return out
}
