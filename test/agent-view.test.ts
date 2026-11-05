// "What your agent sees" in the incident sheet (src/web/components/AgentView.tsx): the fix brief as the MCP tool get_fix_context answers it,
// the call that fetches it, the CLI's way to the same brief, and a Copy for each. The markup runs the real components through react-dom/server,
// over a brief the demo recording holds (scripts/demo-record.mjs ran the real fixContextOf for it).
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import recordingJson from '../src/web/demo/fixtures/recording.json'
import { AgentFold, AgentFoldBody } from '../src/web/components/AgentView.tsx'
import { cliFixContext, fixContextPath, mcpCall, mcpText } from '../src/web/lib/agent-brief.ts'
import { href, parse } from '../src/web/lib/route.ts'
import type { Recording } from '../src/web/demo/watcher.ts'

const recording = recordingJson as unknown as Recording
const KEY = 'Checkout API|ProbeDown'
const BRIEF = recording.agent.fixContext[KEY] as Record<string, unknown>

/** The text react-dom/server writes for a string: what the page shows, escaped. */
const escaped = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')

describe('the incident sheet: what your agent sees', () => {
  it('shows the brief character for character, as the MCP tool answers it, with a Copy', () => {
    const html = renderToStaticMarkup(createElement(AgentFoldBody, { incidentKey: KEY, brief: BRIEF, error: null, reading: true }))
    const text = mcpText(BRIEF)
    // one space of indent: the MCP server's own JSON.stringify(data, null, 1)
    expect(text).toBe(JSON.stringify(BRIEF, null, 1))
    expect(html).toContain(`<pre class="term__out agent__out" role="region" aria-label="The brief get_fix_context answers" tabindex="0">${escaped(text)}</pre>`)
    // what an agent needs from it is there to read: the target's config, the failed check, the last good and bad answers, the re-check
    for (const field of ['"target"', '"failed"', '"lastGood"', '"lastBad"', '"reproduce"', '"watcher": "watcher recheck', '"next"']) expect(html).toContain(escaped(field))
    expect(html).toContain(`${text.split('\n').length} lines of JSON`)
    expect(html).toContain('Copy<span class="sr-only"> the brief</span>')
  })

  it('names the MCP call that fetches it and the CLI command that prints it, each with its own Copy', () => {
    const html = renderToStaticMarkup(createElement(AgentFoldBody, { incidentKey: KEY, brief: BRIEF, error: null, reading: true }))
    expect(mcpCall('get_fix_context', { key: KEY })).toBe('get_fix_context {"key":"Checkout API|ProbeDown"}')
    expect(html).toContain(`<code class="term__text">${escaped('get_fix_context {"key":"Checkout API|ProbeDown"}')}</code>`)
    expect(cliFixContext(KEY)).toBe("watcher incident 'Checkout API|ProbeDown' --fix-context --json")
    expect(html).toContain(`<code class="term__text">${escaped(cliFixContext(KEY))}</code>`)
    expect(html).toContain('Copy<span class="sr-only"> the MCP call</span>')
    expect(html).toContain('Copy<span class="sr-only"> the command</span>')
    // a key with a quote in it stays one shell word
    expect(cliFixContext("Bob's API|Down")).toBe(`watcher incident 'Bob'\\''s API|Down' --fix-context --json`)
  })

  it('says why there is no brief, and shows loading lines while it is read', () => {
    const gone = renderToStaticMarkup(createElement(AgentFoldBody, { incidentKey: KEY, brief: null, error: '404', reading: true }))
    expect(gone).toContain('The Watcher no longer holds this incident, so there is no brief for it.')
    expect(gone).not.toContain('agent__out')
    const failed = renderToStaticMarkup(createElement(AgentFoldBody, { incidentKey: KEY, brief: null, error: '502', reading: true }))
    expect(failed).toContain('It is tried again every few seconds.')
    const loading = renderToStaticMarkup(createElement(AgentFoldBody, { incidentKey: KEY, brief: null, error: null, reading: true }))
    expect(loading).toContain('role="status" aria-label="Reading what the agent sees"')
  })

  it('is a fold, closed unless the route asks for it, and reads the endpoint the CLI and the MCP tool share', () => {
    const closed = renderToStaticMarkup(createElement(AgentFold, { incidentKey: KEY, asked: false, revision: 'none' }))
    expect(closed).toMatch(/^<details class="fold agent" id="agent"><summary>.*What your agent sees<\/summary>/)
    const asked = renderToStaticMarkup(createElement(AgentFold, { incidentKey: KEY, asked: true, revision: 'none' }))
    expect(asked).toMatch(/^<details class="fold agent" id="agent" open="">/)
    expect(fixContextPath(KEY)).toBe('/api/incidents/Checkout%20API%7CProbeDown/fix-context')
    // the sheet puts it after the Labels and Raw folds
    const sheets = readFileSync(new URL('../src/web/components/Sheets.tsx', import.meta.url), 'utf8')
    expect(sheets.indexOf('<AgentFold')).toBeGreaterThan(sheets.indexOf('<Disclosures'))
    expect(sheets.indexOf('<AgentFold')).toBeLessThan(sheets.indexOf('<Comments'))
  })
})

describe('the route to it', () => {
  it('opens an incident on its agent view with a trailing flag, and keeps an instance', () => {
    expect(href({ view: 'wall', incident: KEY, agent: true })).toBe('#/i/Checkout%20API%7CProbeDown/agent')
    expect(parse('#/i/Checkout%20API%7CProbeDown/agent')).toEqual({ view: 'wall', incident: KEY, host: null, service: null, alert: null, agent: true })
    const withAlert = href({ view: 'history', incident: KEY, alert: 'a1', agent: true })
    expect(withAlert).toBe('#/history/i/Checkout%20API%7CProbeDown/a/a1/agent')
    expect(parse(withAlert)).toMatchObject({ view: 'history', incident: KEY, alert: 'a1', agent: true })
    expect(parse('#/i/Checkout%20API%7CProbeDown').agent).toBe(false)
    // only an incident has an agent view
    expect(href({ view: 'wall', agent: true })).toBe('#/')
  })
})

describe('agent.css', () => {
  it('takes every colour, size and space from tokens.css', () => {
    // comments and the phone breakpoint (the wall's own `max-width: 40rem`) aside
    const css = readFileSync(new URL('../src/web/styles/agent.css', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@media \(max-width: 40rem\)/g, '')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(css).not.toMatch(/\b\d+(\.\d+)?(px|rem|em)\b/)
    expect(css).not.toMatch(/rgba?\(|hsla?\(|oklch\(/)
    const tokens = readFileSync(new URL('../src/web/styles/tokens.css', import.meta.url), 'utf8')
    for (const name of css.match(/var\(--[a-z0-9-]+/g) ?? []) expect(tokens, name).toContain(`${name.slice(4)}:`)
    expect(readFileSync(new URL('../src/web/styles/index.css', import.meta.url), 'utf8')).toContain("@import './agent.css';")
  })
})
