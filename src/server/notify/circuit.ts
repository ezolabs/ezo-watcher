// A circuit breaker per send target, so one host that refuses us is left alone instead of being asked again every few seconds.
//
// A target is a place we POST to: ntfy.sh and the self-hosted ntfy are two (the ntfy channel keeps one each), a Chat webhook, the SMS and
// mail APIs are one each (the notifier keeps those per channel). A 429 or a timeout from a target opens its circuit: for the server's
// Retry-After when it sent one, 15 minutes when it did not. A trip within an hour of the previous circuit's end doubles that circuit's
// length, up to 2 hours, so a host that keeps refusing is probed less and less often. While a circuit is open the notifier does not
// call the target (the result reads "skipped: circuit open until <time>") and a ladder moves on to its next receiver.
//
// The state lives in memory: it survives the 5 s notifier tick and is lost on a restart, which costs one probe of each target.

import type { SendResult } from './types.ts'

export const CIRCUIT_BASE_MS = 15 * 60_000
export const CIRCUIT_CAP_MS = 2 * 3600_000
/** A trip this soon after the previous circuit ended is a repeat: the new circuit is twice as long. */
export const CIRCUIT_REPEAT_WINDOW_MS = 3600_000
const CIRCUIT_FLOOR_MS = 1000

interface State {
  openUntil: number
  durationMs: number
}

/** What opens a circuit: the target said slow down (429) or did not answer (timeout). A refusal such as 400 or 401 does not: asking later would not change it. */
export function tripsCircuit(result: Pick<SendResult, 'ok' | 'status'>): boolean {
  return !result.ok && (result.status === '429' || result.status === 'timeout')
}

/** The status a skipped send is recorded with. */
export function skippedStatus(untilMs: number): string {
  return `skipped: circuit open until ${new Date(untilMs).toISOString().slice(11, 19)} UTC`
}

/** True for the result of a call that was not made because the target's circuit was open. */
export function wasSkipped(result: Pick<SendResult, 'status'>): boolean {
  return result.status.startsWith('skipped: circuit open')
}

/** The result of a call that was not made because the target's circuit is open. */
export function skippedResult(untilMs: number): SendResult {
  return { ok: false, status: skippedStatus(untilMs), latencyMs: 0, circuitUntil: untilMs }
}

export class CircuitBreaker {
  private readonly states = new Map<string, State>()

  private readonly now: () => number

  constructor(now: () => number) {
    this.now = now
  }

  /** When the target's circuit closes (epoch ms), or null while it is closed. */
  openUntil(key: string): number | null {
    const state = this.states.get(key)
    return state !== undefined && state.openUntil > this.now() ? state.openUntil : null
  }

  /**
   * Open the target's circuit and say until when. A trip while it is already open changes nothing (a burst of sends that were in flight
   * together all report the same refusal), except that a longer Retry-After than what is left lengthens it.
   */
  trip(key: string, retryAfterMs?: number): number {
    const t = this.now()
    const prev = this.states.get(key)
    const asked = retryAfterMs !== undefined && retryAfterMs >= CIRCUIT_FLOOR_MS ? retryAfterMs : undefined
    if (prev !== undefined && prev.openUntil > t) {
      if (asked !== undefined && t + Math.min(asked, CIRCUIT_CAP_MS) > prev.openUntil) {
        prev.openUntil = t + Math.min(asked, CIRCUIT_CAP_MS)
        prev.durationMs = prev.openUntil - t
      }
      return prev.openUntil
    }
    const again = prev !== undefined && t - prev.openUntil < CIRCUIT_REPEAT_WINDOW_MS ? prev : undefined
    const base = asked ?? CIRCUIT_BASE_MS
    const durationMs = Math.min(CIRCUIT_CAP_MS, again ? Math.max(base, again.durationMs * 2) : base)
    const state = { openUntil: t + durationMs, durationMs }
    this.states.set(key, state)
    return state.openUntil
  }

  /** The circuits that are open now, for the operator log. */
  open(): Array<{ key: string; openUntil: number }> {
    const t = this.now()
    return [...this.states].filter(([, s]) => s.openUntil > t).map(([key, s]) => ({ key, openUntil: s.openUntil }))
  }
}
