// An acknowledgement or silence whose stored actor names nobody never reads "this browser" to anyone else: no tile, sheet, History row or chat
// message says an actor for it. A real name and an agent's "agent: <who>" read as stored. The rule holds for the person who skipped the
// name prompt too (their own fresh acknowledgement reads without a name), because "this browser" means nothing to the next reader.

import { describe, expect, it } from 'vitest'
import { resolutionText } from '../src/shared/agent.ts'
import { eventLine } from '../src/shared/event-text.ts'
import { FALLBACK_NAME, byPhrase, shownName } from '../src/shared/who.ts'
import { buildMessage } from '../src/server/notify/message.ts'
import { ackedLine, ackedParts, silencedLine, silencedParts } from '../src/web/lib/ack.ts'
import type { AlertEvent } from '../src/shared/types.ts'

/** Stored actors that name nobody: what a skipped prompt stores, the old default, the engine's stand-in, an empty or missing name. */
const NOBODY = [FALLBACK_NAME, 'This Browser', 'wall', 'Wall', 'someone', '', '   ', null, undefined]

const ev = (kind: string, detail: Record<string, unknown>): AlertEvent => ({ id: 1, at: '2026-10-15T15:25:00.000Z', incidentKey: 'k', alertKey: null, kind, detail }) as unknown as AlertEvent
const AT = '2026-10-15T19:56:00.000Z'

describe('a stored actor that names nobody', () => {
  it('has no name and no phrase, whatever its spelling', () => {
    for (const by of NOBODY) {
      expect(shownName(by)).toBeNull()
      expect(byPhrase(by)).toBe('')
    }
  })

  it('leaves a real name and an agent as they are', () => {
    expect(shownName('the user')).toBe('the user')
    expect(byPhrase('the user')).toBe(' by the user')
    expect(shownName('agent: claude, acme-desktop')).toBe('agent: claude, acme-desktop')
    expect(byPhrase('agent: claude')).toBe(' by agent: claude')
    expect(shownName('Zoë Park')).toBe('Zoë Park')
  })
})

describe('the tile and the sheet', () => {
  it('say the acknowledgement and the silence with no actor', () => {
    for (const by of NOBODY) {
      expect(ackedLine(by, AT)).toMatch(/^Acknowledged at \d\d:\d\d$/)
      expect(ackedParts(by, AT).who).toBe('Acknowledged')
      expect(silencedLine(by, AT, false)).toMatch(/^Silenced until \d\d:\d\d$/)
      expect(silencedParts(by, AT, false).who).toBe('Silenced')
      expect(silencedParts(by, AT, true, true).when).toMatch(/^until \d\d:\d\d, set before this episode$/)
    }
  })

  it('still say a name and an agent', () => {
    expect(ackedLine('the user', AT)).toMatch(/^Acknowledged by the user at \d\d:\d\d$/)
    expect(silencedLine('agent: claude', AT, false)).toMatch(/^Silenced by agent: claude until \d\d:\d\d$/)
  })

  it('keep a silence only the source holds as it was', () => {
    expect(silencedLine(null, null, false)).toBe('Silenced at the source')
  })
})

describe('History and the sheet\'s timeline', () => {
  it('read an event with no actor without one', () => {
    for (const by of ['this browser', 'wall', 'someone', '']) {
      expect(eventLine(ev('ack', { by })).text).toBe('Acknowledged')
      expect(eventLine(ev('unack', { by })).text).toBe('Acknowledgement removed')
      expect(eventLine(ev('silence', { by, minutes: 60 })).text).toBe('Silenced for 60 min')
      expect(eventLine(ev('resolved', { manual: true, by, reason: 'fixed' })).text).toBe('Marked resolved. Reason: fixed')
    }
    expect(eventLine(ev('ack', {})).text).toBe('Acknowledged')
  })

  it('keep a name and an agent', () => {
    expect(eventLine(ev('ack', { by: 'the user', note: 'on it' })).text).toBe('Acknowledged by the user. Note: on it')
    expect(eventLine(ev('silence', { by: 'agent: claude', minutes: 30 })).text).toBe('Silenced by agent: claude for 30 min')
  })

  it('word a resolve, a reopen and a confirmation without an actor when none is shown', () => {
    expect(resolutionText('resolved-manual', null, 'fixed')).toBe('Marked resolved. Reason: fixed')
    expect(resolutionText('reopened', null, undefined)).toBe('Reopened: source still firing after manual resolve')
    expect(resolutionText('confirmed', null, 'PR 4821')).toBe('Resolution confirmed. Note: PR 4821')
    expect(resolutionText('confirmed', 'agent: claude', undefined)).toBe('Resolution confirmed by agent: claude')
  })
})

describe('the notify text', () => {
  const view = (over: Record<string, unknown>) => ({
    key: 'k|DiskFull',
    service: 'Host disks',
    rule: 'DiskFull',
    summary: 'DiskFull on node-4',
    severity: 'warning' as const,
    origin: 'grafana',
    labels: {},
    startsAt: '2026-10-15T12:00:00.000Z',
    resolvedAt: '2026-10-15T20:00:00.000Z',
    durationSec: 8 * 3600,
    stableForSec: 600,
    wasNotified: true,
    ...over
  })
  const ctx = { baseUrl: 'https://watch.test', ackSecret: 'k'.repeat(32), nowMs: Date.parse('2026-10-15T20:00:00.000Z') }
  const resolved = (over: Record<string, unknown>) => buildMessage({ type: 'resolved', view: view(over) } as Parameters<typeof buildMessage>[0], ctx)

  it('says "Acknowledged at 19:56 UTC" when the stored name names nobody, never "by this browser"', () => {
    for (const ackedBy of [FALLBACK_NAME, 'wall', 'someone', '']) {
      const msg = resolved({ ackedBy, ackedAt: AT })
      expect(msg.body).toContain('Acknowledged at 19:56 UTC.')
      expect(msg.body).not.toMatch(/by (this browser|wall|someone)/i)
      expect(msg.ackedBy).toBeUndefined()
      expect(msg.ackedAt).toBe(AT)
    }
  })

  it('keeps a real name on the line, and says nothing of an acknowledgement that never happened', () => {
    const named = resolved({ ackedBy: 'the user', ackedAt: AT })
    expect(named.body).toContain('Acknowledged by the user at 19:56 UTC.')
    expect(named.ackedBy).toBe('the user')
    const none = resolved({})
    expect(none.body).not.toContain('Acknowledged')
    expect(none.ackedBy).toBeUndefined()
  })
})
