// The hosted demo's entry (vite.demo.config.ts swaps it in for src/web/main.tsx): the real wall, with its /api answered in the browser from
// a recording (watcher.ts) instead of by a server. No service worker: the demo has no pushes to receive and nothing to cache offline.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/index.css'
import './demo.css'
import Root from '../App.tsx'
import { inEmbed } from '../lib/api.ts'
import { DemoAgents } from './AgentPanel.tsx'
import { DemoStrip } from './DemoStrip.tsx'
import recording from './fixtures/recording.json'
import { demoFetch, resetDemo } from './install.ts'
import type { Recording } from './watcher.ts'

window.fetch = demoFetch({
  recording: recording as unknown as Recording,
  store: sessionStorage,
  fetch: window.fetch.bind(window),
  origin: location.origin,
  // a network's worth of delay, so an acknowledgement's pending state shows as it would against a server
  latencyMs: () => 90 + Math.round(Math.random() * 160)
})

/** Throw the session away and open the wall as a new visitor sees it: a URL with no fragment is a full load, never a jump within the page. */
function startOver(): void {
  resetDemo(sessionStorage)
  location.replace(location.pathname + location.search)
}

// A framed wall (/embed, or a link that asked for ?embed=1) has no room for the note; the page around the frame says what it is.
createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    {inEmbed(location) ? null : <DemoStrip onReset={startOver} />}
    <Root />
    {inEmbed(location) ? null : <DemoAgents />}
  </StrictMode>
)
