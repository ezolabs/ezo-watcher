// Helpers the three adapters share: narrowing untrusted JSON, links that are safe to render, the bounded
// HTTP GET, and the rule-name rule for Grafana's NoData and Error pseudo-alerts.

import type { Alert } from '../../shared/types.ts'

export const REQUEST_TIMEOUT_MS = 8000

/** A body that is not a payload this source accepts. The message is safe to send back to the caller. */
export class BadPayload extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadPayload'
  }
}

/** Grafana raises these two alertnames when a rule has no data or fails; the real rule is in `rulename`. */
const PSEUDO_ALERTS = new Set(['DatasourceNoData', 'DatasourceError'])
/** The dead-man's pings. The alert bridge drops them, so Watch must too. */
const DEAD_MANS_PINGS = new Set(['Watchdog', 'ApiWatchdog'])

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Label and annotation maps: strings kept, numbers and booleans stringified, anything else dropped. */
export function stringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isRecord(v)) return out
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === 'string') out[k] = x
    else if (typeof x === 'number' || typeof x === 'boolean') out[k] = String(x)
  }
  return out
}

/** The string itself when it is a real time. Go's zero time (year 1) and junk give null. */
export function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) && ms > 0 ? v : null
}

export function epochIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString()
}

/** http(s) only. Link text comes from alert content, so a javascript: or data: URL must never reach a href. */
export function safeUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  try {
    const { protocol } = new URL(s)
    return protocol === 'http:' || protocol === 'https:' ? s : undefined
  } catch {
    return undefined
  }
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

/** alertname, or the real rule name for Grafana's pseudo-alerts (docs: nodata-and-error-states). */
export function ruleNameOf(labels: Record<string, string>): string {
  const name = labels.alertname ?? ''
  if (PSEUDO_ALERTS.has(name) && labels.rulename) return labels.rulename
  return name || labels.rulename || 'unnamed alert'
}

/**
 * A dead-man's switch fires on purpose, so it is proof the pipeline is alive, never a problem. The alert bridge
 * drops `Watchdog` and `ApiWatchdog`; Grafana's own heartbeat rule is the severity label `heartbeat`.
 */
export function isDeadMansPing(labels: Record<string, string>): boolean {
  return (
    DEAD_MANS_PINGS.has(labels.alertname ?? '') ||
    DEAD_MANS_PINGS.has(ruleNameOf(labels)) ||
    (labels.severity ?? '').toLowerCase() === 'heartbeat'
  )
}

/** One short value string from Grafana's numeric `values` map, else its `valueString`. */
export function valueText(values: unknown, valueString: unknown): string | undefined {
  if (isRecord(values)) {
    const parts = Object.entries(values)
      .filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]))
      .map(([k, n]) => `${k}=${Number(n.toPrecision(6))}`)
    if (parts.length > 0) return clip(parts.join(', '), 200)
  }
  if (typeof valueString === 'string' && valueString.trim() !== '') return clip(valueString.trim(), 200)
  return undefined
}

export function parseJsonRecord(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined
  try {
    const v: unknown = JSON.parse(text)
    return isRecord(v) ? v : undefined
  } catch {
    return undefined
  }
}

/** makeAlert drops a future endsAt; a resolved alert must always carry its resolution time. */
export function markResolved(alert: Alert, iso: string): Alert {
  return { ...alert, endsAt: iso, resolvedAt: iso }
}

export function describeFailure(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return `timed out after ${REQUEST_TIMEOUT_MS / 1000} s`
    const code = (err.cause as { code?: unknown } | undefined)?.code
    if (typeof code === 'string') return code
  }
  return 'network error'
}

/**
 * GET a JSON document with the shared timeout. Every error names the request and the HTTP status only: the
 * URL (its query, its host) and the headers (the token) never reach a message the poller records.
 */
export async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  label: string
): Promise<unknown> {
  let res: Response
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (err) {
    throw new Error(`${label} request failed: ${describeFailure(err)}`)
  }
  if (!res.ok) throw new Error(`${label} returned HTTP ${res.status}`)
  try {
    return await res.json()
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError'
    throw new Error(timedOut ? `${label} request failed: ${describeFailure(err)}` : `${label} returned a body that is not JSON`)
  }
}

/**
 * Why a request with its own deadline failed, in words safe to show: the deadline, or the socket's error code (ECONNREFUSED, CERT_HAS_EXPIRED),
 * never the error's message, which can name the URL.
 */
export function requestFailure(err: unknown, timeoutMs: number): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return `timed out after ${Number((timeoutMs / 1000).toFixed(1))} s`
    const code = (err.cause as { code?: unknown } | undefined)?.code ?? (err as { code?: unknown }).code
    if (typeof code === 'string' && /^[A-Z0-9_]{2,64}$/.test(code)) return code
  }
  return 'network error'
}

/** A response body as text, read until `limit` bytes; null when it is longer (the rest is never read). A body read that fails throws. */
export async function readBodyCapped(res: Response, limit: number): Promise<string | null> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Run `fn` over `items` with at most `limit` in flight, results in order. The first failure stops new work. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  let failed = false
  async function worker(): Promise<void> {
    while (!failed && next < items.length) {
      const i = next++
      try {
        out[i] = await fn(items[i])
      } catch (err) {
        failed = true
        throw err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
