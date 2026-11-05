// The demo's "What agents see" (src/web/demo/AgentPanel.tsx, DemoStrip.tsx) and the fix brief the demo Watcher answers (watcher.ts): what an
// agent would read from this wall, live, so an acknowledgement or a park the visitor makes shows in the session brief, in watch_state and
// in the incident's own brief.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import recordingJson from '../src/web/demo/fixtures/recording.json'
import { AGENTS_HASH, AgentPanelBody, isAgentsHash, watchStateExcerpt } from '../src/web/demo/AgentPanel.tsx'
import { DemoStrip } from '../src/web/demo/DemoStrip.tsx'
import { DemoWatcher, type DemoResponse, type Recording } from '../src/web/demo/watcher.ts'
import { AGENT_TOOLS, mcpText, statusBrief } from '../src/web/lib/agent-brief.ts'
import type { WallState } from '../src/shared/types.ts'

const recording = recordingJson as unknown as Recording
const OPENED = Date.parse('2027-03-14T09:26:53.000Z')
const PAGE = 'Checkout API|ProbeDown'
const PARKED = 'Payments|StripeWebhookStale'
const enc = encodeURIComponent

function demo() {
  const clock = { now: OPENED }
  const w = new DemoWatcher(recording, { anchorMs: OPENED, acts: [] }, () => clock.now)
  const call = (method: string, path: string, body?: unknown): DemoResponse => w.handle({ method, path, body })
  const json = <T,>(r: DemoResponse): T => JSON.parse(r.body as string) as T
  const brief = (key: string) => json<{ state: Record<string, unknown>; ageSec: number; related: unknown[]; lastSeen: string }>(call('GET', `/api/incidents/${enc(key)}/fix-context`))
  const wall = () => json<WallState>(call('GET', '/api/state'))
  return { clock, call, json, brief, wall }
}

/** The text react-dom/server writes for a string. */
const escaped = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')

describe('the fix brief the demo answers', () => {
  it('is the recorded brief, its age and its times moved to now', () => {
    const { brief, clock } = demo()
    const recorded = recording.agent.fixContext[PAGE] as { ageSec: number; state: Record<string, unknown> }
    const first = brief(PAGE)
    expect(first.state).toEqual(recorded.state)
    expect(first.ageSec).toBe(recorded.ageSec)
    expect(Date.parse(first.lastSeen)).toBe(OPENED)
    clock.now += 90_000
    expect(brief(PAGE).ageSec).toBe(recorded.ageSec + 90)
  })

  it('says who has the incident as the visitor left it: an acknowledgement, a silence, a park and its end', () => {
    const { brief, call, clock } = demo()
    expect(call('POST', `/api/incidents/${enc(PAGE)}/ack`, { by: 'Robin' }).status).toBe(200)
    expect(brief(PAGE).state).toMatchObject({ firing: true, attention: 'acked', ackedBy: 'Robin', parkedState: null })
    call('POST', `/api/incidents/${enc(PAGE)}/unack`, { by: 'Robin' })
    expect(brief(PAGE).state).toMatchObject({ attention: 'none', ackedBy: null })

    call('POST', `/api/incidents/${enc(PAGE)}/silence`, { by: 'Robin', minutes: 30 })
    expect(brief(PAGE).state).toMatchObject({ attention: 'silenced', silencedUntil: new Date(clock.now + 30 * 60_000).toISOString() })
    call('POST', `/api/incidents/${enc(PAGE)}/unack`, { by: 'Robin' })

    const until = new Date(OPENED + 3_600_000).toISOString()
    expect(call('POST', `/api/incidents/${enc(PAGE)}/park`, { by: 'Robin', state: 'deferred', until, note: 'after the freeze' }).status).toBe(200)
    expect(brief(PAGE).state).toMatchObject({ attention: 'parked', parkedState: 'deferred', parkedUntil: until })

    // the agent's own recorded park, then the visitor ending it
    expect(brief(PARKED).state).toMatchObject({ attention: 'parked', parkedState: 'fixed_undeployed' })
    expect(call('POST', `/api/incidents/${enc(PARKED)}/unpark`, { by: 'Robin' }).status).toBe(200)
    expect(brief(PARKED).state).toMatchObject({ attention: 'none', parkedState: null, parkedUntil: null })
  })

  it('answers no brief for a key it does not hold, in the server words', () => {
    const { call, json } = demo()
    const gone = call('GET', `/api/incidents/${enc('Nowhere|Nothing')}/fix-context`)
    expect(gone.status).toBe(404)
    expect(json<{ error: string }>(gone).error).toBe('no incident Nowhere|Nothing. Use watch_state or list_incidents for the keys the Watcher has.')
  })
})

describe('what agents see, the panel', () => {
  it('shows the session brief, a watch_state excerpt, a way into each brief and the tools', () => {
    const { wall } = demo()
    const w = wall()
    const html = renderToStaticMarkup(createElement(AgentPanelBody, { wall: w }))
    expect(html).toContain('<code class="term__text">watcher status --brief</code>')
    // one block per line, so a long one wraps under a hanging indent
    expect(html).toContain(statusBrief(w, OPENED).map((l) => `<span class="agent__line">${escaped(l)}</span>`).join(''))
    expect(html).toContain('<code class="term__text">watch_state {}</code>')
    expect(html).toContain(escaped(mcpText(watchStateExcerpt(w))))
    for (const i of w.incidents) expect(html).toContain(`href="#/i/${enc(i.key)}/agent"`)
    for (const t of AGENT_TOOLS) expect(html).toContain(`<dt><code>${t.name}</code></dt><dd>${escaped(t.line)}</dd>`)
    expect(html).toContain('The first 6 only read; the other 10 act')
  })

  it('changes when the visitor acknowledges or parks: the counts, who has it, and the session brief', () => {
    const { wall, call } = demo()
    const before = watchStateExcerpt(wall())
    expect(before.text).toMatch(/^3 firing; 2 unattended, 1 acknowledged, 0 silenced; 1 page, 2 warning, 0 info; 1 parked/)
    call('POST', `/api/incidents/${enc(PAGE)}/ack`, { by: 'Robin' })
    const acked = watchStateExcerpt(wall())
    expect(acked.counts).toMatchObject({ unattended: before.counts.unattended - 1, acknowledged: before.counts.acknowledged + 1 })
    expect(acked.incidents.find((r) => r.key === PAGE)).toMatchObject({ attention: 'acked', ackedBy: 'Robin' })
    const html = renderToStaticMarkup(createElement(AgentPanelBody, { wall: wall() }))
    expect(html).toContain('Checkout API, acknowledged by Robin')

    // an acknowledgement outranks a park (src/shared/incident.ts), so it comes off first
    call('POST', `/api/incidents/${enc(PAGE)}/unack`, { by: 'Robin' })
    call('POST', `/api/incidents/${enc(PAGE)}/park`, { by: 'Robin', state: 'deferred', until: new Date(OPENED + 3_600_000).toISOString(), note: 'after the freeze' })
    const parked = wall()
    expect(watchStateExcerpt(parked).counts.parked).toBe(before.counts.parked + 1)
    expect(statusBrief(parked, OPENED).some((l) => l.endsWith(PAGE))).toBe(false)
    expect(renderToStaticMarkup(createElement(AgentPanelBody, { wall: parked }))).toContain('Checkout API, parked by Robin')
  })

  it('says so when nothing is open, and shows loading lines before the wall is in', () => {
    const { wall } = demo()
    const quiet = { ...wall(), incidents: [] }
    const html = renderToStaticMarkup(createElement(AgentPanelBody, { wall: quiet }))
    expect(html).toContain('It prints nothing: no incident is open.')
    expect(html).toContain('Nothing is firing, so there is no brief to read.')
    expect(renderToStaticMarkup(createElement(AgentPanelBody, { wall: null }))).toContain('aria-label="Reading what the agent sees"')
  })

  it('opens from the demo strip, by a link a README can point at', () => {
    expect(AGENTS_HASH).toBe('#/agents')
    expect(isAgentsHash('#/agents')).toBe(true)
    expect(isAgentsHash('#/agents/')).toBe(true)
    expect(isAgentsHash('#/')).toBe(false)
    expect(isAgentsHash(`#/i/${enc(PAGE)}/agent`)).toBe(false)
    const strip = renderToStaticMarkup(createElement(DemoStrip, { onReset: () => {} }))
    expect(strip).toMatch(/<a class="btn demo-strip__agents" href="#\/agents"><svg[^>]*>.*<\/svg>What agents see<\/a>/)
  })
})
