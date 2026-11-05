// How a comment, an agent's silence and a manual resolve read in the sheet. Written, not run, in the session that added it (checks were off).
import { describe, expect, it } from 'vitest'
import { eventLine, eventSaying, reopenedOf, silenceReasonOf } from '../src/shared/event-text.ts'
import { linkParts } from '../src/shared/link-parts.ts'
import { ackedParts, silencedLine, silencedParts, toldLine } from '../src/web/lib/ack.ts'
import type { AlertEvent } from '../src/shared/types.ts'

const ev = (kind: AlertEvent['kind'], detail: Record<string, unknown>, alertKey: string | null = null): AlertEvent => ({ id: 1, at: '2026-10-15T12:00:00.000Z', kind, alertKey, incidentKey: 'Disk|DiskFull', detail })

describe('linkParts', () => {
  it('joins back to the original, links http(s) addresses and leaves the sentence\'s own punctuation out of them', () => {
    const text = 'Fixed in https://github.com/example-org/ezo-watcher/commit/2568f73, see (https://watch.example.com/#/i/Disk). Done.'
    const parts = linkParts(text)
    expect(parts.map((p) => p.text).join('')).toBe(text)
    expect(parts.filter((p) => p.href).map((p) => p.text)).toEqual(['https://github.com/example-org/ezo-watcher/commit/2568f73', 'https://watch.example.com/#/i/Disk'])
  })
  it('never links a script or a data address, and keeps line breaks in the text', () => {
    const parts = linkParts('javascript:alert(1)\ndata:text/html,x\nplain')
    expect(parts.some((p) => p.href)).toBe(false)
    expect(parts.map((p) => p.text).join('')).toContain('\n')
  })
})

describe('what the sheet says an event did', () => {
  it('names an agent and its reason on an acknowledgement, a silence and a manual resolve', () => {
    expect(eventSaying(ev('ack', { by: 'agent: claude', note: 'on it' }))).toBe('Acknowledged by agent: claude. Note: on it')
    expect(eventSaying(ev('silence', { by: 'agent: claude', minutes: 60, reason: 'planned reboot' }))).toBe('Silenced by agent: claude for 60 min. Reason: planned reboot')
    expect(eventSaying(ev('resolved', { manual: true, by: 'agent: claude', reason: 'fixed' }))).toBe('Marked resolved by agent: claude. Reason: fixed')
    expect(eventSaying(ev('reopened', { by: 'agent: claude' }))).toBe('Reopened: source still firing after manual resolve by agent: claude')
    expect(eventSaying(ev('confirmed', { by: 'agent: claude', note: 'PR 4821' }))).toBe('Resolution confirmed by agent: claude. Note: PR 4821')
  })
  it('leaves a source\'s own resolve and a fire to the sheet\'s wording, and names nobody for the old "wall" or an event with no actor', () => {
    expect(eventSaying(ev('resolved', { origin: 'grafana' }))).toBeNull()
    expect(eventSaying(ev('fired', {}))).toBeNull()
    expect(eventLine(ev('ack', { by: 'wall' })).text).toBe('Acknowledged')
    expect(eventLine(ev('silence', { by: 'this browser', minutes: 60 })).text).toBe('Silenced for 60 min')
  })
})

describe('silencedLine', () => {
  it('says who and until when, and when the silence was set on the previous episode', () => {
    const until = '2026-10-15T15:40:00.000Z'
    expect(silencedLine('agent: claude', until, false)).toContain('Silenced by agent: claude until')
    expect(silencedLine('agent: claude', until, true)).toContain('set before this episode')
    expect(silencedLine(null, null, false)).toBe('Silenced at the source')
  })
})

describe('the acknowledged and silenced tile, told in two parts', () => {
  it('puts who on one line and when on the next, so the time is never the part that is cut', () => {
    const at = '2026-10-15T21:25:00.000Z'
    const a = ackedParts('the user', at)
    expect(a.who).toBe('Acknowledged by the user')
    expect(a.when).toMatch(/^at \d{1,2}:\d{2}/)
    expect(toldLine(a)).toBe(`${a.who} ${a.when}`)
    expect(ackedParts('the user', null)).toEqual({ who: 'Acknowledged by the user', when: '' })
    const s = silencedParts('agent: claude', at, false)
    expect(s.who).toBe('Silenced by agent: claude')
    expect(s.when).toMatch(/^until /)
    expect(silencedParts('agent: claude', at, true).when).toContain('carried over')
    expect(silencedParts('agent: claude', at, true, true).when).toContain('set before this episode')
  })
})

describe('what the sheet says about an incident that came back', () => {
  const e = (id: number, kind: AlertEvent['kind'], at: string, detail: Record<string, unknown> = {}, alertKey: string | null = null): AlertEvent => ({ id, at, kind, alertKey, incidentKey: 'Queue|High', detail })
  it('reads the reopen that started the current episode, and only that one', () => {
    const events = [e(1, 'fired', '2026-10-15T14:00:00Z'), e(2, 'resolved', '2026-10-15T14:30:00Z', { manual: true, by: 'agent: codex' }), e(3, 'fired', '2026-10-15T14:31:00Z'), e(4, 'reopened', '2026-10-15T14:31:00Z', { by: 'agent: codex' })]
    expect(reopenedOf(events)?.id).toBe(4)
    expect(reopenedOf(events.slice(0, 3))).toBeNull()
    // a later ordinary firing is not a reopen
    expect(reopenedOf([...events, e(5, 'resolved', '2026-10-15T15:00:00Z'), e(6, 'fired', '2026-10-15T16:00:00Z')])).toBeNull()
  })
  it('keeps the reason of the latest silence', () => {
    expect(silenceReasonOf([e(1, 'silence', '2026-10-15T14:00:00Z', { reason: 'first' }), e(2, 'silence', '2026-10-15T14:10:00Z', { reason: ' planned failover ' })])).toBe('planned failover')
    expect(silenceReasonOf([e(1, 'silence', '2026-10-15T14:00:00Z', {})])).toBeNull()
    expect(silenceReasonOf([])).toBeNull()
  })
})
