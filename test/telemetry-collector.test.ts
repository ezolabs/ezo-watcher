// The collector Worker (deploy/telemetry/src/index.ts) against a fake D1: it stores the validated event fields and the
// two-letter country, never the client's IP, headers or user agent; it refuses what the schema refuses and anything over the
// size limit; GET / points at the docs; the daily cron deletes past the retention window.
import { describe, expect, it } from 'vitest'
import { RETENTION_DAYS, handleRequest, prune } from '../deploy/telemetry/src/index.ts'
import type { D1, D1Statement, Env } from '../deploy/telemetry/src/index.ts'
import { TELEMETRY_MAX_BYTES } from '../src/shared/telemetry-schema.ts'

interface Ran {
  sql: string
  values: unknown[]
}

function fakeDb(): { env: Env; ran: Ran[] } {
  const ran: Ran[] = []
  const statement = (sql: string, values: unknown[] = []): D1Statement => ({
    bind: (...v: unknown[]) => statement(sql, v),
    run: async () => {
      ran.push({ sql, values })
      return {}
    }
  })
  const db: D1 = {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      for (const s of statements) await s.run()
      return []
    }
  }
  return { env: { DB: db }, ran }
}

const ID = '00000000-0000-4000-8000-0000000000aa'
const NOW = new Date('2026-11-05T12:00:00.000Z')
const batch = {
  schema: 1,
  context: { id: ID, version: '0.1.0', node: '24.1.0', os: 'linux', arch: 'x64', ci: true, install: 'docker' },
  events: [
    { name: 'doctor.result', at: '2026-11-05T11:59:00.000Z', ok: false, live: true, target: 'local', checks: 9, failing: ['source.error', 'server.down'], warning: [] },
    { name: 'error', at: '2026-11-05T11:59:01.000Z', where: 'cli', command: 'doctor', errorName: 'TypeError', code: null, frames: ['src/cli/doctor.ts:880:18'] }
  ]
}

function post(body: string, headers: Record<string, string> = {}, country?: string): Request {
  const req = new Request('https://telemetry.ezolabs.io/v1/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9', 'user-agent': 'ezo-watcher/0.1.0', ...headers },
    body
  })
  if (country !== undefined) Object.defineProperty(req, 'cf', { value: { country, city: 'Springfield', asn: 64500, latitude: '1.0' } })
  return req
}

describe('POST /v1/events', () => {
  it('stores one row per event with the context, the country and nothing from the request', async () => {
    const { env, ran } = fakeDb()
    const res = await handleRequest(post(JSON.stringify(batch), {}, 'DE'), env, NOW)
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ ok: true, stored: 2, dropped: 0 })
    expect(ran).toHaveLength(2)
    expect(ran[0].sql).toMatch(/^INSERT INTO events \(received_at, sent_at, schema, name, install_id, version, node, os, arch, ci, install, country, props\)/)
    expect(ran[0].values).toEqual([
      NOW.toISOString(), '2026-11-05T11:59:00.000Z', 1, 'doctor.result', ID, '0.1.0', '24.1.0', 'linux', 'x64', 1, 'docker', 'DE',
      JSON.stringify({ ok: false, live: true, target: 'local', checks: 9, failing: ['source.error', 'server.down'], warning: [] })
    ])
    const stored = JSON.stringify(ran)
    for (const leaked of ['203.0.113.9', 'Springfield', '64500', 'user-agent', 'ezo-watcher/0.1.0']) expect(stored).not.toContain(leaked)
  })

  it('stores a null country when Cloudflare gives none or an odd one', async () => {
    const { env, ran } = fakeDb()
    await handleRequest(post(JSON.stringify(batch)), env, NOW)
    await handleRequest(post(JSON.stringify(batch), {}, 'Germany'), env, NOW)
    expect(ran.map((r) => r.values[11])).toEqual([null, null, null, null])
  })

  it('refuses a body that is not JSON, not the schema, or over the limit, and stores nothing', async () => {
    const { env, ran } = fakeDb()
    expect((await handleRequest(post('not json'), env, NOW)).status).toBe(400)
    const wrong = await handleRequest(post(JSON.stringify({ ...batch, context: { ...batch.context, id: 'alice-macbook' } })), env, NOW)
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toEqual({ ok: false, error: 'context.id is not a v4 UUID' })
    expect((await handleRequest(post('x'.repeat(TELEMETRY_MAX_BYTES + 1)), env, NOW)).status).toBe(413)
    expect(ran).toHaveLength(0)
  })

  it('drops an event of an unknown name and keeps the rest', async () => {
    const { env, ran } = fakeDb()
    const res = await handleRequest(post(JSON.stringify({ ...batch, events: [...batch.events, { name: 'later.event', at: '2026-11-05T11:59:02.000Z' }] })), env, NOW)
    expect(await res.json()).toEqual({ ok: true, stored: 2, dropped: 1 })
    expect(ran).toHaveLength(2)
  })

  it('answers 405 to any other method and 404 elsewhere', async () => {
    const { env } = fakeDb()
    expect((await handleRequest(new Request('https://telemetry.ezolabs.io/v1/events'), env)).status).toBe(405)
    expect((await handleRequest(new Request('https://telemetry.ezolabs.io/v2/events', { method: 'POST', body: '{}' }), env)).status).toBe(404)
  })
})

describe('GET /', () => {
  it('says what this is, where the docs and the source are, and how to opt out', async () => {
    const res = await handleRequest(new Request('https://telemetry.ezolabs.io/'), fakeDb().env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('docs/telemetry.md')
    expect(body).toContain('deploy/telemetry')
    expect(body).toContain('DO_NOT_TRACK=1')
  })
})

describe('retention', () => {
  it('deletes rows received before the window', async () => {
    const { env, ran } = fakeDb()
    await prune(env, NOW)
    expect(ran).toEqual([{ sql: 'DELETE FROM events WHERE received_at < ?', values: [new Date(NOW.getTime() - RETENTION_DAYS * 86_400_000).toISOString()] }])
  })
})
