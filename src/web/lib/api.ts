import { useCallback, useEffect, useRef, useState } from 'react'
import type { PushedSender } from '../../shared/recheck.ts'
import type { Alert, AlertEvent, FleetView, HistoryRow, Incident, IncidentComment, WallState } from '../../shared/types.ts'

/** An alert as the incident sheet fetches it: with the pushing senders that report it, their schedule and where the latest re-check request stands. Absent from a server that predates it. */
export interface DetailAlert extends Alert {
  pushed?: PushedSender[]
}

export interface IncidentDetail {
  incident: Incident | null
  alerts: DetailAlert[]
  events: AlertEvent[]
  resolved: HistoryRow | null
  /** Oldest first. Absent from a server that predates comments. */
  comments?: IncidentComment[]
  notifications: Array<{ at: number; route_id: string; channel_id: string; kind: string; ok: number; status: string; latency_ms: number }>
}

export interface NotificationsInfo {
  channels: Array<{ id: string; type: string; enabled: boolean; lastTestAt: string | null; lastTestOk: boolean | null; lastTest: 'passed' | 'failed' | 'unconfigured' | null }>
  routes: Array<{
    id: string
    match: { severity?: string[]; origin?: string[] }
    receivers: string[]
    mode: string
    record?: string[]
    groupWaitSec: number
    groupIntervalSec: number
    repeatIntervalSec: number
    escalate?: Array<{ afterSec: number; receivers: string[] }>
    coalesce?: { maxPages?: number; windowSec?: number }
    muteInQuietHours?: boolean
    sendResolved?: boolean
  }>
  quietHours: { tz: string; start: string; end: string } | null
  results: Array<{ at: number; incident_key: string; route_id: string; channel_id: string; kind: string; ok: number; status: string; latency_ms: number }>
  push: { publicKey: string | null; subscribers: number }
}

/** TRUE in the embed view: `/embed` (App.tsx) or a link that asked for `?embed=1` (the alert card's own link, src/server/app.ts). */
export function inEmbed(place: Pick<Location, 'pathname' | 'search'>): boolean {
  return place.pathname.replace(/\/+$/, '').startsWith('/embed') || new URLSearchParams(place.search).get('embed') === '1'
}

/** The server's login page (src/server/auth.ts), holding this exact place for after the sign-in: the fragment carries the open sheet. */
export function loginHref(place: Pick<Location, 'pathname' | 'search' | 'hash'>): string {
  return `/login?next=${encodeURIComponent(place.pathname + place.search + place.hash)}`
}

/** The page already asked for the sign-in this load: a poll that fires again before the navigation lands must not ask twice. */
let sentToLogin = false

/**
 * A 401 from an /api read sends the browser to the login page once. The server answers 401 only for an /api request whose session cookie has
 * lapsed behind WATCHER_ADMIN_TOKEN (src/server/app.ts), so the session expired, not the request. Any other status does nothing, and so does a
 * page already on the login page (a redirect from there would loop) or the embed view: the frame in a chat panel has no login form to show, so it
 * keeps its error state ("Connection lost") and the panel's own page, on the same site and cookie, is where a person signs in again.
 */
export function loginOn401(status: number): void {
  if (status !== 401 || sentToLogin) return
  if (typeof location === 'undefined' || location.pathname.replace(/\/+$/, '') === '/login' || inEmbed(location)) return
  sentToLogin = true
  location.assign(loginHref(location))
}

/** One read: the wall's poll, the fleet's poll and every JSON call pass through here, so all of them hand a lapsed session to `loginOn401`. */
async function read(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, init)
  loginOn401(res.status)
  return res
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await read(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
  if (!res.ok) throw new Error(`${res.status}`)
  return (await res.json()) as T
}

/** Poll the whole wall with an ETag: a 304 costs nothing and the layout does not move. */
export function useWall(): { state: WallState | null; error: string | null; nowMs: number; reload: () => void } {
  const [state, setState] = useState<WallState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nowMs, setNow] = useState<number>(() => Date.now())
  const etag = useRef<string | null>(null)
  const offset = useRef(0)

  const load = useCallback(async () => {
    try {
      const res = await read('/api/state', { headers: etag.current ? { 'if-none-match': etag.current } : {} })
      const server = res.headers.get('x-server-time')
      if (server) offset.current = Date.parse(server) - Date.now()
      if (res.status === 304) {
        setError(null)
        return
      }
      if (!res.ok) throw new Error(`state ${res.status}`)
      etag.current = res.headers.get('etag')
      setState((await res.json()) as WallState)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
    const poll = setInterval(() => {
      if (!document.hidden) void load()
    }, 5000)
    const clock = setInterval(() => setNow(Date.now() + offset.current), 15000)
    const visible = (): void => {
      if (!document.hidden) void load()
    }
    document.addEventListener('visibilitychange', visible)
    return () => {
      clearInterval(poll)
      clearInterval(clock)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [load])

  // Each fresh state also resets the clock to the server's.
  useEffect(() => {
    if (state) setNow(Date.now() + offset.current)
  }, [state])

  return { state, error, nowMs, reload: () => void load() }
}

export function useFetch<T>(path: string | null, refreshMs = 5000): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    if (!path) return
    api<T>(path)
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
  }, [path])
  useEffect(() => {
    setData(null)
    reload()
    if (!path || !refreshMs) return
    const t = setInterval(() => {
      if (!document.hidden) reload()
    }, refreshMs)
    return () => clearInterval(t)
  }, [path, refreshMs, reload])
  return { data, error, reload }
}

/**
 * What the fleet view knows: the first read is loading; a 503 (the source is not configured on this host) or a 404 (a server that predates the
 * endpoint) is `none`; a first read that failed is `error`. A later failed poll keeps the last good view and sets `offline`, never blanks the page.
 */
export type FleetState = { status: 'loading' } | { status: 'none' } | { status: 'error' } | { status: 'ready'; view: FleetView }

/** Until a response says its own pollSec, ask once a minute: the cadence the netdata-fleet source refreshes at. */
const FLEET_POLL_FALLBACK_MS = 60_000
/** The last good view, kept for the page's life: moving between the wall's strip and the Fleet page paints it at once and reconciles in the background. */
let fleetCache: FleetView | null = null

/** Poll /api/fleet at the feed's own pollSec (read from each response), paused while the tab is hidden and caught up when it shows again. */
export function useFleet(): { state: FleetState; offline: boolean; reload: () => void } {
  const [state, setState] = useState<FleetState>(() => (fleetCache ? { status: 'ready', view: fleetCache } : { status: 'loading' }))
  const [offline, setOffline] = useState(false)
  const [pollMs, setPollMs] = useState(() => (fleetCache ? fleetCache.pollSec * 1000 : FLEET_POLL_FALLBACK_MS))

  const load = useCallback(async () => {
    try {
      const res = await read('/api/fleet')
      if (res.status === 503 || res.status === 404) {
        fleetCache = null
        setState({ status: 'none' })
        setOffline(false)
        return
      }
      if (!res.ok) throw new Error(`fleet ${res.status}`)
      const view = (await res.json()) as FleetView
      fleetCache = view
      setState({ status: 'ready', view })
      setPollMs(view.pollSec > 0 ? view.pollSec * 1000 : FLEET_POLL_FALLBACK_MS)
      setOffline(false)
    } catch {
      if (fleetCache) {
        setState({ status: 'ready', view: fleetCache })
        setOffline(true)
      } else {
        setState({ status: 'error' })
      }
    }
  }, [])

  useEffect(() => {
    void load()
    const poll = setInterval(() => {
      if (!document.hidden) void load()
    }, pollMs)
    const visible = (): void => {
      if (!document.hidden) void load()
    }
    document.addEventListener('visibilitychange', visible)
    return () => {
      clearInterval(poll)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [load, pollMs])

  return { state, offline, reload: () => void load() }
}
