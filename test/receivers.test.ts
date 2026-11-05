import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RECEIVER_WORDS, receiverWords } from '../src/web/lib/receivers.ts'

type Route = { id: string; receivers?: string[]; record?: string[]; escalate?: Array<{ receivers: string[] }> }
const cfg = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/watch.config.json', import.meta.url)), 'utf8')) as { channels: Array<{ id: string }>; routes: Route[] }

// every receiver a notice can be sent through: the configured channels and every id a route (or an escalation step) names
const configured = [...new Set([...cfg.channels.map((c) => c.id), ...cfg.routes.flatMap((r) => [...(r.receivers ?? []), ...(r.record ?? []), ...(r.escalate ?? []).flatMap((e) => e.receivers)])])]

describe('receiver words', () => {
  it('reads the configured receivers', () => {
    expect(configured.length).toBeGreaterThanOrEqual(5)
  })

  // a receiver whose words are its own id ("email") still has an entry: the guard is the entry, not a changed string
  it.each(configured)('%s has words, so no screen shows an unnamed id', (id) => {
    expect(Object.hasOwn(RECEIVER_WORDS, id), `the config names the receiver "${id}" but src/web/lib/receivers.ts has no words for it`).toBe(true)
    expect(receiverWords(id).trim()).not.toBe('')
  })

  it.each([
    ['ntfy', 'phone'],
    ['webpush', 'browser'],
    ['sms-telnyx', 'SMS'],
    ['email', 'email'],
    ['hook', 'webhook']
  ])('%s reads as %s', (id, words) => {
    expect(receiverWords(id)).toBe(words)
  })

  it('falls back to the id for a receiver with no words, and never to an object property', () => {
    expect(receiverWords('carrier-pigeon')).toBe('carrier-pigeon')
    expect(receiverWords('constructor')).toBe('constructor')
    expect(receiverWords('toString')).toBe('toString')
  })
})
