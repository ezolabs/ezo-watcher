// The embed view: the wall, compact and without app chrome, for a chat app's right panel (docs/embed.md). It is the same
// Wall and the same drill sheets as the app, so an incident opens in the frame and Acknowledge works there. It adds three things:
// a status object posted to the page that framed it (counts only, src/shared/summary.ts) with the place it is showing, the parent's
// light or dark scheme (the `theme` query, then a message from the parent, then the system), and, opened on its own, one
// "Open full Watch" link. Framed, that door is the panel's header ("Open Watch"), which follows the place posted here, so the frame
// carries no second one.
// The press only acknowledges itself: acknowledge() queues the request behind the settle seam (lib/act.ts, lib/settle.ts).
// Above the wall sits the Fleet strip (components/FleetStrip.tsx, hottest host first): one link, `#/fleet`, that opens the Fleet view (views/Fleet.tsx)
// as a layer over the wall inside the frame. The wall stays mounted and inert under it, so "Back to wall" (and Escape) lands on the same scroll position
// with nothing to save or restore; `/embed#/fleet` opens the frame on it.

import { ArrowLeft } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { FleetStrip } from '../components/FleetStrip.tsx'
import { NamePrompt } from '../components/Who.tsx'
import { Wall } from '../components/Wall.tsx'
import { HostSheet, IncidentSheet, ServiceSheet, Sheet } from '../components/Sheets.tsx'
import { Empty, SkeletonWall } from '../components/ui.tsx'
import { embedPlace, EmbedContext, escapeStep, fleetOpen, framed as isFramed, parentOrigins, tellParent as tell } from '../lib/embed.ts'
import { useWall } from '../lib/api.ts'
import { statusCounts } from '../lib/ack.ts'
import { clockText } from '../lib/format.ts'
import { href, useRoute } from '../lib/route.ts'
import { useInstance, viewShown } from '../lib/instance.ts'
import { summaryOf } from '../../shared/summary.ts'
import type { WallState } from '../../shared/types.ts'
import { Fleet, FLEET_TITLE_ID } from './Fleet.tsx'
import '../styles/embed.css'

function setScheme(scheme: string | null): void {
  if (scheme === 'dark' || scheme === 'light') document.documentElement.setAttribute('data-scheme', scheme)
}

/** The scheme comes from the page that framed us. Before it speaks: the `theme` query (theme.js applied it before first paint), else the system. */
function useParentScheme(): void {
  useEffect(() => {
    const on = (e: MessageEvent): void => {
      if (e.source !== window.parent || !parentOrigins().includes(e.origin)) return
      const data = e.data as { type?: unknown; theme?: unknown } | null
      if (data?.type === 'watcher:theme') setScheme(typeof data.theme === 'string' ? data.theme : null)
    }
    addEventListener('message', on)
    const mq = matchMedia('(prefers-color-scheme: light)')
    const system = (): void => {
      if (!new URLSearchParams(location.search).has('theme')) setScheme(mq.matches ? 'light' : 'dark')
    }
    mq.addEventListener('change', system)
    return () => {
      removeEventListener('message', on)
      mq.removeEventListener('change', system)
    }
  }, [])
}

/** One line of status, in the words of the app's status line: the stale case first, since an all clear has to be earned. */
function EmbedStatus({ state, error }: { state: WallState; error: string | null }) {
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
      <strong>{counts.firing}</strong>
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
      . {h.rulesWatched} rules watched.
      {error ? ` Connection lost, showing the wall from ${clockText(state.generatedAt)}.` : ''}
    </p>
  )
}

/** The Fleet view in the frame: a layer over the wall with its one way back (a link to the wall, so it is a keystroke and a tap as well as a click) fixed above the table. */
export function FleetLayer({ state, nowMs }: { state: WallState | null; nowMs: number }) {
  return (
    <section className="embed__fleet" aria-labelledby={FLEET_TITLE_ID}>
      <div className="embed__fleet-bar">
        <a className="btn" href={href({ view: 'wall' })} data-back="fleet">
          <ArrowLeft aria-hidden="true" />
          Back to wall
        </a>
      </div>
      <div className="embed__fleet-body">
        <Fleet wall={state} nowMs={nowMs} />
      </div>
    </section>
  )
}

/** Focus follows the view that opens or closes, never the first paint: into the layer on its Back link, and home to the strip's link when it closes. */
function useFleetFocus(open: boolean): void {
  const was = useRef(open)
  useEffect(() => {
    if (open === was.current) return
    was.current = open
    const target = document.querySelector<HTMLElement>(open ? '.embed__fleet [data-back]' : '.embed .fstrip__link')
    target?.focus({ preventScroll: true })
  }, [open])
}

export default function Embed() {
  const route = useRoute()
  const { state, error, nowMs, reload } = useWall()
  // the frame names this Watch, and draws the fleet strip only where the server has a fleet to show
  const { brand, features } = useInstance()
  useParentScheme()

  // The status object for the page that framed us: when the wall changes, and once per clock tick as a heartbeat.
  const summary = useMemo(() => (state ? summaryOf(state) : null), [state])
  useEffect(() => {
    if (summary) tell({ type: 'ezo-watcher:status', ...summary })
  }, [summary, nowMs])

  // Where the frame is showing (an incident open here is open in the app, the Fleet view is its Fleet page), so the panel's one "Open Watch" opens the same place.
  const place = embedPlace(route, location.hash)
  useEffect(() => {
    tell({ type: 'ezo-watcher:route', hash: place })
  }, [place])

  // Escape: an open sheet takes it; in the Fleet view it steps back to the wall; on the wall it steps the parent back (a key pressed in this frame never
  // reaches the page that framed it). The press only acknowledges itself: the hash changes, and React draws the wall behind it.
  const fleet = fleetOpen(route)
  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const step = escapeStep({ view: route.view }, !!document.querySelector('dialog[open]'))
      if (step === 'fleet') location.hash = href({ view: 'wall' })
      else if (step === 'parent') tell({ type: 'ezo-watcher:escape' })
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [route.view])
  useFleetFocus(fleet)

  const sheetOpen = !!(route.incident || route.host || route.service)
  const from = useMemo(() => ({ view: 'wall' as const }), [])
  const serviceHealth = state?.health.find((h) => h.service === route.service) ?? (state && route.service ? { service: route.service, cells: [], firing: 0 } : undefined)
  const none = !!state && state.incidents.length === 0 && state.health.length === 0
  // framed by the chat panel (frame-ancestors lets in no one else): the panel's header is the door to the full app. On its own, this page has one.
  const framed = isFramed()
  // the full app opens at the same place: an incident open here is open there
  const full = `/${route.incident || route.host || route.service ? location.hash : ''}`

  return (
    <EmbedContext.Provider value={true}>
      <div className="embed">
        <main className="embed__main" id="main">
          <h1 className="sr-only">{brand.name}</h1>
          <div className="embed__wall" inert={fleet}>
            <header className="embed__bar">
              {state ? <EmbedStatus state={state} error={error} /> : <div className="skeleton embed__skel" role="status" aria-label="Loading the wall" />}
              {state && !none && !framed && (
                <a className="btn" href={full} target="_blank" rel="noopener noreferrer">
                  Open full Watch
                </a>
              )}
            </header>
            {viewShown('fleet', features) && <FleetStrip nowMs={nowMs} />}
            {!state && !error && <SkeletonWall />}
            {!state && error && (
              <Empty
                sentence="Watch cannot reach its server right now."
                action={
                  <button type="button" className="btn" onClick={reload}>
                    Try again
                  </button>
                }
              />
            )}
            {none && (
              <Empty
                sentence="No source is reporting yet."
                action={
                  framed ? (
                    <button type="button" className="btn" onClick={reload}>
                      Check again
                    </button>
                  ) : (
                    <a className="btn" href="/#/sources" target="_blank" rel="noopener noreferrer">
                      Open full Watch
                    </a>
                  )
                }
              />
            )}
            {state && !none && <Wall state={state} nowMs={nowMs} group="service" onReload={reload} />}
          </div>
          {fleet && <FleetLayer state={state} nowMs={nowMs} />}
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
    </EmbedContext.Provider>
  )
}
