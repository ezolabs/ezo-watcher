// Shared plumbing for the channels: one guarded call enforces the timeout, measures latency and turns every
// failure into a SendResult that cannot carry a URL, token, topic, phone number or address.

import { DEFAULT_BRAND } from '../../../shared/instance.ts'
import type { CircuitBreaker } from '../circuit.ts'
import type { SendResult } from '../types.ts'
import type { PushSubscriptionStore } from './webpush.ts'

export const CHANNEL_TIMEOUT_MS = 3000

export interface ChannelDeps {
  fetch: typeof fetch
  env: NodeJS.ProcessEnv
  now: () => number
  /** The project directory a relative channel path resolves against (the `file` channel). Absent: process.cwd(). */
  cwd?: string
  subscriptions?: PushSubscriptionStore
  /** Where the Chat channel keeps the message id of each incident's page. Absent: in memory, lost on a restart. */
  /** Per-call timeout; 3000 ms unless a test shortens it. */
  timeoutMs?: number
  /** One line to the operator log. Never a URL, topic or token: channels pass status words only. */
  log?: (line: string) => void
  /** The circuits of the targets a channel posts to itself (the ntfy channel keeps one per server). Absent: no circuit, every call goes out. */
  circuits?: CircuitBreaker
  /** The name this Watch goes by (config `brand.name`), in the titles and headers a channel writes itself. Absent: EZO Watcher. */
  brand?: string
}

/** The brand a channel writes: the deps' own, else EZO Watcher. */
export const brandName = (deps: Pick<ChannelDeps, 'brand'>): string => deps.brand ?? DEFAULT_BRAND.name

export interface Outcome {
  ok: boolean
  status: string
  detail?: string
  retryAfterMs?: number
}

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,39}$/

/** An error's class name, or "Error" when it is missing or odd. Never the message: messages carry URLs. */
export function errorName(err: unknown): string {
  const name = err instanceof Error ? err.name : (err as { name?: unknown } | null)?.name
  return typeof name === 'string' && SAFE_NAME.test(name) ? name : 'Error'
}

function failure(err: unknown): Outcome {
  const name = errorName(err)
  if (name === 'TimeoutError') return { ok: false, status: 'timeout', detail: name }
  // config.ts secret() throws this; its message names an env var, which is not shown, only the fact.
  if (err instanceof Error && err.message.startsWith('missing environment variable')) {
    return { ok: false, status: 'error', detail: 'missing credential' }
  }
  return { ok: false, status: 'error', detail: name }
}

/** Settle when the call settles, or reject with the signal's reason once it aborts, even if the call ignores it. */
function raceAbort<T>(signal: AbortSignal, call: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  return Promise.race([call, aborted])
}

export async function guarded(
  deps: ChannelDeps,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<Outcome>
): Promise<SendResult> {
  const started = deps.now()
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? CHANNEL_TIMEOUT_MS)
  const merged = signal ? AbortSignal.any([timeout, signal]) : timeout
  let out: Outcome
  try {
    out = await raceAbort(merged, run(merged))
  } catch (err) {
    out = failure(err)
  }
  return { ...out, latencyMs: deps.now() - started }
}

/** Read and drop a response body so the connection is released; the status already decided the outcome. */
export async function drain(res: Response): Promise<void> {
  try {
    await res.arrayBuffer()
  } catch {
    // ignored on purpose
  }
}

export function httpOutcome(res: Response): Outcome {
  return { ok: res.ok, status: String(res.status) }
}

/** The longest Retry-After a channel passes on: a server asking for more is asking for a day, and the circuit caps it anyway. */
export const MAX_RETRY_AFTER_MS = 24 * 3600_000

/** Seconds from Retry-After (or the draft RateLimit-Reset), as milliseconds, capped; undefined when the server said nothing usable. */
export function retryAfter(res: Response, nowMs: number = Date.now()): number | undefined {
  for (const name of ['retry-after', 'ratelimit-reset']) {
    const raw = res.headers.get(name)
    if (raw === null) continue
    const sec = Number(raw)
    if (raw.trim() !== '' && Number.isFinite(sec) && sec >= 0) return Math.min(sec * 1000, MAX_RETRY_AFTER_MS)
    const at = Date.parse(raw)
    if (!Number.isNaN(at)) return Math.min(Math.max(0, at - nowMs), MAX_RETRY_AFTER_MS)
  }
  return undefined
}

/** One short line of printable ASCII: accents folded, quotes and dashes flattened, the rest dropped. */
export function asciiLine(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Cut to at most `max` characters, with "..." when something was cut. */
export function cut(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 3).join('')}...`
}

/** Cut to at most `max` UTF-8 bytes on a character boundary. */
export function truncateBytes(text: string, max: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= max) return text
  let end = max - 3
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return `${bytes.subarray(0, end).toString('utf8')}...`
}

/** Drop control characters, keeping newline and tab. */
export function stripControl(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

export function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}
