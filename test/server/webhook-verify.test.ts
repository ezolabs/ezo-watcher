// Signed-webhook verification for the generic webhook source (src/server/sources/webhook.ts, the app.ts ingest route and `verify` in
// src/server/config.ts). GitHub and Stripe cannot set an Authorization header, so they sign the body: this proves the three schemes, the exact-bytes
// rule, the replay window, the missing-secret refusal, and the config that wires them. Fixed fixtures, a fixed secret and a fixed clock.
// Run with `npx vitest run --configLoader runner test/server/webhook-verify.test.ts`.
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/server/app.ts'
import type { AppDeps } from '../../src/server/app.ts'
import { validateConfig } from '../../src/server/config.ts'
import type { WatchConfig } from '../../src/server/config.ts'
import { openDb } from '../../src/server/db.ts'
import { Engine } from '../../src/server/engine.ts'
import { hmacSha256Hex, normalizeWebhook, verifyHeaderOf, verifyWebhookRequest } from '../../src/server/sources/webhook.ts'
import type { SourceDeps } from '../../src/server/sources/types.ts'
import { SqlitePushStore } from '../../src/server/stores.ts'
import { signStripePayload } from '../../src/server/stripe-signature.ts'

const T0 = Date.parse('2026-11-04T12:00:00Z')
const NOW = new Date(T0).toISOString()
// Built rather than written whole, so the test holds no credential-shaped literal.
const KEY = ['fixed', 'signing', 'key'].map((part) => part.repeat(2)).join('-')
const STRIPE_KEY = ['fixed', 'stripe', 'secret'].map((part) => part.repeat(2)).join('-')
const BEARER = ['fixed', 'ingest', 'token'].map((part) => part.repeat(2)).join('-')
const ADMIN = ['fixed', 'admin', 'token'].map((part) => part.repeat(2)).join('-')

/** An Alertmanager v4 body with one firing alert: a body the parser accepts, as the exact bytes a sender signs. */
const PAYLOAD = JSON.stringify({
  version: '4',
  groupKey: '{}:{alertname="DiskFull"}',
  status: 'firing',
  receiver: 'watch',
  alerts: [
    {
      status: 'firing',
      labels: { alertname: 'DiskFull', severity: 'critical', instance: 'db-1' },
      annotations: { summary: 'disk full on db-1' },
      startsAt: '2026-11-04T11:00:00Z',
      endsAt: '0001-01-01T00:00:00Z',
      generatorURL: 'https://grafana.example.com/alerting/grafana/rule/view',
      fingerprint: 'a1b2c3d4e5f60718'
    }
  ]
})

const verifyCfg = (over: Record<string, unknown> = {}) => ({ scheme: 'github', secretEnv: 'GITHUB_WEBHOOK_SECRET', ...over })
const headers = (h: Record<string, string>) => new Headers(h)

describe('1. the three schemes, over the exact bytes', () => {
  it('github: X-Hub-Signature-256 as sha256=<hex> of the body verifies; a bare hex does not', () => {
    const good = `sha256=${hmacSha256Hex(PAYLOAD, KEY)}`
    expect(verifyWebhookRequest(PAYLOAD, headers({ 'x-hub-signature-256': good }), verifyCfg() as never, [KEY], T0 / 1000)).toEqual({ ok: true })
    // the header name is read case-insensitively, and an uppercase hex is the same signature
    expect(verifyWebhookRequest(PAYLOAD, headers({ 'X-Hub-Signature-256': good.toUpperCase().replace('SHA256=', 'sha256=') }), verifyCfg() as never, [KEY], T0 / 1000)).toEqual({ ok: true })
    // GitHub always prefixes the scheme; a bare hex is not its header
    expect(verifyWebhookRequest(PAYLOAD, headers({ 'x-hub-signature-256': hmacSha256Hex(PAYLOAD, KEY) }), verifyCfg() as never, [KEY], T0 / 1000)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('github refuses a tampered body, a wrong key, a missing header and a header that is not sha256 hex', () => {
    const good = `sha256=${hmacSha256Hex(PAYLOAD, KEY)}`
    const cfg = verifyCfg() as never
    expect(verifyWebhookRequest(`${PAYLOAD} `, headers({ 'x-hub-signature-256': good }), cfg, [KEY], T0 / 1000)).toEqual({ ok: false, reason: 'mismatch' })
    expect(verifyWebhookRequest(PAYLOAD, headers({ 'x-hub-signature-256': good }), cfg, [`${KEY}x`], T0 / 1000)).toEqual({ ok: false, reason: 'mismatch' })
    expect(verifyWebhookRequest(PAYLOAD, headers({}), cfg, [KEY], T0 / 1000)).toEqual({ ok: false, reason: 'missing' })
    // an empty header value is a missing header, not a malformed one
    expect(verifyWebhookRequest(PAYLOAD, headers({ 'x-hub-signature-256': '' }), cfg, [KEY], T0 / 1000)).toEqual({ ok: false, reason: 'missing' })
    for (const bad of ['sha1=abcd', 'sha256=xyz', `sha256=${'a'.repeat(63)}`, `sha256=${'a'.repeat(65)}`, 'sha256=']) {
      expect(verifyWebhookRequest(PAYLOAD, headers({ 'x-hub-signature-256': bad }), cfg, [KEY], T0 / 1000), bad).toEqual({ ok: false, reason: 'malformed' })
    }
  })

  it('stripe: Stripe-Signature verifies inside its five minute window and refuses a stale or tampered one', () => {
    const cfg = { scheme: 'stripe', secretEnv: 'STRIPE_WEBHOOK_SECRET' } as never
    const nowSec = Math.floor(T0 / 1000)
    const fresh = signStripePayload(PAYLOAD, STRIPE_KEY, nowSec)
    expect(verifyWebhookRequest(PAYLOAD, headers({ 'stripe-signature': fresh }), cfg, [STRIPE_KEY], nowSec)).toEqual({ ok: true })
    // 300 s is the window: exactly 300 is taken, 301 is not
    expect(verifyWebhookRequest(PAYLOAD, headers({ 'stripe-signature': signStripePayload(PAYLOAD, STRIPE_KEY, nowSec - 300) }), cfg, [STRIPE_KEY], nowSec)).toEqual({ ok: true })
    expect(verifyWebhookRequest(PAYLOAD, headers({ 'stripe-signature': signStripePayload(PAYLOAD, STRIPE_KEY, nowSec - 301) }), cfg, [STRIPE_KEY], nowSec)).toEqual({ ok: false, reason: 'stale' })
    expect(verifyWebhookRequest(`${PAYLOAD}x`, headers({ 'stripe-signature': fresh }), cfg, [STRIPE_KEY], nowSec)).toEqual({ ok: false, reason: 'mismatch' })
    expect(verifyWebhookRequest(PAYLOAD, headers({ 'stripe-signature': 't=1,v1=abc' }), cfg, [STRIPE_KEY], nowSec)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyWebhookRequest(PAYLOAD, headers({}), cfg, [STRIPE_KEY], nowSec)).toEqual({ ok: false, reason: 'missing' })
  })

  it('generic hmac-sha256: a bare or sha256=<hex> HMAC in the configured header (default X-Signature-256)', () => {
    const bare = hmacSha256Hex(PAYLOAD, KEY)
    const cfg = { scheme: 'hmac-sha256', secretEnv: 'GENERIC_WEBHOOK_SECRET' } as never
    expect(verifyHeaderOf(cfg)).toBe('x-signature-256')
    expect(verifyWebhookRequest(PAYLOAD, headers({ 'x-signature-256': bare }), cfg, [KEY], T0 / 1000)).toEqual({ ok: true })
    expect(verifyWebhookRequest(PAYLOAD, headers({ 'x-signature-256': `sha256=${bare}` }), cfg, [KEY], T0 / 1000)).toEqual({ ok: true })
    expect(verifyWebhookRequest(PAYLOAD, headers({ 'x-signature-256': bare }), cfg, [KEY], T0 / 1000 + 86_400)).toEqual({ ok: true })
    const named = { scheme: 'hmac-sha256', secretEnv: 'GENERIC_WEBHOOK_SECRET', header: 'X-Relay-Signature' } as never
    expect(verifyHeaderOf(named)).toBe('x-relay-signature')
    expect(verifyWebhookRequest(PAYLOAD, headers({ 'x-relay-signature': bare }), named, [KEY], T0 / 1000)).toEqual({ ok: true })
    expect(verifyWebhookRequest(PAYLOAD, headers({ 'x-signature-256': bare }), named, [KEY], T0 / 1000)).toEqual({ ok: false, reason: 'missing' })
  })

  it('a missing secret never falls open: an empty list or an empty value refuses every push', () => {
    const good = `sha256=${hmacSha256Hex(PAYLOAD, KEY)}`
    for (const secrets of [[], [''], ['', '']]) {
      expect(verifyWebhookRequest(PAYLOAD, headers({ 'x-hub-signature-256': good }), verifyCfg() as never, secrets, T0 / 1000)).toEqual({ ok: false, reason: 'no secret' })
    }
    // any one of several keys verifies, and every key is tried (a rotated secret keeps working until removed)
    expect(verifyWebhookRequest(PAYLOAD, headers({ 'x-hub-signature-256': `sha256=${hmacSha256Hex(PAYLOAD, 'old-key')}` }), verifyCfg() as never, ['old-key', KEY], T0 / 1000)).toEqual({ ok: true })
  })

  it('hashes bytes, not text: a body with a multibyte character signs as the bytes GitHub sent', () => {
    const body = Buffer.from('{"message":"crème brûlée"}', 'utf8')
    const hex = hmacSha256Hex(body, KEY)
    expect(verifyWebhookRequest(body, headers({ 'x-signature-256': hex }), { scheme: 'hmac-sha256', secretEnv: 'S' } as never, [KEY], T0 / 1000)).toEqual({ ok: true })
    // the same characters re-encoded from the decoded string are the same bytes here, but a body signed as text must not verify against other bytes
    expect(verifyWebhookRequest(Buffer.from('{"message":"creme brulee"}', 'utf8'), headers({ 'x-signature-256': hex }), { scheme: 'hmac-sha256', secretEnv: 'S' } as never, [KEY], T0 / 1000)).toEqual({ ok: false, reason: 'mismatch' })
  })
})

describe('2. the config: `verify` on a webhook source', () => {
  const base = (): WatchConfig => ({
    baseUrl: 'https://watch.test',
    dataDir: '.watcher/data',
    historyHours: 24,
    staleAfterMisses: 3,
    sources: [{ id: 'gh', type: 'webhook', verify: { scheme: 'github', secretEnv: 'GITHUB_WEBHOOK_SECRET' } }],
    serviceMap: [],
    channels: [],
    routes: [],
    quietHours: null
  })
  const errorsOf = (cfg: WatchConfig): string => {
    const out = validateConfig(cfg)
    return out.ok ? '' : out.errors.join('; ')
  }
  const withSource = (source: unknown): string => {
    const cfg = base()
    cfg.sources = [source as never]
    return errorsOf(cfg)
  }

  it('accepts each scheme, with or without a tokenEnv, and a source that keeps its Bearer token alone', () => {
    for (const scheme of ['github', 'stripe', 'hmac-sha256']) {
      expect(withSource({ id: 's', type: 'webhook', verify: { scheme, secretEnv: 'SIGNING_SECRET' } }), scheme).toBe('')
    }
    expect(withSource({ id: 's', type: 'webhook', tokenEnv: 'TOKEN', verify: { scheme: 'github', secretEnv: 'SIGNING_SECRET' } })).toBe('')
    expect(withSource({ id: 's', type: 'webhook', tokenEnv: 'TOKEN' })).toBe('')
    // hmac-sha256 may name its own header
    expect(withSource({ id: 's', type: 'webhook', verify: { scheme: 'hmac-sha256', secretEnv: 'S', header: 'X-Relay-Signature' } })).toBe('')
  })

  it('refuses a source with neither credential, a bad scheme, a bad secretEnv, a header where it does not belong and a reserved header', () => {
    expect(withSource({ id: 's', type: 'webhook' })).toContain('needs a tokenEnv, or a verify block naming the env var')
    expect(withSource({ id: 's', type: 'webhook', tokenEnv: '' })).toContain('needs a tokenEnv, or a verify block')
    expect(withSource({ id: 's', type: 'webhook', verify: { scheme: 'github', secretEnv: 'S', header: 'X-Hub-Signature-256' } })).toContain('verify.header is only for scheme hmac-sha256')
    expect(withSource({ id: 's', type: 'webhook', verify: { scheme: 'hmac-sha1', secretEnv: 'S' } })).toContain('verify.scheme must be github, stripe or hmac-sha256')
    for (const secretEnv of [undefined, '', 'not a name', '1ABC', 'A-B']) {
      expect(withSource({ id: 's', type: 'webhook', verify: { scheme: 'github', secretEnv } }), String(secretEnv)).toContain('verify.secretEnv must name an environment variable')
    }
    for (const header of ['', 'X Signature', 'x-signature-256\n', 'a'.repeat(65)]) {
      expect(withSource({ id: 's', type: 'webhook', verify: { scheme: 'hmac-sha256', secretEnv: 'S', header } }), header).toContain('verify.header must be a header name')
    }
    for (const header of ['authorization', 'Content-Type', 'HOST', 'cookie']) {
      expect(withSource({ id: 's', type: 'webhook', verify: { scheme: 'hmac-sha256', secretEnv: 'S', header } }), header).toContain('may not be')
    }
  })

  it('refuses verify on a source that is not a webhook, and a tokenEnv that is a value instead of a name', () => {
    expect(
      withSource({ id: 'g', type: 'grafana', url: 'http://g', tokenEnv: 'T', pollSec: 10, verify: { scheme: 'github', secretEnv: 'S' } })
    ).toContain('verify is only for a webhook source')
    expect(withSource({ id: 's', type: 'webhook', tokenEnv: 'not a name', verify: { scheme: 'github', secretEnv: 'S' } })).toContain('tokenEnv must name an environment variable')
  })
})

// ---- the route ---------------------------------------------------------------------------------------------------------------------------

describe('3. POST /ingest/:source with a signed push', () => {
  const cfg: WatchConfig = {
    baseUrl: 'https://watch.test',
    port: 0,
    host: '127.0.0.1',
    dataDir: ':memory:',
    historyHours: 24,
    staleAfterMisses: 3,
    sources: [
      { id: 'gh', type: 'webhook', verify: { scheme: 'github', secretEnv: 'GITHUB_WEBHOOK_SECRET' } },
      { id: 'stripe', type: 'webhook', verify: { scheme: 'stripe', secretEnv: 'STRIPE_WEBHOOK_SECRET' } },
      { id: 'relay', type: 'webhook', verify: { scheme: 'hmac-sha256', secretEnv: 'RELAY_WEBHOOK_SECRET', header: 'X-Relay-Signature' } },
      { id: 'both', type: 'webhook', tokenEnv: 'INGEST_TOKEN', verify: { scheme: 'github', secretEnv: 'GITHUB_WEBHOOK_SECRET' } },
      { id: 'bearer', type: 'webhook', tokenEnv: 'INGEST_TOKEN' }
    ],
    serviceMap: [],
    channels: [],
    routes: [],
    quietHours: null
  }
  const env: NodeJS.ProcessEnv = {
    WATCHER_ADMIN_TOKEN: ADMIN,
    GITHUB_WEBHOOK_SECRET: KEY,
    STRIPE_WEBHOOK_SECRET: STRIPE_KEY,
    RELAY_WEBHOOK_SECRET: KEY,
    INGEST_TOKEN: BEARER
  }
  let clock = T0
  let app: ReturnType<typeof createApp>
  let engine: Engine

  beforeEach(() => {
    clock = T0
    const db = openDb(':memory:')
    engine = new Engine(db, cfg, () => clock)
    const deps: SourceDeps = { fetch: (() => Promise.reject(new Error('unused'))) as unknown as typeof fetch, env, nowIso: () => new Date(clock).toISOString(), serviceMap: [], log: () => undefined }
    const appDeps: AppDeps = {
      engine,
      cfg,
      env,
      db,
      push: new SqlitePushStore(db),
      ackSecret: ['route', 'test', 'secret'].map((p) => p.repeat(2)).join('-'),
      webDir: '/nonexistent',
      normalizeWebhook: (payload, ctx) => normalizeWebhook(payload, { ...ctx, deps }),
      testChannel: async () => ({ ok: true, status: 'ok', latencyMs: 1 }),
      nudge: () => undefined,
      vapidPublicKey: null,
      now: () => clock,
      log: () => undefined
    }
    app = createApp(appDeps)
  })

  const push = (source: string, body: string, headers: Record<string, string> = {}) =>
    app.request(`/ingest/${source}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })

  it('a GitHub-signed push is accepted and becomes the alert, with no Authorization header at all', async () => {
    const res = await push('gh', PAYLOAD, { 'x-hub-signature-256': `sha256=${hmacSha256Hex(PAYLOAD, KEY)}` })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, firing: 1, resolved: 0 })
    expect(engine.wall().incidents).toHaveLength(1)
  })

  it('refuses an unsigned, wrongly signed, tampered and replayed-shaped push with the same 401', async () => {
    const signed = `sha256=${hmacSha256Hex(PAYLOAD, KEY)}`
    for (const [body, header] of [
      [PAYLOAD, {}],
      [PAYLOAD, { 'x-hub-signature-256': `sha256=${hmacSha256Hex(PAYLOAD, `${KEY}x`)}` }],
      [`${PAYLOAD} `, { 'x-hub-signature-256': signed }],
      [PAYLOAD, { 'x-hub-signature-256': 'sha256=nothex' }],
      [PAYLOAD, { authorization: `Bearer ${BEARER}` }]
    ] as const) {
      const res = await push('gh', body, header)
      expect(res.status, JSON.stringify(header)).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthorized' })
    }
    expect(engine.wall().incidents).toHaveLength(0)
  })

  it('a Stripe-signed push is accepted, and one signed for another time is stale', async () => {
    const nowSec = Math.floor(T0 / 1000)
    const ok = await push('stripe', PAYLOAD, { 'stripe-signature': signStripePayload(PAYLOAD, STRIPE_KEY, nowSec) })
    expect(ok.status).toBe(200)
    const stale = await push('stripe', PAYLOAD, { 'stripe-signature': signStripePayload(PAYLOAD, STRIPE_KEY, nowSec - 3600) })
    expect(stale.status).toBe(401)
  })

  it('a relay with a header of its own signs and is accepted; the default header does not authenticate it', async () => {
    const hex = hmacSha256Hex(PAYLOAD, KEY)
    expect((await push('relay', PAYLOAD, { 'x-relay-signature': hex })).status).toBe(200)
    expect((await push('relay', PAYLOAD, { 'x-signature-256': hex })).status).toBe(401)
  })

  it('a source with both credentials accepts either, and a Bearer-only source still refuses a signature', async () => {
    expect((await push('both', PAYLOAD, { authorization: `Bearer ${BEARER}` })).status).toBe(200)
    expect((await push('both', PAYLOAD, { 'x-hub-signature-256': `sha256=${hmacSha256Hex(PAYLOAD, KEY)}` })).status).toBe(200)
    expect((await push('bearer', PAYLOAD, { 'x-hub-signature-256': `sha256=${hmacSha256Hex(PAYLOAD, KEY)}` })).status).toBe(401)
    expect((await push('bearer', PAYLOAD, { authorization: `Bearer ${BEARER}` })).status).toBe(200)
  })

  it('a host with the signing secret missing refuses the push (503 is not the door) and the route never falls open', async () => {
    const db = openDb(':memory:')
    const bare = new Engine(db, cfg, () => clock)
    const deps: SourceDeps = { fetch: (() => Promise.reject(new Error('unused'))) as unknown as typeof fetch, env: {}, nowIso: () => new Date(clock).toISOString(), serviceMap: [] }
    const bareApp = createApp({
      engine: bare,
      cfg,
      env: {},
      db,
      push: new SqlitePushStore(db),
      ackSecret: 'route-test-secret',
      webDir: '/nonexistent',
      normalizeWebhook: (payload, ctx) => normalizeWebhook(payload, { ...ctx, deps }),
      testChannel: async () => ({ ok: true, status: 'ok', latencyMs: 1 }),
      nudge: () => undefined,
      vapidPublicKey: null,
      now: () => clock
    })
    const res = await bareApp.request('/ingest/gh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${hmacSha256Hex(PAYLOAD, KEY)}` },
      body: PAYLOAD
    })
    expect(res.status).toBe(401)
    expect(bare.wall().incidents).toHaveLength(0)
  })

  it('the re-check request routes keep their Bearer protocol: a verify-only source answers 401 there', async () => {
    const res = await app.request('/ingest/gh/recheck-requests')
    expect(res.status).toBe(401)
  })

  it('an unknown source id is still a 404, before any credential is asked for', async () => {
    const res = await push('nope', PAYLOAD, { 'x-hub-signature-256': `sha256=${hmacSha256Hex(PAYLOAD, KEY)}` })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'unknown source' })
  })

  it('an oversized body is a 413 before the credential is read', async () => {
    const res = await push('gh', PAYLOAD, { 'content-length': String(2 * 1024 * 1024) })
    expect(res.status).toBe(413)
  })
})
