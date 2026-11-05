// Which Watch this page belongs to: the name it shows and the views its server backs (src/shared/instance.ts, src/server/instance.ts). The server
// writes it into the page it serves (a `watch-instance` meta), so the first paint already has the right title, header and nav. The dev server's
// page has no meta: it starts from every view under the default name and asks GET /api/instance once.

import { useEffect, useState } from 'react'
import { INSTANCE_META, fullInstance, parseInstance } from '../../shared/instance.ts'
import type { InstanceInfo, WatchFeature } from '../../shared/types.ts'
import type { View } from './route.ts'

/** The views every Watch has, whatever its config: the wall and what it is built from. */
export const ALWAYS_VIEWS: readonly View[] = ['wall', 'history', 'notifications', 'sources']

const FEATURE_VIEWS: ReadonlySet<string> = new Set<WatchFeature>(['fleet'])

/** Whether this Watch shows a view: always for the four every Watch has, else only when its server backs it. */
export function viewShown(view: View, features: readonly WatchFeature[]): boolean {
  if (ALWAYS_VIEWS.includes(view)) return true
  return FEATURE_VIEWS.has(view) && features.includes(view as WatchFeature)
}

/** The nav entries this Watch shows, in the nav's own order. */
export function navFor<T extends { view: View }>(nav: readonly T[], features: readonly WatchFeature[]): T[] {
  return nav.filter((n) => viewShown(n.view, features))
}

/** The page title: the brand, with the count of unattended pages in front while there are any. */
export function pageTitle(brand: string, paging: number): string {
  return paging > 0 ? `(${paging}) ${brand}` : brand
}

/** What the served page says, or null for a page with no meta (the dev server's) or one that does not read as an instance. Never throws. */
export function instanceFromDocument(doc: Pick<Document, 'querySelector'> | undefined): InstanceInfo | null {
  try {
    const raw = typeof doc?.querySelector === 'function' ? doc.querySelector(`meta[name="${INSTANCE_META}"]`)?.getAttribute('content') : null
    return raw ? parseInstance(JSON.parse(raw) as unknown) : null
  } catch {
    return null
  }
}

/** Read once per page: the meta, else the server's answer once it comes. */
let known: InstanceInfo | null = null
let asked: Promise<InstanceInfo | null> | null = null

/** The one /api read outside `read()`: /api/instance is exempt from the admin gate (src/server/auth.ts `adminExemptPath`), so it never answers 401. */
function ask(): Promise<InstanceInfo | null> {
  asked ??= fetch('/api/instance')
    .then(async (res) => (res.ok ? parseInstance((await res.json()) as unknown) : null))
    .catch(() => null)
  return asked
}

/** This page's Watch. Never blank: until the server has said, the default name and every view. */
export function useInstance(): InstanceInfo {
  const [info, setInfo] = useState<InstanceInfo>(() => {
    known ??= instanceFromDocument(typeof document === 'undefined' ? undefined : document)
    return known ?? fullInstance()
  })
  useEffect(() => {
    if (known) return
    let live = true
    void ask().then((got) => {
      if (!got || !live) return
      known = got
      setInfo(got)
    })
    return () => {
      live = false
    }
  }, [])
  return info
}
