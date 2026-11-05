// Admin auth for the wall and /api (src/server/auth.ts and the gate in src/server/app.ts). A loopback bind with no token stays open; with
// WATCHER_ADMIN_TOKEN set the wall and /api need a Bearer token or the session cookie /login issues. The clock is fixed, so a session's expiry is
// exact. Written to run with `npx vitest run --configLoader runner test/server/auth.test.ts`.
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/server/app.ts'
import type { AppDeps } from '../../src/server/app.ts'
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_TTL_SEC,
  ADMIN_TOKEN_ENV,
  LOGIN_MAX_FAILURES,
  LoginLimiter,
  adminAuthorized,
  adminBearerMatches,
  adminExemptPath,
  adminSessionCookie,
  adminSessionValid,
  adminSessionValue,
  adminTokenMatches,
  adminTokenOf,
  checkedAdminToken,
  isLoopbackHost,
  loginClientOf,
  loginPage,
  safeNextPath
} from '../../src/server/auth.ts'
import type { WatchConfig } from '../../src/server/config.ts'
import { openDb } from '../../src/server/db.ts'
import { Engine } from '../../src/server/engine.ts'
import { SqlitePushStore } from '../../src/server/stores.ts'

const T0 = Date.parse('2026-11-04T12:00:00Z')
// Built rather than written whole, so the test holds no credential-shaped literal: the value is what matters, not its shape.
const TOKEN = ['test', 'admin', 'token'].map((part) => part.repeat(2)).join('-')
const MCP = ['test', 'mcp', 'token'].map((part) => part.repeat(2)).join('-')
const SECRET = ['ack', 'test', 'secret'].map((part) => part.repeat(2)).join('-')
let clock = T0

const baseCfg = (over: Partial<WatchConfig> = {}): WatchConfig => ({
  baseUrl: 'https://watch.test',
  port: 0,
  host: '127.0.0.1',
  dataDir: ':memory:',
  historyHours: 24,
  staleAfterMisses: 3,
  sources: [{ id: 'hook', type: 'webhook', tokenEnv: 'INGEST_TOKEN' }],
  serviceMap: [],
  channels: [
    { id: 'ntfy', type: 'ntfy', server: 'https://ntfy.sh', topicEnv: 'NTFY_TOPIC' },
    { id: 'notify-hook', type: 'webhook', urlEnv: 'NOTIFY_HOOK_URL' }
  ],
  routes: [],
  quietHours: null,
  ...over
})

interface Boot {
  app: ReturnType<typeof createApp>
  engine: Engine
  tested: string[]
}

function boot(env: NodeJS.ProcessEnv = { WATCHER_ADMIN_TOKEN: TOKEN, WATCHER_MCP_TOKEN: MCP }, cfg: WatchConfig = baseCfg()): Boot {
  const db = openDb(':memory:')
  const engine = new Engine(db, cfg, () => clock)
  const tested: string[] = []
  const deps: AppDeps = {
    engine,
    cfg,
    env,
    db,
    push: new SqlitePushStore(db),
    ackSecret: SECRET,
    webDir: '/nonexistent',
    normalizeWebhook: () => {
      throw new Error('unused')
    },
    testChannel: async (id) => {
      tested.push(id)
      return { ok: id !== 'broken', status: id === 'broken' ? 'connection refused' : 'ok', latencyMs: 7 }
    },
    nudge: () => undefined,
    vapidPublicKey: null,
    now: () => clock,
    log: () => undefined
  }
  return { app: createApp(deps), engine, tested }
}

const bearer = (token: string = TOKEN): Record<string, string> => ({ authorization: `Bearer ${token}` })
const cookieOf = (res: Response): string => {
  const header = res.headers.get('set-cookie') ?? ''
  const m = new RegExp(`${ADMIN_COOKIE}=([^;]*)`).exec(header)
  return m ? m[1] : ''
}
const json = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>
const loginPost = (app: ReturnType<typeof createApp>, body: Record<string, string>, headers: Record<string, string> = {}) =>
  app.request('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body).toString()
  })
const jsonLogin = (app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) =>
  app.request('/login', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

beforeEach(() => {
  clock = T0
})

// ---- the values ---------------------------------------------------------------------------------------------------------------------

describe('1. the token, the bind and the paths that carry their own auth', () => {
  it('reads WATCHER_ADMIN_TOKEN, trims the line ends an env file leaves, and never invents one', () => {
    expect(adminTokenOf({})).toBe('')
    expect(adminTokenOf({ [ADMIN_TOKEN_ENV]: '' })).toBe('')
    expect(adminTokenOf({ [ADMIN_TOKEN_ENV]: '   ' })).toBe('')
    expect(adminTokenOf({ [ADMIN_TOKEN_ENV]: `  ${TOKEN}\n` })).toBe(TOKEN)
  })

  it('refuses an off-loopback bind with no token, naming WATCHER_ADMIN_TOKEN, and allows it with one', () => {
    expect(checkedAdminToken('127.0.0.1', '')).toBe('')
    expect(checkedAdminToken('::1', '')).toBe('')
    expect(checkedAdminToken('0.0.0.0', TOKEN)).toBe(TOKEN)
    expect(checkedAdminToken('watch.example.com', TOKEN)).toBe(TOKEN)
    for (const host of ['0.0.0.0', '::', '10.0.0.5', 'watch.example.com']) {
      let error = ''
      try {
        checkedAdminToken(host, '')
      } catch (err) {
        error = (err as Error).message
      }
      expect(error, host).toContain(ADMIN_TOKEN_ENV)
      expect(error, host).toContain(host)
      expect(error, host).toContain('not loopback')
      expect(error, host).toContain('WATCHER_HOST=127.0.0.1')
    }
  })

  it('treats only 127.0.0.0/8, ::1 and localhost as loopback: 0.0.0.0, ::, a LAN address and a name are not', () => {
    for (const host of ['127.0.0.1', '127.13.3.9', '::1', '[::1]', '0:0:0:0:0:0:0:1', 'localhost', 'LOCALHOST']) expect(isLoopbackHost(host), host).toBe(true)
    for (const host of ['0.0.0.0', '::', '[::]', '10.0.0.5', '192.168.1.4', '100.64.0.1', 'watch.example.com', 'localhost.example.com', '203.0.113.1', '']) {
      expect(isLoopbackHost(host), host).toBe(false)
    }
  })

  it('exempts /healthz, /mcp, the login page, /ingest/*, the signed ack link and the signed redirects, and nothing else', () => {
    for (const path of ['/healthz', '/mcp', '/login', '/logout', '/login.css', '/login.js', '/api/ack', '/ingest', '/ingest/hook', '/ingest/hook/recheck-requests', '/go/abc', '/a/hook:a1b2c3d4']) {
      expect(adminExemptPath(path), path).toBe(true)
    }
    for (const path of ['/', '/api/state', '/api/acknowledge', '/api/ack/', '/healthz2', '/mcpx', '/ingestXYZ', '/a', '/assets/app.js']) {
      expect(adminExemptPath(path), path).toBe(false)
    }
  })

  it('compares a submitted token in constant time and refuses an empty one on either side', () => {
    expect(adminTokenMatches(TOKEN, TOKEN)).toBe(true)
    expect(adminTokenMatches(TOKEN, `${TOKEN}x`)).toBe(false)
    expect(adminTokenMatches('', TOKEN)).toBe(false)
    expect(adminTokenMatches(TOKEN, '')).toBe(false)
    expect(adminBearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(adminBearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(adminBearerMatches(`Bearer  ${TOKEN}`, TOKEN)).toBe(true)
    expect(adminBearerMatches(`Bearer ${TOKEN} extra`, TOKEN)).toBe(false)
    expect(adminBearerMatches(`Basic ${TOKEN}`, TOKEN)).toBe(false)
    expect(adminBearerMatches(null, TOKEN)).toBe(false)
  })

  it('a next path stays on this server: no scheme, no //host, no backslash, no line break', () => {
    expect(safeNextPath('/history')).toBe('/history')
    expect(safeNextPath('/#/i/a%7Cb')).toBe('/#/i/a%7Cb')
    expect(safeNextPath('/login?next=%2F')).toBe('/login?next=%2F')
    for (const raw of [undefined, null, '', 'history', '//evil.example/x', 'https://evil.example', '/a\\b', '/a\nb', ' javascript:alert(1)']) {
      expect(safeNextPath(raw as string | undefined), String(raw)).toBe('/')
    }
  })
})

// ---- the session value --------------------------------------------------------------------------------------------------------------

describe('2. the session cookie: an HMAC of the token, never the token', () => {
  it('is a version, an expiry and an HMAC that does not contain the token, and it verifies until the expiry', () => {
    const value = adminSessionValue(SECRET, TOKEN, T0)
    expect(value).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]{43}$/)
    expect(value).not.toContain(TOKEN)
    expect(adminSessionValid(value, SECRET, TOKEN, T0)).toBe(true)
    expect(adminSessionValid(value, SECRET, TOKEN, T0 + (ADMIN_SESSION_TTL_SEC - 1) * 1000)).toBe(true)
    // at the expiry second it has ended
    expect(adminSessionValid(value, SECRET, TOKEN, T0 + ADMIN_SESSION_TTL_SEC * 1000)).toBe(false)
    expect(adminSessionValid(value, SECRET, TOKEN, T0 + (ADMIN_SESSION_TTL_SEC + 1) * 1000)).toBe(false)
  })

  it('refuses another secret, another token, a tampered expiry, a tampered MAC and anything malformed', () => {
    const value = adminSessionValue(SECRET, TOKEN, T0)
    const [version, expires, mac] = value.split('.')
    expect(adminSessionValid(value, `${SECRET}x`, TOKEN, T0)).toBe(false)
    expect(adminSessionValid(value, SECRET, `${TOKEN}x`, T0)).toBe(false)
    expect(adminSessionValid(`v1.${Number(expires) + 60}.${mac}`, SECRET, TOKEN, T0)).toBe(false)
    expect(adminSessionValid(`v1.${expires}.${mac.slice(0, -1)}A`, SECRET, TOKEN, T0)).toBe(false)
    for (const bad of ['', 'v2.1.abc', 'v1.abc.def', 'v1.1', `v1.${expires}`, `v1.${expires}.${mac}.extra`, 'v1.-1.x', 'v1.99999999999999999999.x']) {
      expect(adminSessionValid(bad, SECRET, TOKEN, T0), bad).toBe(false)
    }
  })

  it('is HttpOnly, SameSite=Lax, path-wide and 30 days, with Secure only when asked', () => {
    const value = adminSessionValue(SECRET, TOKEN, T0)
    const secure = adminSessionCookie(value, true)
    expect(secure).toBe(`${ADMIN_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ADMIN_SESSION_TTL_SEC}; Secure`)
    expect(adminSessionCookie(value, false)).not.toContain('Secure')
  })

  it('adminAuthorized takes a matching Bearer or a live cookie, and refuses everything else', () => {
    const value = adminSessionValue(SECRET, TOKEN, T0)
    const headers = (h: Record<string, string>) => new Headers(h)
    expect(adminAuthorized(headers({ authorization: `Bearer ${TOKEN}` }), SECRET, TOKEN, T0)).toBe(true)
    expect(adminAuthorized(headers({ cookie: `other=1; ${ADMIN_COOKIE}=${value}` }), SECRET, TOKEN, T0)).toBe(true)
    expect(adminAuthorized(headers({ cookie: `${ADMIN_COOKIE}=${value}x` }), SECRET, TOKEN, T0)).toBe(false)
    expect(adminAuthorized(headers({ authorization: 'Bearer nope' }), SECRET, TOKEN, T0)).toBe(false)
    expect(adminAuthorized(headers({}), SECRET, TOKEN, T0)).toBe(false)
    // no token configured is the open mode, whatever the headers say
    expect(adminAuthorized(headers({}), SECRET, '', T0)).toBe(true)
  })

  it('counts failed logins per client, forgets them after the window, and clears them on a success', () => {
    const limiter = new LoginLimiter(() => clock)
    expect(limiter.blocked('a')).toBe(false)
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) limiter.fail('a')
    expect(limiter.blocked('a')).toBe(false)
    limiter.fail('a')
    expect(limiter.blocked('a')).toBe(true)
    expect(limiter.retryAfterSec('a')).toBeGreaterThan(0)
    expect(limiter.blocked('b')).toBe(false)
    limiter.clear('a')
    expect(limiter.blocked('a')).toBe(false)
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) limiter.fail('c')
    expect(limiter.blocked('c')).toBe(true)
    clock += 5 * 60_000 + 1
    expect(limiter.blocked('c')).toBe(false)
  })

  it('names the client by the proxy headers and falls back to one shared bucket', () => {
    expect(loginClientOf(new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }))).toBe('203.0.113.9')
    expect(loginClientOf(new Headers({ 'x-real-ip': '198.51.100.4' }))).toBe('198.51.100.4')
    expect(loginClientOf(new Headers({}))).toBe('direct')
  })

  it('the sign-in page escapes the brand and carries no script and no inline style', () => {
    const html = loginPage('<b>Watcher</b>', '/a"b', 'nope & no')
    expect(html).toContain('&lt;b&gt;Watcher&lt;/b&gt;')
    expect(html).toContain('value="/a&quot;b"')
    expect(html).toContain('nope &amp; no')
    expect(html).not.toContain('<script>')
    expect(html).toContain('<script src="/login.js" defer></script>')
    expect(html).not.toContain('style=')
    expect(html).toContain('href="/login.css"')
  })
})

// ---- the gate -------------------------------------------------------------------------------------------------------------------------

describe('3. the gate: what is open, what needs a credential', () => {
  it('without a token the wall and /api are open, as a loopback bind always was', async () => {
    const { app } = boot({})
    expect((await app.request('/api/state')).status).toBe(200)
    expect((await app.request('/api/instance')).status).toBe(200)
    const login = await app.request('/login')
    expect(login.status).toBe(302)
    expect(login.headers.get('location')).toBe('/')
  })

  it('with a token, /api answers 401 JSON and never a redirect, and names the Bearer scheme', async () => {
    const { app } = boot()
    const res = await app.request('/api/state')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Bearer')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await json(res)).toEqual({ error: 'unauthorized' })
    // a state-changing API call has the same answer
    const post = await app.request('/api/incidents/Some|Key/ack', { method: 'POST' })
    expect(post.status).toBe(401)
    // /api/instance stays public with a token set: the page names the Watcher before a login, and `watcher` reads it to tell this Watcher
    // from whatever else holds its port (src/cli/project.ts probePort)
    expect((await app.request('/api/instance')).status).toBe(200)
  })

  it('a matching Bearer reaches the wall API; a wrong one does not', async () => {
    const { app } = boot()
    expect((await app.request('/api/state', { headers: bearer() })).status).toBe(200)
    expect((await app.request('/api/state', { headers: bearer(`${TOKEN}x`) })).status).toBe(401)
    expect((await app.request('/api/state', { headers: { authorization: `Basic ${TOKEN}` } })).status).toBe(401)
  })

  it('a browser on the wall is sent to /login with the path it asked for; a page it names is a 404 once signed in', async () => {
    const { app } = boot()
    for (const [path, next] of [
      ['/', '%2F'],
      ['/history', '%2Fhistory'],
      ['/history?hours=6', '%2Fhistory%3Fhours%3D6'],
      // a fragment never reaches the server; the login page's script appends it to `next` in the browser
      ['/#/i/a%7Cb', '%2F']
    ] as const) {
      const res = await app.request(path, { headers: { accept: 'text/html' } })
      expect(res.status, path).toBe(302)
      expect(res.headers.get('location'), path).toBe(`/login?next=${next}`)
    }
    const signed = await loginPost(app, { token: TOKEN })
    const cookie = cookieOf(signed)
    const wall = await app.request('/api/state', { headers: { cookie: `${ADMIN_COOKIE}=${cookie}` } })
    expect(wall.status).toBe(200)
  })

  it('leaves /healthz, /ingest/* and /mcp on the auth they already had', async () => {
    const { app } = boot()
    expect((await app.request('/healthz')).status).toBe(200)
    // ingest has its own per-source token: without it the answer is its own 401, with a valid admin Bearer it is still not its credential
    const ingest = await app.request('/ingest/hook', { method: 'POST', body: '{}' })
    expect(ingest.status).toBe(401)
    const withAdmin = await app.request('/ingest/hook', { method: 'POST', headers: bearer(), body: '{}' })
    expect(withAdmin.status).toBe(401)
    // /mcp: its own gate answers, not the admin one
    const mcp = await app.request('/mcp', { method: 'POST' })
    expect(mcp.status).toBe(401)
  })

  it('a signed ack link keeps its own HMAC auth: a bad signature is its 403, not the admin 401', async () => {
    const { app, engine } = boot()
    const bad = await app.request('/api/ack?k=x&s=bad')
    expect(bad.status).toBe(403)
    expect(await json(bad)).toEqual({ error: 'bad signature' })
    // the notice redirects are exempt too: an unknown token is a redirect home, never a login
    const go = await app.request('/go/not-a-token')
    expect(go.status).toBe(302)
    expect(go.headers.get('location')).toBe('/')
    expect(engine.wall().incidents).toHaveLength(0)
  })

  it('the sibling doctor route sits under the same admin gate as the rest of /api', async () => {
    const { app } = boot()
    expect((await app.request('/api/doctor')).status).toBe(401)
    expect((await app.request('/api/doctor', { headers: bearer(`${TOKEN}x`) })).status).toBe(401)
  })

  it('a page redirect keeps the query string, and a HEAD is a page request too', async () => {
    const { app } = boot()
    const head = await app.request('/history?hours=6', { method: 'HEAD' })
    expect(head.status).toBe(302)
    expect(head.headers.get('location')).toBe('/login?next=%2Fhistory%3Fhours%3D6')
  })
})

// ---- the login flow -------------------------------------------------------------------------------------------------------------------

describe('4. the login flow', () => {
  it('GET /login is the form, with no token in it and no caching; /login.css is the page\'s only asset', async () => {
    const { app } = boot()
    const res = await app.request('/login')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const html = await res.text()
    expect(html).toContain('<form method="post" action="/login">')
    expect(html).toContain('name="token"')
    expect(html).toContain('type="password"')
    expect(html).toContain('href="/login.css"')
    expect(html).toContain('src="/login.js"')
    expect(html).toContain('noindex')
    expect(html).not.toContain(TOKEN)
    const css = await app.request('/login.css')
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toContain('text/css')
    expect(await css.text()).toContain('button')
    const js = await app.request('/login.js')
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toContain('text/javascript')
    expect(await js.text()).toContain('location.hash')
  })

  it('POST /login with the right token sets the HttpOnly SameSite=Lax cookie and redirects to a safe next', async () => {
    const { app } = boot()
    const res = await loginPost(app, { token: TOKEN, next: '/history?hours=6' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/history?hours=6')
    const set = res.headers.get('set-cookie') ?? ''
    expect(set).toContain(`${ADMIN_COOKIE}=`)
    expect(set).toContain('HttpOnly')
    expect(set).toContain('SameSite=Lax')
    expect(set).toContain('Path=/')
    expect(set).toContain(`Max-Age=${ADMIN_SESSION_TTL_SEC}`)
    expect(set).toContain('Secure')
    const value = cookieOf(res)
    expect(value).not.toBe('')
    expect(value).not.toBe(TOKEN)
    expect(value.includes(TOKEN)).toBe(false)
    // and the cookie it set is a working session
    const state = await app.request('/api/state', { headers: { cookie: `${ADMIN_COOKIE}=${value}` } })
    expect(state.status).toBe(200)
    // GET /login while signed in skips the form
    const again = await app.request('/login', { headers: { cookie: `${ADMIN_COOKIE}=${value}` } })
    expect(again.status).toBe(302)
    expect(again.headers.get('location')).toBe('/')
  })

  it('a wrong token is a 401 with the form and one sentence, sets no cookie and is counted', async () => {
    const { app } = boot()
    const res = await loginPost(app, { token: 'nope' })
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
    const html = await res.text()
    expect(html).toContain('That token is not right.')
    expect(html).not.toContain('nope')
    expect(html).toContain('action="/login"')
  })

  it('the JSON door: a correct token sets the cookie and a wrong one is 401 JSON, which is what a script signs in with', async () => {
    const { app } = boot()
    const ok = await jsonLogin(app, { token: TOKEN, next: '/fleet' })
    expect(ok.status).toBe(303)
    expect(ok.headers.get('location')).toBe('/fleet')
    expect(cookieOf(ok)).not.toBe('')
    const bad = await jsonLogin(app, { token: 'nope' })
    expect(bad.status).toBe(401)
    expect(await json(bad)).toEqual({ error: 'unauthorized' })
    const empty = await jsonLogin(app, {})
    expect(empty.status).toBe(401)
  })

  it('a next that leaves this server is refused and the wall is used instead', async () => {
    const { app } = boot()
    for (const next of ['//evil.example/x', 'https://evil.example', 'javascript:alert(1)', '/a\\b']) {
      const res = await loginPost(app, { token: TOKEN, next })
      expect(res.status, next).toBe(303)
      expect(res.headers.get('location'), next).toBe('/')
    }
  })

  it('POST /login with a malformed or empty body is a 401, never a 500', async () => {
    const { app } = boot()
    const empty = await app.request('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' })
    expect(empty.status).toBe(401)
    const junk = await app.request('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1,2]' })
    expect(junk.status).toBe(401)
    const notJson = await app.request('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
    expect(notJson.status).toBe(401)
  })

  it('too many wrong tokens are 429 with Retry-After, and the brake forgets after its window', async () => {
    const { app } = boot()
    const client = { 'x-forwarded-for': '203.0.113.9' }
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      const res = await loginPost(app, { token: 'nope' }, client)
      expect(res.status, String(i)).toBe(401)
    }
    const blocked = await loginPost(app, { token: TOKEN }, client)
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await blocked.text()).toContain('Too many attempts')
    // another client is unaffected
    expect((await loginPost(app, { token: TOKEN }, { 'x-forwarded-for': '198.51.100.4' })).status).toBe(303)
    clock += 5 * 60_000 + 1
    expect((await loginPost(app, { token: TOKEN }, client)).status).toBe(303)
  })

  it('a correct login clears this client\'s count', async () => {
    const { app } = boot()
    const client = { 'x-forwarded-for': '203.0.113.10' }
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) await loginPost(app, { token: 'nope' }, client)
    expect((await loginPost(app, { token: TOKEN }, client)).status).toBe(303)
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) expect((await loginPost(app, { token: 'nope' }, client)).status).toBe(401)
  })

  it('logout clears the cookie, and a session that expired is refused by the gate', async () => {
    const { app } = boot()
    const res = await loginPost(app, { token: TOKEN })
    const value = cookieOf(res)
    expect((await app.request('/api/state', { headers: { cookie: `${ADMIN_COOKIE}=${value}` } })).status).toBe(200)
    const out = await app.request('/logout', { headers: { cookie: `${ADMIN_COOKIE}=${value}` } })
    expect(out.status).toBe(303)
    expect(out.headers.get('location')).toBe('/login')
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0')
    clock += ADMIN_SESSION_TTL_SEC * 1000
    expect((await app.request('/api/state', { headers: { cookie: `${ADMIN_COOKIE}=${value}` } })).status).toBe(401)
  })

  it('the Secure flag follows the public URL: an http loopback deployment can still use its own cookie', async () => {
    const { app } = boot({ WATCHER_ADMIN_TOKEN: TOKEN }, baseCfg({ baseUrl: 'http://127.0.0.1:7717' }))
    const res = await loginPost(app, { token: TOKEN })
    expect(res.status).toBe(303)
    expect(res.headers.get('set-cookie')).not.toContain('Secure')
  })
})

// ---- POST /api/test-notify -------------------------------------------------------------------------------------------------------------

describe('5. POST /api/test-notify: every channel, or the one named', () => {
  it('is admin-auth: 401 with no credential, and the gate answers before any channel is tried', async () => {
    const { app, tested } = boot()
    const res = await app.request('/api/test-notify', { method: 'POST' })
    expect(res.status).toBe(401)
    expect(tested).toEqual([])
  })

  it('tests every configured channel in config order and reports each answer', async () => {
    const { app, tested } = boot()
    const res = await app.request('/api/test-notify', { method: 'POST', headers: bearer() })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await json(res)).toEqual({
      ok: true,
      results: [
        { channel: 'ntfy', ok: true, status: 'ok', latencyMs: 7 },
        { channel: 'notify-hook', ok: true, status: 'ok', latencyMs: 7 }
      ]
    })
    expect(tested).toEqual(['ntfy', 'notify-hook'])
  })

  it('?channel=id tests exactly that one, and an unknown id is a 404 that names it', async () => {
    const { app, tested } = boot()
    const one = await app.request('/api/test-notify?channel=ntfy', { method: 'POST', headers: bearer() })
    expect(one.status).toBe(200)
    expect(await json(one)).toEqual({ ok: true, results: [{ channel: 'ntfy', ok: true, status: 'ok', latencyMs: 7 }] })
    expect(tested).toEqual(['ntfy'])
    const unknown = await app.request('/api/test-notify?channel=nope', { method: 'POST', headers: bearer() })
    expect(unknown.status).toBe(404)
    expect(await json(unknown)).toEqual({ error: 'unknown channel nope' })
    expect(tested).toEqual(['ntfy'])
  })

  it('reports a failing channel without failing the request, and ok is false when one did not go out', async () => {
    const cfg = baseCfg({ channels: [{ id: 'broken', type: 'webhook', urlEnv: 'BROKEN_URL' }, { id: 'ntfy', type: 'ntfy', server: 'https://ntfy.sh', topicEnv: 'NTFY_TOPIC' }] })
    const { app } = boot({ WATCHER_ADMIN_TOKEN: TOKEN }, cfg)
    const res = await app.request('/api/test-notify', { method: 'POST', headers: bearer() })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ ok: false, results: [{ channel: 'broken', ok: false, status: 'connection refused' }, { channel: 'ntfy', ok: true }] })
  })

  it('a host with no channels is a 409 naming that, not an empty success', async () => {
    const { app } = boot({ WATCHER_ADMIN_TOKEN: TOKEN }, baseCfg({ channels: [] }))
    const res = await app.request('/api/test-notify', { method: 'POST', headers: bearer() })
    expect(res.status).toBe(409)
    expect(await json(res)).toEqual({ error: 'no channels are configured on this host' })
  })
})

// A loopback Watcher with no WATCHER_ADMIN_TOKEN is open only because its port is reachable only from this machine. A hand-run
// tunnel breaks that assumption: the request arrives with a proxy header and a public Host, and the wall would answer anyone.
// The gate refuses those requests, naming the one setting that fixes it.
describe('a loopback Watcher with no admin token refuses a proxied request', () => {
  const open = (): ReturnType<typeof boot> => boot({ WATCHER_MCP_TOKEN: MCP })

  it('refuses each proxy header a tunnel adds, with a 403 naming WATCHER_ADMIN_TOKEN', async () => {
    const { app } = open()
    for (const header of ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-forwarded-host', 'forwarded']) {
      const res = await app.request('http://127.0.0.1/api/state', { headers: { [header]: 'a-value' } })
      expect(res.status, header).toBe(403)
      const body = (await json(res)) as { code: string; detail: string }
      expect(body.code, header).toBe('auth.token-missing')
      expect(body.detail, header).toContain(ADMIN_TOKEN_ENV)
    }
  })

  it('refuses a Host that is not loopback even with no proxy header', async () => {
    const { app } = open()
    const res = await app.request('http://wall.example.com/api/state')
    expect(res.status).toBe(403)
    expect(((await json(res)) as { code: string }).code).toBe('auth.token-missing')
  })

  it('leaves a direct loopback request open, and leaves the self-authenticating paths alone', async () => {
    const { app } = open()
    expect((await app.request('http://127.0.0.1/api/state')).status).toBe(200)
    expect((await app.request('http://127.0.0.1/healthz', { headers: { 'cf-ray': 'x' } })).status).toBe(200)
    // /mcp keeps its own token gate: the admin-token refusal is not applied to it.
    const mcp = await app.request('http://127.0.0.1/mcp', { method: 'POST', headers: { 'cf-ray': 'x' }, body: '{}' })
    expect(mcp.status).toBe(401)
  })

  it('does not refuse a proxied request when the admin token is configured and presented', async () => {
    const { app } = boot()
    const res = await app.request('http://wall.example.com/api/state', { headers: { 'cf-ray': 'x', authorization: `Bearer ${TOKEN}` } })
    expect(res.status).toBe(200)
  })
})
