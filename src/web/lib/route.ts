import { useEffect, useState } from 'react'

export type View = 'wall' | 'fleet' | 'history' | 'notifications' | 'sources'

export interface Route {
  view: View
  /** Open incident (a sheet over the view), by incident key. */
  incident: string | null
  /** Open host group (a sheet over the wall), by host name. */
  host: string | null
  /** Open service (a sheet listing its rules), by service name. */
  service: string | null
  /** Open instance inside the incident sheet, by alert key. */
  alert: string | null
  /** The incident sheet opens on what an agent reads for it (its "What your agent sees" fold). A flag segment, always last. */
  agent: boolean
}

export const VIEWS: View[] = ['wall', 'fleet', 'history', 'notifications', 'sources']

/** A segment decoded; one with a malformed escape (a stray %) stays as it was written. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(safeDecode)
  let view: View = 'wall'
  if (parts[0] && VIEWS.includes(parts[0] as View)) view = parts.shift() as View
  const r: Route = { view, incident: null, host: null, service: null, alert: null, agent: false }
  while (parts.length) {
    const k = parts.shift()
    if (k === 'agent') {
      r.agent = true
      continue
    }
    const v = parts.shift() ?? null
    if (k === 'i') r.incident = v
    else if (k === 'h') r.host = v
    else if (k === 's') r.service = v
    else if (k === 'a') r.alert = v
  }
  return r
}

export function href(r: Partial<Route> & { view?: View }): string {
  const view = r.view ?? 'wall'
  const seg: string[] = view === 'wall' ? [] : [view]
  if (r.incident) seg.push('i', encodeURIComponent(r.incident))
  if (r.host) seg.push('h', encodeURIComponent(r.host))
  if (r.service) seg.push('s', encodeURIComponent(r.service))
  if (r.alert) seg.push('a', encodeURIComponent(r.alert))
  if (r.agent && r.incident) seg.push('agent')
  return `#/${seg.join('/')}`
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(location.hash))
  useEffect(() => {
    const on = (): void => setRoute(parse(location.hash))
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return route
}
