// The generic Stripe-Signature verifier: the HMAC scheme Stripe documents, kept as the Watcher's way to check any signed push that uses it.
import { describe, expect, it } from 'vitest'
import { signStripePayload, verifyStripeSignature } from '../src/server/stripe-signature'

const SECRET = 'whsec_test_secret'
const BODY = JSON.stringify({ id: 'evt_1', type: 'payment.succeeded' })
const NOW = 1_760_000_000

describe('verifyStripeSignature', () => {
  it('accepts a genuine signature inside the replay window', () => {
    const header = signStripePayload(BODY, SECRET, NOW)
    expect(verifyStripeSignature(BODY, header, [SECRET], NOW, 300)).toEqual({ ok: true, timestamp: NOW })
  })

  it('accepts the new secret while an old one is still valid', () => {
    const old = signStripePayload(BODY, 'whsec_old', NOW)
    expect(verifyStripeSignature(BODY, old, ['whsec_new', 'whsec_old'], NOW, 300).ok).toBe(true)
  })

  it('refuses a header signed with another secret', () => {
    expect(verifyStripeSignature(BODY, signStripePayload(BODY, 'whsec_other', NOW), [SECRET], NOW, 300)).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('refuses a body that changed after it was signed', () => {
    const header = signStripePayload(BODY, SECRET, NOW)
    expect(verifyStripeSignature(`${BODY} `, header, [SECRET], NOW, 300)).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('reads a genuine but old request as stale, not as forged', () => {
    expect(verifyStripeSignature(BODY, signStripePayload(BODY, SECRET, NOW - 301), [SECRET], NOW, 300)).toEqual({ ok: false, reason: 'stale' })
    expect(verifyStripeSignature(BODY, signStripePayload(BODY, SECRET, NOW + 301), [SECRET], NOW, 300)).toEqual({ ok: false, reason: 'stale' })
  })

  it('never lets a tolerance of 0 accept everything: it is at least one second', () => {
    expect(verifyStripeSignature(BODY, signStripePayload(BODY, SECRET, NOW), [SECRET], NOW, 0).ok).toBe(true)
    expect(verifyStripeSignature(BODY, signStripePayload(BODY, SECRET, NOW - 2), [SECRET], NOW, 0).ok).toBe(false)
  })

  it('names a missing, malformed or unsigned request', () => {
    expect(verifyStripeSignature(BODY, undefined, [SECRET], NOW, 300)).toEqual({ ok: false, reason: 'missing' })
    expect(verifyStripeSignature(BODY, '', [SECRET], NOW, 300)).toEqual({ ok: false, reason: 'missing' })
    expect(verifyStripeSignature(BODY, 'v1=abcd', [SECRET], NOW, 300)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyStripeSignature(BODY, `t=${NOW}`, [SECRET], NOW, 300)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyStripeSignature(BODY, `t=${NOW},v1=not-hex`, [SECRET], NOW, 300)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyStripeSignature(BODY, 't=abc,v1=' + 'a'.repeat(64), [SECRET], NOW, 300)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyStripeSignature(BODY, signStripePayload(BODY, SECRET, NOW), [], NOW, 300)).toEqual({ ok: false, reason: 'no secret' })
  })

  it('ignores the fake v0 scheme of test events, so a v0 alone never verifies (no downgrade)', () => {
    const real = signStripePayload(BODY, SECRET, NOW)
    const v1 = real.slice(real.indexOf('v1=') + 3)
    expect(verifyStripeSignature(BODY, `t=${NOW},v0=${v1}`, [SECRET], NOW, 300).ok).toBe(false)
    expect(verifyStripeSignature(BODY, `t=${NOW},v0=${v1},v1=${v1}`, [SECRET], NOW, 300).ok).toBe(true)
  })

  it('is constant-time in shape: every candidate signature is compared, and a duplicate v1 does not help a forgery', () => {
    const forged = 'f'.repeat(64)
    const real = signStripePayload(BODY, SECRET, NOW)
    expect(verifyStripeSignature(BODY, `${real},v1=${forged}`, [SECRET], NOW, 300).ok).toBe(true)
    expect(verifyStripeSignature(BODY, `t=${NOW},v1=${forged},v1=${forged}`, [SECRET], NOW, 300).ok).toBe(false)
  })
})

describe('signStripePayload', () => {
  it('writes the header Stripe writes: t and a hex v1', () => {
    const header = signStripePayload('x', 'k', 42)
    expect(header).toMatch(/^t=42,v1=[0-9a-f]{64}$/)
  })
})
