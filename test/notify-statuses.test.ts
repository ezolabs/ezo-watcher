import { describe, expect, it } from 'vitest'
import { outcomeWords, statusWords, subjectWords } from '../src/web/lib/receivers.ts'

describe('the words a screen uses for a result row', () => {
  it('reads a delivered send by its latency, and a plain failure as failed', () => {
    expect(outcomeWords({ ok: 1, status: '200', latency_ms: 1234 })).toBe('sent in 1.2 s')
    expect(outcomeWords({ ok: 0, status: 'timeout', latency_ms: 3000 })).toBe('failed: timeout')
    expect(outcomeWords({ ok: 0, status: 'no subscribers', latency_ms: 1 })).toBe('failed: no subscribers')
  })

  it('says what became of a send that was skipped, given up on or held back, in the words the server recorded', () => {
    expect(outcomeWords({ ok: 0, status: 'skipped: circuit open until 03:55:21 UTC', latency_ms: 0 })).toBe('skipped: circuit open until 03:55:21 UTC')
    expect(outcomeWords({ ok: 0, status: 'abandoned: max attempts', latency_ms: 0 })).toBe('abandoned: max attempts')
    expect(outcomeWords({ ok: 0, status: 'abandoned: incident resolved', latency_ms: 0 })).toBe('abandoned: incident resolved')
    expect(outcomeWords({ ok: 0, status: 'coalesced into summary:page:webhook@2026-10-20T04:00:00.000Z', latency_ms: 0 })).toBe("held back and told in the origin's summary")
    expect(statusWords('429')).toBe('429')
  })

  it('names what a row is about', () => {
    expect(subjectWords('-')).toBe('Send test')
    expect(subjectWords('digest:warning')).toBe('Quiet-hours digest')
    expect(subjectWords('summary:page:webhook@2026-10-20T04:00:00.000Z')).toBe('Held pages from webhook')
    expect(subjectWords('API router|request-spike')).toBe('API router / request-spike')
  })
})
