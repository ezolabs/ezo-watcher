// Where a notice went, in words people know. A receipt, a notification log row and the next escalation step all name a receiver by its
// config id (`channels[].id`); every surface says it through `receiverWords` so no screen shows a raw id.
// test/receivers.test.ts fails on a configured receiver that has no words here.
export const RECEIVER_WORDS: Record<string, string> = {
  ntfy: 'phone',
  webpush: 'browser',
  'sms-telnyx': 'SMS',
  email: 'email',
  hook: 'webhook'
}

/** The words for a receiver id; an id with no words reads as itself. */
export function receiverWords(id: string): string {
  return Object.hasOwn(RECEIVER_WORDS, id) ? RECEIVER_WORDS[id] : id
}

/**
 * What a result row's status says, for a screen. A send the notifier skipped (a target's circuit was open), gave up on, or held back into a summary
 * is not a failed send: each says so, in the words the server wrote ("skipped: circuit open until 03:55:21 UTC", "abandoned: max attempts").
 */
export function statusWords(status: string): string {
  if (status.startsWith('coalesced into ')) return "held back and told in the origin's summary"
  return status
}

/** The right-hand line of a result row: how long a delivery took, or what became of the send. */
export function outcomeWords(r: { ok: boolean | number; status: string; latency_ms: number }): string {
  if (r.ok) return `sent in ${(r.latency_ms / 1000).toFixed(1)} s`
  if (r.status.startsWith('coalesced into ') || r.status.startsWith('skipped:') || r.status.startsWith('abandoned:')) return statusWords(r.status)
  return `failed: ${r.status}`
}

/** What a result row is about: the incident, or the held-pages summary, the digest, the test. */
export function subjectWords(incidentKey: string): string {
  if (incidentKey === '-') return 'Send test'
  if (incidentKey.startsWith('summary:')) return `Held pages from ${incidentKey.slice(incidentKey.indexOf(':', 'summary:'.length) + 1, incidentKey.lastIndexOf('@'))}`
  if (incidentKey.startsWith('digest:')) return 'Quiet-hours digest'
  return incidentKey.replace('|', ' / ')
}
