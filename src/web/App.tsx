import { Bell, History as HistoryIcon, LayoutGrid, RadioTower, Server } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { WallState } from '../shared/types.ts'
import { WallRecheck } from './components/Recheck.tsx'
import { NamePrompt } from './components/Who.tsx'
import { FleetStrip } from './components/FleetStrip.tsx'
import { Wall } from './components/Wall.tsx'
import type { Group } from './components/Wall.tsx'
import { HostSheet, IncidentSheet, ServiceSheet, Sheet } from './components/Sheets.tsx'
import { CellLegend, Empty, SkeletonWall } from './components/ui.tsx'
import { useWall } from './lib/api.ts'
import { useStatusFavicon } from './lib/favicon.ts'
import { useGrouped } from './lib/wall-prefs.ts'
import { statusCounts } from './lib/ack.ts'
import { agoText, clockText } from './lib/format.ts'
import { href, useRoute } from './lib/route.ts'
import type { View } from './lib/route.ts'
import { navFor, pageTitle, useInstance, viewShown } from './lib/instance.ts'
import { Fleet } from './views/Fleet.tsx'
import { History } from './views/History.tsx'
import { Notifications } from './views/Notifications.tsx'
import Embed from './views/Embed.tsx'
import { Sources } from './views/Sources.tsx'

/** The Status Eye's five bars on the 64-unit tile grid, the geometry of docs/assets/logo.svg: a circle cut into bars, the middle one split and its neighbours notched by the ring round the pupil. */
const MARK_BARS =
  'M24.66 15.75H39.34A1.75 1.75 0 0 1 40.13 15.94A18 18 0 0 1 41.2 16.53A2 2 0 0 1 40.18 20.25H23.82A2 2 0 0 1 22.8 16.53A18 18 0 0 1 23.87 15.94A1.75 1.75 0 0 1 24.66 15.75Z' +
  'M17.58 22.75H46.42A1.75 1.75 0 0 1 47.97 23.69A18 18 0 0 1 48.32 24.41A2 2 0 0 1 46.51 27.25H37.46A0.75 0.75 0 0 1 36.93 27.03A7 7 0 0 0 27.07 27.03A0.75 0.75 0 0 1 26.54 27.25H17.49A2 2 0 0 1 15.68 24.41A18 18 0 0 1 16.03 23.69A1.75 1.75 0 0 1 17.58 22.75Z' +
  'M14.25 29.75H24.4A0.75 0.75 0 0 1 25.13 30.65A7 7 0 0 0 25.13 33.35A0.75 0.75 0 0 1 24.4 34.25H14.25A2.25 2.25 0 0 1 14.25 29.75Z' +
  'M49.75 29.75H39.6A0.75 0.75 0 0 0 38.87 30.65A7 7 0 0 1 38.87 33.35A0.75 0.75 0 0 0 39.6 34.25H49.75A2.25 2.25 0 0 0 49.75 29.75Z' +
  'M17.58 41.25H46.42A1.75 1.75 0 0 0 47.97 40.31A18 18 0 0 0 48.32 39.59A2 2 0 0 0 46.51 36.75H37.46A0.75 0.75 0 0 0 36.93 36.97A7 7 0 0 1 27.07 36.97A0.75 0.75 0 0 0 26.54 36.75H17.49A2 2 0 0 0 15.68 39.59A18 18 0 0 0 16.03 40.31A1.75 1.75 0 0 0 17.58 41.25Z' +
  'M24.66 48.25H39.34A1.75 1.75 0 0 0 40.13 48.06A18 18 0 0 0 41.2 47.47A2 2 0 0 0 40.18 43.75H23.82A2 2 0 0 0 22.8 47.47A18 18 0 0 0 23.87 48.06A1.75 1.75 0 0 0 24.66 48.25Z'

/** The operator mark (the Status Eye), the mark's own box with a unit to spare each side; colour follows the text colour. The pupil only takes a colour in the tab icon (lib/favicon.ts). */
function Mark() {
  return (
    <svg viewBox="11 11 42 42" aria-hidden="true" fill="currentColor">
      <path d={MARK_BARS} />
      <circle cx="32" cy="32" r="4.5" />
    </svg>
  )
}

/** Every view in nav order. A Watcher shows the ones its server backs (lib/instance.ts `navFor`). */
export const NAV: Array<{ view: View; label: string; icon: ReactNode }> = [
  { view: 'wall', label: 'Wall', icon: <LayoutGrid aria-hidden="true" /> },
  { view: 'fleet', label: 'Fleet', icon: <Server aria-hidden="true" /> },
  { view: 'history', label: 'History', icon: <HistoryIcon aria-hidden="true" /> },
  { view: 'notifications', label: 'Notifications', icon: <Bell aria-hidden="true" /> },
  { view: 'sources', label: 'Sources', icon: <RadioTower aria-hidden="true" /> }
]

function useScheme(): [string, (s: string) => void] {
  const [scheme, setScheme] = useState(() => localStorage.getItem('watch-scheme') ?? 'auto')
  useEffect(() => {
    const apply = (): void => {
      const dark = scheme === 'dark' || (scheme === 'auto' && !matchMedia('(prefers-color-scheme: light)').matches)
      document.documentElement.setAttribute('data-scheme', dark ? 'dark' : 'light')
    }
    apply()
    localStorage.setItem('watch-scheme', scheme)
    const mq = matchMedia('(prefers-color-scheme: light)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [scheme])
  return [scheme, setScheme]
}

function Statusline({ state, error, nowMs }: { state: WallState; error: string | null; nowMs: number }) {
  const h = state.header
  const quiet = state.sources.filter((s) => s.state === 'stale').map((s) => s.id)
  if (h.stale && quiet.length > 0) {
    return (
      <p className="statusline" data-stale="true">
        <strong>The wall may be out of date.</strong> {quiet.join(' and ')} {quiet.length === 1 ? 'is' : 'are'} not answering, so an all clear cannot be trusted.
      </p>
    )
  }
  const counts = statusCounts(h)
  return (
    <p className="statusline">
      <strong>{h.rulesWatched} rules watched</strong>, <strong>{counts.firing}</strong>
      {counts.acknowledged && (
        <>
          , <strong>{counts.acknowledged}</strong>
        </>
      )}
      {counts.parked && (
        <>
          , <strong>{counts.parked}</strong>
        </>
      )}
      .
      {h.oldestEvaluationAt ? ` Oldest evaluation ${agoText(h.oldestEvaluationAt, nowMs)}.` : ''}
      {h.lastIncidentAt ? (
        <>
          {' '}
          Last incident {agoText(h.lastIncidentAt, nowMs)}, see <a className="link" href={href({ view: 'history' })}>History</a>.
        </>
      ) : (
        ' No incident recorded yet.'
      )}
      {error ? ` Connection lost, showing the wall from ${clockText(state.generatedAt)}.` : ''}
    </p>
  )
}

/** A view this Watcher does not back, opened by its address: said in one sentence, with the way back to the wall. */
export function NotConfigured({ view }: { view: View }) {
  const label = NAV.find((n) => n.view === view)?.label ?? view
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{label}</h1>
        </div>
      </div>
      <Empty
        sentence={`${label} is not configured on this Watcher.`}
        action={
          <a className="btn" href={href({ view: 'wall' })}>
            Open the wall
          </a>
        }
      />
    </>
  )
}

function App() {
  const route = useRoute()
  const { state, error, nowMs, reload } = useWall()
  // Which Watcher this is: the name in the header and the title, and the views its server backs (a hidden view's address says it is not configured)
  const { brand, features } = useInstance()
  const view: View | null = viewShown(route.view, features) ? route.view : null
  const [scheme, setScheme] = useScheme()
  const [group, setGroup] = useState<Group>(() => (localStorage.getItem('watch-group') === 'host' ? 'host' : 'service'))
  useEffect(() => localStorage.setItem('watch-group', group), [group])
  // the Group toggle: the wall's incidents under their category headings (lib/wall-prefs.ts); it only means something By service
  const [groupOn, setGroupOn] = useGrouped()

  const paging = state?.incidents.filter((i) => i.severity === 'page' && i.state.attention === 'none').length ?? 0
  useEffect(() => {
    document.title = pageTitle(brand.name, paging)
    const nav = navigator as unknown as { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> }
    if (paging > 0) void nav.setAppBadge?.(paging)
    else void nav.clearAppBadge?.()
  }, [paging, brand.name])
  // the tab icon's pupil: danger red while a page goes unattended, warn amber for such a warning (lib/favicon.ts)
  useStatusFavicon(state)

  // Keyboard: w, f, h, n, o jump between views (the ones this Watcher shows); g flips the grouping (By service or By host); c turns the category headings on or off. Ignored while a sheet is open.
  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select, [contenteditable]')) return
      const go: Record<string, View> = { w: 'wall', f: 'fleet', h: 'history', n: 'notifications', o: 'sources' }
      if (go[e.key] && viewShown(go[e.key], features)) location.hash = href({ view: go[e.key] })
      if (e.key === 'g' && route.view === 'wall') setGroup((g) => (g === 'service' ? 'host' : 'service'))
      if (e.key === 'c' && route.view === 'wall' && group === 'service') setGroupOn(!groupOn)
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [route.view, group, groupOn, setGroupOn, features])

  // the phone's bottom bar scrolls sideways (wall.css): the current view's item stays in sight
  useEffect(() => {
    document.querySelector('.nav a[aria-current="page"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [route.view])

  const sheetOpen = !!(route.incident || route.host || route.service)
  const from = useMemo(() => ({ view: route.view }), [route.view])
  // a service that no longer has a tile still opens its sheet, which then says so, never a blank dialog
  const serviceHealth = state?.health.find((h) => h.service === route.service) ?? (state && route.service ? { service: route.service, cells: [], firing: 0 } : undefined)

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <Mark />
          <span>{brand.name}</span>
        </div>
        <nav className="nav" aria-label="Main">
          {navFor(NAV, features).map((n) => (
            <a key={n.view} href={href({ view: n.view })} aria-current={route.view === n.view ? 'page' : undefined}>
              {n.icon}
              <span>{n.label}</span>
              {n.view === 'wall' && state && state.header.firing > 0 && <span className="count">{state.header.firing}</span>}
            </a>
          ))}
        </nav>
        <div className="side-foot">
          <div className="seg" role="group" aria-label="Colour scheme">
            {['light', 'dark', 'auto'].map((s) => (
              <button key={s} type="button" aria-pressed={scheme === s} onClick={() => setScheme(s)}>
                {s === 'light' ? 'Light' : s === 'dark' ? 'Dark' : 'Auto'}
              </button>
            ))}
          </div>
        </div>
      </aside>

      <main className="main" id="main">
        {view === null && <NotConfigured view={route.view} />}
        {view === 'wall' && (
          <>
            <div className="page-head">
              <div>
                <h1 className="page-title">Wall</h1>
                {state && <Statusline state={state} error={error} nowMs={nowMs} />}
                {state && (state.incidents.length > 0 || state.health.length > 0) && <CellLegend />}
              </div>
              <div className="tools">
                {state && <WallRecheck state={state} nowMs={nowMs} onDone={reload} />}
                <div className="seg" role="group" aria-label="Group by">
                  <button type="button" aria-pressed={group === 'service'} onClick={() => setGroup('service')}>
                    By service
                  </button>
                  <button type="button" aria-pressed={group === 'host'} onClick={() => setGroup('host')}>
                    By host
                  </button>
                </div>
                {group === 'service' && (
                  <div className="seg" role="group" aria-label="Category headings">
                    <button type="button" aria-pressed={groupOn} title="Show the incidents under their category headings (C)" aria-keyshortcuts="c" onClick={() => setGroupOn(!groupOn)}>
                      Group
                    </button>
                  </div>
                )}
              </div>
            </div>
            {viewShown('fleet', features) && <FleetStrip nowMs={nowMs} />}
            {!state && !error && <SkeletonWall />}
            {!state && error && (
              <Empty
                sentence="The Watcher cannot reach its server right now."
                action={
                  <button type="button" className="btn" onClick={reload}>
                    Try again
                  </button>
                }
              />
            )}
            {state && state.incidents.length === 0 && state.health.length === 0 && (
              <Empty sentence="No source is reporting yet." action={<a className="btn" href={href({ view: 'sources' })}>Open sources</a>} />
            )}
            {state && (state.incidents.length > 0 || state.health.length > 0) && <Wall state={state} nowMs={nowMs} group={group} onReload={reload} />}
            <p className="note kbd-hint">Arrow keys move between tiles, Enter opens one, A acknowledges, S silences for an hour, G switches grouping, C turns the category headings on or off.</p>
          </>
        )}
        {view === 'fleet' && <Fleet wall={state} nowMs={nowMs} />}
        {view === 'history' && <History nowMs={nowMs} />}
        {view === 'notifications' && <Notifications nowMs={nowMs} scheme={scheme} setScheme={setScheme} />}
        {view === 'sources' && (state ? <Sources state={state} nowMs={nowMs} /> : <SkeletonWall />)}
      </main>

      <NamePrompt />
      <Sheet open={sheetOpen} onClose={() => (location.hash = href(from))} titleId="sheet-title">
        {route.incident && (
          <IncidentSheet key={route.incident} incidentKey={route.incident} alertKey={route.alert} from={from} onChanged={reload} nowMs={nowMs} agentOpen={route.agent} />
        )}
        {route.host && state && <HostSheet name={route.host} state={state} from={from} />}
        {route.service && serviceHealth && <ServiceSheet health={serviceHealth} from={from} nowMs={nowMs} sources={state?.sources ?? []} />}
      </Sheet>
    </div>
  )
}

/** /embed is the wall without the app around it, for a chat panel or dashboard that frames it (views/Embed.tsx). */
export default function Root() {
  return location.pathname.replace(/\/+$/, '').startsWith('/embed') ? <Embed /> : <App />
}
