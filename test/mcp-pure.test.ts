// The pure parts of the MCP server: the bearer check, who an agent is, the limits on what it may write, and the shapes the read tools answer.
// Written, not run, in the session that added it (checks were off); the same assertions were proven with node --experimental-strip-types.
import { describe, expect, it } from 'vitest'
import { COMMENT_MAX, REASON_MAX, SILENCE_MAX_MINUTES, agentName, checkOptionalText, checkSilenceMinutes, checkText, isAgentName, noteLine } from '../src/shared/agent.ts'
import { MIN_TOKEN_CHARS, bearerOf, mcpAuthorized } from '../src/server/mcp/auth.ts'
import { HISTORY_MAX_HOURS, historyRange, incidentUrl } from '../src/server/mcp/shape.ts'

const TOKEN = 'a'.repeat(64)

describe('mcpAuthorized', () => {
  it('accepts only the configured token, as a Bearer header, in any case of the scheme', () => {
    expect(mcpAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(mcpAuthorized(`bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(mcpAuthorized(`Bearer ${TOKEN}x`, TOKEN)).toBe(false)
    expect(mcpAuthorized(TOKEN, TOKEN)).toBe(false)
    expect(mcpAuthorized(`Basic ${TOKEN}`, TOKEN)).toBe(false)
    expect(mcpAuthorized(null, TOKEN)).toBe(false)
    expect(mcpAuthorized(undefined, TOKEN)).toBe(false)
  })
  it('refuses everything when no token, or a short one, is configured', () => {
    expect(mcpAuthorized('Bearer ', undefined)).toBe(false)
    expect(mcpAuthorized('Bearer abc', 'abc')).toBe(false)
    expect(mcpAuthorized(`Bearer ${'b'.repeat(MIN_TOKEN_CHARS - 1)}`, 'b'.repeat(MIN_TOKEN_CHARS - 1))).toBe(false)
    expect(mcpAuthorized(`Bearer ${'b'.repeat(MIN_TOKEN_CHARS)}`, 'b'.repeat(MIN_TOKEN_CHARS))).toBe(true)
  })
  it('reads the token of a header', () => {
    expect(bearerOf('Bearer abc')).toBe('abc')
    expect(bearerOf('Bearer  abc  ')).toBe('abc')
    expect(bearerOf('Bearer a b')).toBeNull()
  })
})

describe('agentName', () => {
  it('prefixes "agent: " once, whatever the caller wrote, and refuses nobody', () => {
    expect(agentName('claude')).toBe('agent: claude')
    expect(agentName('agent: claude')).toBe('agent: claude')
    expect(agentName('Agent:claude')).toBe('agent: claude')
    expect(agentName('agent:   claude  in repo')).toBe('agent: claude in repo')
    expect(agentName('')).toBeNull()
    expect(agentName('   ')).toBeNull()
    expect(agentName('agent:')).toBeNull()
    expect(agentName(undefined)).toBeNull()
    expect(agentName(42)).toBeNull()
  })
  it('is at most 64 characters and strips control characters', () => {
    expect([...(agentName('x'.repeat(200)) ?? '')]).toHaveLength(64)
    expect(agentName('cla\u0007ude\nsecond')).toBe('agent: cla ude second')
    expect(isAgentName('agent: claude')).toBe(true)
    expect(isAgentName('Dana')).toBe(false)
    expect(isAgentName(null)).toBe(false)
  })
})

describe('what an agent may write', () => {
  it('a comment is 1 to 4000 characters, counted by character, never cut', () => {
    expect(checkText('x'.repeat(COMMENT_MAX), 'text', COMMENT_MAX).ok).toBe(true)
    expect(checkText('x'.repeat(COMMENT_MAX + 1), 'text', COMMENT_MAX)).toEqual({ ok: false, error: 'text is 4001 characters; the most is 4000' })
    expect(checkText('\u{1F4A5}'.repeat(COMMENT_MAX), 'text', COMMENT_MAX).ok).toBe(true)
    expect(checkText('   ', 'text', COMMENT_MAX).ok).toBe(false)
    expect(checkText(undefined, 'text', COMMENT_MAX).ok).toBe(false)
  })
  it('an optional note may be absent or blank, and is capped like a reason', () => {
    expect(checkOptionalText(undefined, 'note', REASON_MAX)).toEqual({ ok: true, text: '' })
    expect(checkOptionalText('  ', 'note', REASON_MAX)).toEqual({ ok: true, text: '' })
    expect(checkOptionalText('x'.repeat(REASON_MAX + 1), 'note', REASON_MAX).ok).toBe(false)
  })
  it('a silence is 1 to 240 whole minutes; more is refused and says why', () => {
    expect(SILENCE_MAX_MINUTES).toBe(240)
    expect(checkSilenceMinutes(1)).toEqual({ ok: true, minutes: 1 })
    expect(checkSilenceMinutes(240)).toEqual({ ok: true, minutes: 240 })
    const over = checkSilenceMinutes(241)
    expect(over.ok).toBe(false)
    expect(over.ok === false && over.error).toContain('4 hours')
    expect(checkSilenceMinutes(0).ok).toBe(false)
    expect(checkSilenceMinutes(1.5).ok).toBe(false)
    expect(checkSilenceMinutes('60').ok).toBe(false)
  })
})

describe('noteLine', () => {
  it('quotes an agent\'s text so it cannot open a heading or a list, names the author, and stays under Chat\'s limit', () => {
    const line = noteLine('comment', 'agent: claude', '# big\n- item\nfix in 1a2b3c4')
    expect(line).toContain('agent: claude')
    expect(line.split('\n').slice(1).every((l) => l.startsWith('> '))).toBe(true)
    expect([...noteLine('comment', 'agent: claude', 'y'.repeat(COMMENT_MAX))].length).toBeLessThanOrEqual(3900)
  })
  it('words a manual resolve as not yet the source\'s word, and a reopen as the source still firing', () => {
    expect(noteLine('resolved', 'agent: claude', 'fixed')).toContain('Watch reopens it')
    expect(noteLine('reopened', 'agent: claude', 'fixed')).toContain('still reports it firing')
    expect(noteLine('confirmed', 'agent: claude', '')).not.toContain('\n')
  })
})

describe('historyRange', () => {
  const now = Date.parse('2026-10-15T12:00:00Z')
  it('defaults to the last 24 hours and reaches back at most 30 days', () => {
    expect(historyRange({}, now)).toMatchObject({ ok: true, hours: 24, toMs: now })
    expect(historyRange({ hours: 720 }, now)).toMatchObject({ ok: true, hours: HISTORY_MAX_HOURS })
    expect(historyRange({ from: '2020-01-01T00:00:00Z' }, now)).toMatchObject({ ok: true, hours: HISTORY_MAX_HOURS })
  })
  it('takes ISO from and to, and refuses an empty, a malformed and an expired range', () => {
    expect(historyRange({ from: '2026-10-14T00:00:00Z', to: '2026-10-14T12:00:00Z' }, now)).toMatchObject({ ok: true, hours: 36 })
    expect(historyRange({ from: '2026-10-14T12:00:00Z', to: '2026-10-14T00:00:00Z' }, now).ok).toBe(false)
    expect(historyRange({ from: 'yesterday' }, now).ok).toBe(false)
    expect(historyRange({ from: '2020-01-01T00:00:00Z', to: '2020-02-01T00:00:00Z' }, now).ok).toBe(false)
  })
})

describe('incidentUrl', () => {
  it('opens the incident on the wall', () => {
    expect(incidentUrl('https://watch.example.com/', 'Disk|DiskFull')).toBe('https://watch.example.com/#/i/Disk%7CDiskFull')
  })
})
