// The telemetry collector behind https://telemetry.ezolabs.io (docs/telemetry.md).
//
// POST /v1/events takes one batch from the ezo-watcher CLI or server, checks it with the same `parseBatch` the client's
// schema module exports (src/shared/telemetry-schema.ts), and writes one D1 row per event (schema.sql). It stores the
// validated fields and Cloudflare's two-letter `cf.country`, and nothing else from the request: no IP address, no header,
// no user agent. Workers Logs are off in wrangler.jsonc for the same reason. GET / says what this is and where its source is.

import { TELEMETRY_MAX_BYTES, TELEMETRY_SCHEMA, parseBatch } from '../../../src/shared/telemetry-schema.ts'
import type { TelemetryEvent } from '../../../src/shared/telemetry-schema.ts'

/** The slice of D1 this Worker uses (the full type is @cloudflare/workers-types' D1Database). */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement
  run(): Promise<unknown>
}

export interface D1 {
  prepare(sql: string): D1Statement
  batch(statements: D1Statement[]): Promise<unknown>
}

export interface Env {
  DB: D1
}

const DOCS = 'https://github.com/ezolabs/ezo-watcher/blob/main/docs/telemetry.md'
const SOURCE = 'https://github.com/ezolabs/ezo-watcher/tree/main/deploy/telemetry'
/** Rows older than this are deleted by the daily cron. docs/telemetry.md states the same number. */
export const RETENTION_DAYS = 400

const POINTER = [
  'EZO Watcher telemetry collector',
  '',
  'POST /v1/events receives anonymous usage events from the ezo-watcher CLI and server.',
  `What is sent, what never is, and how to turn it off: ${DOCS}`,
  `This Worker's source: ${SOURCE}`,
  'Opt out: `watcher telemetry disable`, or set DO_NOT_TRACK=1.',
  ''
].join('\n')

const INSERT =
  'INSERT INTO events (received_at, sent_at, schema, name, install_id, version, node, os, arch, ci, install, country, props) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'

function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers } })
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

/** The body as text, or null once it passes `max` bytes: a body is never read further than the limit. */
async function readCapped(request: Request, max: number): Promise<string | null> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    all.set(c, offset)
    offset += c.byteLength
  }
  return new TextDecoder().decode(all)
}

/** Cloudflare's country code for the connection, kept only when it is two letters (XX and T1 included, as Cloudflare names them). */
function countryOf(request: Request): string | null {
  const cf = (request as Request & { cf?: { country?: unknown } }).cf
  const country = cf?.country
  return typeof country === 'string' && /^[A-Z][A-Z0-9]$/.test(country) ? country : null
}

/** An event's own fields, without the two the row already has columns for. */
function propsOf(event: TelemetryEvent): string {
  const { name: _name, at: _at, ...props } = event
  return JSON.stringify(props)
}

export async function handleRequest(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === '/') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return text('GET only\n', 405, { allow: 'GET, HEAD' })
    return text(POINTER)
  }
  if (url.pathname !== '/v1/events') return text('not found\n', 404)
  if (request.method !== 'POST') return text('POST only\n', 405, { allow: 'POST' })

  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > TELEMETRY_MAX_BYTES) return json({ ok: false, error: `body over ${TELEMETRY_MAX_BYTES} bytes` }, 413)
  const raw = await readCapped(request, TELEMETRY_MAX_BYTES)
  if (raw === null) return json({ ok: false, error: `body over ${TELEMETRY_MAX_BYTES} bytes` }, 413)
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return json({ ok: false, error: 'body is not JSON' }, 400)
  }
  const parsed = parseBatch(body)
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400)

  const { context, events } = parsed.batch
  const receivedAt = now.toISOString()
  const country = countryOf(request)
  const insert = env.DB.prepare(INSERT)
  await env.DB.batch(
    events.map((e) =>
      insert.bind(receivedAt, e.at, TELEMETRY_SCHEMA, e.name, context.id, context.version, context.node, context.os, context.arch, context.ci ? 1 : 0, context.install, country, propsOf(e))
    )
  )
  return json({ ok: true, stored: events.length, dropped: parsed.dropped }, 202)
}

/** The daily cron: delete what is past the retention window. */
export async function prune(env: Env, now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString()
  await env.DB.prepare('DELETE FROM events WHERE received_at < ?').bind(cutoff).run()
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handleRequest(request, env),
  scheduled: async (_controller: unknown, env: Env): Promise<void> => prune(env)
}
