// The note the hosted demo keeps above the wall: what this page is, what an agent reads from it (the one button: the panel in
// AgentPanel.tsx), how to start it over, where the code lives. One line on a wide screen, wrapping on a phone; gone for the session once
// the visitor hides it. Its height is published as --demo-strip-h so demo.css can fit the sidebar and the page under it.

import { SquareTerminal, X } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { AGENTS_HASH } from './AgentPanel.tsx'

export const REPO_URL = 'https://github.com/ezolabs/ezo-watcher'
export const STRIP_HIDDEN_KEY = 'ezo-demo:strip-hidden'

function readHidden(): boolean {
  try {
    return sessionStorage.getItem(STRIP_HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

export function DemoStrip({ onReset }: { onReset: () => void }) {
  const [hidden, setHidden] = useState(readHidden)
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const root = document.documentElement
    const el = ref.current
    if (hidden || !el) return
    const size = (): void => root.style.setProperty('--demo-strip-h', `${el.offsetHeight}px`)
    size()
    const watch = new ResizeObserver(size)
    watch.observe(el)
    return () => {
      watch.disconnect()
      root.style.removeProperty('--demo-strip-h')
    }
  }, [hidden])

  if (hidden) return null
  const hide = (): void => {
    try {
      sessionStorage.setItem(STRIP_HIDDEN_KEY, '1')
    } catch {
      // hidden for this page's life only
    }
    setHidden(true)
  }

  return (
    <div className="demo-strip" ref={ref} role="region" aria-label="About this demo">
      <p className="demo-strip__text">
        <span className="chip demo-strip__chip">Demo</span> Sample data from a fictional company. What you do here stays in this browser.
      </p>
      <div className="demo-strip__actions">
        <a className="btn demo-strip__agents" href={AGENTS_HASH}>
          <SquareTerminal aria-hidden="true" />
          What agents see
        </a>
        <button type="button" className="link demo-strip__action" onClick={onReset}>
          Start over
        </button>
        <a className="link demo-strip__action" href={REPO_URL} target="_blank" rel="noreferrer">
          Source on GitHub
        </a>
        <button type="button" className="demo-strip__hide" aria-label="Hide this note" onClick={hide}>
          <X aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
