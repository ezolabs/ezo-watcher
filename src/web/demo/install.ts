// Puts the demo Watcher (watcher.ts) behind the page's fetch: a request for /api on this origin is answered in the browser, after a short
// delay so the wall's pending states show as they would over a network; anything else (the app's own files) goes to the real fetch.
//
// The session lives in sessionStorage: a reload keeps what the visitor did and where the clock started, a new tab starts over, and
// `resetDemo` throws it away.

import type { DemoAct, DemoSession, Recording } from './watcher.ts'
import { DemoWatcher } from './watcher.ts'

export const SESSION_KEY = 'ezo-demo:session:v1'

interface SessionStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** The saved session when it is one, else a new one starting now. */
export function loadSession(store: SessionStore, nowMs: number): DemoSession {
  try {
    const raw = JSON.parse(store.getItem(SESSION_KEY) ?? 'null') as { anchorMs?: unknown; acts?: unknown } | null
    if (raw && typeof raw.anchorMs === 'number' && Number.isFinite(raw.anchorMs) && raw.anchorMs <= nowMs && Array.isArray(raw.acts)) {
      return { anchorMs: raw.anchorMs, acts: raw.acts as DemoAct[] }
    }
  } catch {
    // a session that does not parse is a new one
  }
  return { anchorMs: nowMs, acts: [] }
}

export function saveSession(store: SessionStore, session: DemoSession): void {
  try {
    store.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {
    // storage full or blocked: the demo still works for this page's life
  }
}

export function resetDemo(store: SessionStore): void {
  try {
    store.removeItem(SESSION_KEY)
  } catch {
    // nothing kept, nothing to clear
  }
}

async function bodyOf(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : null)
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

function headersOf(input: RequestInfo | URL, init?: RequestInit): Record<string, string> {
  const h = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((v, k) => h.set(k, v))
  const out: Record<string, string> = {}
  h.forEach((v, k) => {
    out[k] = v
  })
  return out
}

export interface InstallOptions {
  recording: Recording
  /** Where the session is kept; sessionStorage in the browser. */
  store: SessionStore
  /** The page's own fetch, for everything that is not /api. */
  fetch: typeof fetch
  origin: string
  now?: () => number
  /** How long an answer takes, in ms. */
  latencyMs?: () => number
}

/** Build the demo Watcher for this session and return the fetch that answers /api from it. */
export function demoFetch(o: InstallOptions): typeof fetch {
  const now = o.now ?? Date.now
  const session = loadSession(o.store, now())
  saveSession(o.store, session)
  const watcher = new DemoWatcher(o.recording, session, now)
  const latency = o.latencyMs ?? (() => 0)

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = input instanceof Request ? input.url : String(input)
    const url = new URL(href, o.origin)
    if (url.origin !== o.origin || !url.pathname.startsWith('/api/')) return o.fetch(input, init)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const body = await bodyOf(input, init)
    const wait = latency()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    const acts = session.acts.length
    const res = watcher.handle({ method, path: url.pathname + url.search, body, headers: headersOf(input, init) })
    if (session.acts.length !== acts) saveSession(o.store, session)
    return new Response(res.body, { status: res.status, headers: res.headers })
  }
}
