// Whether the wall is drawn inside the embed view (views/Embed.tsx), i.e. in a chat app's right panel. The panel has its own Close and its
// own "Open Watch", so a sheet in the frame names where its exit goes ("Back to wall") instead of repeating Close.
// The same file holds the one way the frame speaks to the page that framed it (the status, the route, Escape and a reference: docs/embed.md).

import { createContext } from 'react'
import { href } from './route.ts'
import type { Route } from './route.ts'

export const EmbedContext = createContext(false)

/** True when a page frames this one (frame-ancestors has already let it through): the controls that talk to it show only then. */
export function framed(): boolean {
  return typeof window !== 'undefined' && window.parent !== window
}

/**
 * Who framed us, as the exact origin to answer: the browser's own answer (`location.ancestorOrigins`) where it has one, else the framing page as
 * `document.referrer` (the page `frame-ancestors` already let through). No configured list is needed, and a page that names neither origin gets no
 * message rather than one sent to a guess. The server's frame-ancestors stays the real gate against framing.
 */
export function parentOrigins(): string[] {
  const parent = location.ancestorOrigins?.[0]
  if (parent) return [parent]
  try {
    const from = new URL(document.referrer)
    if (from.protocol === 'https:' || from.protocol === 'http:') return [from.origin]
  } catch {
    // about:blank or a stripped referrer: nobody to name
  }
  return []
}

/** Say one thing to the page that framed us, to its exact origin and nobody else. */
export function tellParent(message: Record<string, unknown>): void {
  if (!framed()) return
  for (const origin of parentOrigins()) window.parent.postMessage(message, origin)
}

/** The Fleet view is open in the frame: a layer over the wall, the wall kept mounted under it so Back lands on the same scroll position (views/Embed.tsx). */
export const fleetOpen = (route: Pick<Route, 'view'>): boolean => route.view === 'fleet'

/**
 * The place the frame tells the page that framed it, so the panel's one "Open Watch" opens the full app at the same place. A sheet open over the
 * Fleet view is the same incident, host or service in the app, so it goes out in the form an older panel already knows (`#/i/<key>`); the Fleet view
 * itself goes out as `#/fleet`, which the full app opens as its Fleet page.
 */
export function embedPlace(route: Route, hash: string): string {
  if (!fleetOpen(route)) return hash
  if (route.incident || route.host || route.service) return href({ incident: route.incident, host: route.host, service: route.service, alert: route.alert })
  return href({ view: 'fleet' })
}

export type EscapeStep = 'sheet' | 'fleet' | 'parent'

/** What a bare Escape in the frame does: an open sheet takes it (its own cancel), the Fleet view steps back to the wall, and only the wall hands it to the panel, which closes. */
export function escapeStep(route: Pick<Route, 'view'>, dialogOpen: boolean): EscapeStep {
  if (dialogOpen) return 'sheet'
  return fleetOpen(route) ? 'fleet' : 'parent'
}
