// The Stripe-Signature header, checked by hand. https://docs.stripe.com/webhooks (Verify webhook signatures manually, read 2026-10-16):
//
//   Stripe-Signature: t=1492774577,v1=5257a869...,v0=6ffbb59b...
//
// - split the header on `,` and each element on its first `=`; `t` is the timestamp, every `v1` is a signature (more than one while an endpoint secret is
//   rolled and the old one is still valid), every other scheme (the fake `v0` of test events) is ignored, which is what stops a downgrade;
// - signed_payload = `<t>.<raw request body>`; expected = HMAC-SHA256(endpoint secret as the key, signed_payload), hex;
// - compare each v1 to the expected value in constant time; then the timestamp must be within the tolerance (five minutes by default) of now, on both sides.
//
// The secret is the whole `whsec_...` string used as the key, as Stripe's libraries do. The raw body must be the exact bytes Stripe sent.

import { createHmac, timingSafeEqual } from 'node:crypto'

export type SignatureVerdict = { ok: true; timestamp: number } | { ok: false; reason: 'missing' | 'malformed' | 'mismatch' | 'stale' | 'no secret' }

interface Parsed {
  timestamp: number
  signatures: Buffer[]
}

/** The timestamp and the v1 signatures of a header, or null when it has no integer `t` or no well-formed `v1`. */
function parseHeader(header: string): Parsed | null {
  let timestamp: number | null = null
  const signatures: Buffer[] = []
  for (const part of header.split(',')) {
    const eq = part.indexOf('=')
    if (eq < 1) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === 't' && timestamp === null && /^\d{1,12}$/.test(value)) timestamp = Number(value)
    else if (key === 'v1' && /^[0-9a-fA-F]{64}$/.test(value)) signatures.push(Buffer.from(value, 'hex'))
  }
  return timestamp === null || signatures.length === 0 ? null : { timestamp, signatures }
}

/**
 * Verify `rawBody` against `header` with any of `secrets`. `nowSec` is the clock in epoch seconds, `toleranceSec` the replay window. The signature is
 * checked before the timestamp, as Stripe's libraries do, so a stale but genuine request reads `stale` and a forged one `mismatch`. Never throws.
 */
export function verifyStripeSignature(rawBody: string, header: string | undefined | null, secrets: readonly string[], nowSec: number, toleranceSec: number): SignatureVerdict {
  const keys = secrets.filter((s) => s !== '')
  if (keys.length === 0) return { ok: false, reason: 'no secret' }
  if (!header) return { ok: false, reason: 'missing' }
  const parsed = parseHeader(header)
  if (!parsed) return { ok: false, reason: 'malformed' }
  let matched = false
  for (const key of keys) {
    const expected = createHmac('sha256', key).update(`${parsed.timestamp}.${rawBody}`).digest()
    // every candidate is compared, none short-circuits on the first byte that differs
    for (const got of parsed.signatures) if (got.length === expected.length && timingSafeEqual(got, expected)) matched = true
  }
  if (!matched) return { ok: false, reason: 'mismatch' }
  // a tolerance of 0 would switch the recency check off in Stripe's libraries; here it would refuse everything, so it is never below one second
  if (Math.abs(nowSec - parsed.timestamp) > Math.max(1, toleranceSec)) return { ok: false, reason: 'stale' }
  return { ok: true, timestamp: parsed.timestamp }
}

/** The signature header a sender would send for `rawBody` (tests and local proofs): `t=<sec>,v1=<hex>`. */
export function signStripePayload(rawBody: string, secret: string, timestampSec: number): string {
  return `t=${timestampSec},v1=${createHmac('sha256', secret).update(`${timestampSec}.${rawBody}`).digest('hex')}`
}
