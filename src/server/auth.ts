// Admin authentication for the wall and /api: one shared token from WATCHER_ADMIN_TOKEN.
//
// A loopback bind (the default) without a token stays open, as it always was: the port is only reachable from this machine. A bind off
// loopback without a token is a server anyone on the network can read and act on, so main.ts refuses to start (this is auth, not a content
// check). With a token set:
//  - a browser signs in at GET /login, and POST /login sets an HttpOnly, SameSite=Lax cookie whose value is an HMAC of the token under the
//    acknowledge secret, never the token itself, with a 30 day expiry inside the MAC;
//  - an API client sends `Authorization: Bearer <token>`.
// Everything else keeps the auth it already had: /healthz and /api/instance are public, /ingest/* carries its per-source token (or a
// signed-webhook signature), /mcp carries WATCHER_MCP_TOKEN, and the signed ack and notice links carry their HMAC. main.ts logs which mode
// the process is in and never logs the token.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/** The env var that holds the admin token. Named in every error, because it is the one thing an operator has to set. */
export const ADMIN_TOKEN_ENV = 'WATCHER_ADMIN_TOKEN'

/** The session cookie. HttpOnly, SameSite=Lax and path-wide; Secure is added when the server's public URL is https. */
export const ADMIN_COOKIE = 'watcher_admin'

/** How long a signed-in browser stays signed in: 30 days, inside the cookie's own Max-Age and inside the MAC. */
export const ADMIN_SESSION_TTL_SEC = 30 * 24 * 60 * 60

/** The shortest token worth calling a credential (the same floor /mcp uses); main.ts warns under it, it never refuses a working one. */
export const ADMIN_TOKEN_MIN_CHARS = 32

const SESSION_LABEL = 'watcher-admin-session'
const SESSION_VERSION = 'v1'

/** The configured admin token, trimmed; '' when none is set. Trimming only drops the line ends an env file leaves behind. */
export function adminTokenOf(env: NodeJS.ProcessEnv): string {
  return (env[ADMIN_TOKEN_ENV] ?? '').trim()
}

/**
 * True for an address only this machine can reach: 127.0.0.0/8, ::1 (also written [::1] or 0:0:0:0:0:0:0:1) and localhost. Everything else,
 * including 0.0.0.0 and :: (every interface) and any LAN address or name, is off loopback and needs the token.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  return parts.every((n) => n <= 255) && parts[0] === 127
}

/**
 * What main.ts starts with: a loopback bind with no token is the open mode, and any other bind with no token is refused here, naming the env var.
 * A server that served the wall and /api to the network without a login is the defect this whole module exists to prevent.
 */
export function checkedAdminToken(host: string, token: string): string {
  if (token === '' && !isLoopbackHost(host)) {
    throw new Error(
      `${ADMIN_TOKEN_ENV} is not set and the server is bound to ${host}, which is not loopback: anyone who can reach the port would see the wall and could acknowledge, silence or park. ` +
        `Set ${ADMIN_TOKEN_ENV} to a long random string (openssl rand -hex 32), or bind WATCHER_HOST=127.0.0.1 for a machine-local wall.`
    )
  }
  return token
}

/** TRUE for a path that carries its own auth (or none by design), so the admin gate never asks it for a login. */
export function adminExemptPath(path: string): boolean {
  if (path === '/healthz' || path === '/mcp') return true
  // Which Watcher this is: the brand and the views it backs. The page the server serves carries the same object in a meta tag before a
  // login, the dev server's page asks here, and `watcher` uses it to tell this Watcher from whatever else holds the port. Nothing private.
  if (path === '/api/instance') return true
  if (path === '/login' || path === '/logout' || path === '/login.css' || path === '/login.js') return true
  if (path === '/api/ack') return true
  if (path === '/ingest' || path.startsWith('/ingest/')) return true
  // The signed links: /go/<HMAC of an incident key> and /a/<origin>:<fp8>. Both only redirect to a page, and the page itself asks for a login.
  return path.startsWith('/go/') || path.startsWith('/a/')
}

/** The headers a proxy or tunnel adds: any one of them means this request did not come from a browser on this machine. */
export const PROXY_HEADERS = ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-forwarded-host', 'forwarded'] as const

/** The first proxy header the request carries, or null. Used to refuse a tunneled request when no admin token is configured. */
export function proxyHeaderOf(headers: Headers): string | null {
  for (const name of PROXY_HEADERS) if (headers.get(name) !== null) return name
  return null
}

/**
 * A Host header that names this machine. The port is dropped first. A missing Host is treated as loopback: the check's job is
 * to catch a request a tunnel rewrote, and a tunnel always sets Host; a test client that omits it is not a tunnel.
 */
export function hostHeaderIsLoopback(host: string | undefined | null): boolean {
  if (typeof host !== 'string' || host.trim() === '') return true
  const name = host.trim().replace(/^\[/, '').replace(/\](?::\d+)?$/, '').replace(/:\d+$/, '')
  return isLoopbackHost(name)
}

/** The 403 a proxied request gets when the server has no admin token: the one thing an operator has to set to close the tunnel. */
export function proxyRefusal(headers: Headers, urlHost?: string): { status: 403; body: { error: string; code: string; detail: string } } | null {
  const via = proxyHeaderOf(headers)
  const host = headers.get('host') ?? urlHost
  if (via === null && hostHeaderIsLoopback(host)) return null
  return {
    status: 403,
    body: {
      error: 'admin token required',
      code: 'auth.token-missing',
      detail:
        `This request arrived through ${via ?? 'a hostname that is not loopback'} and no ${ADMIN_TOKEN_ENV} is set, so anyone the tunnel ` +
        `reaches could read the wall and act on it. Set ${ADMIN_TOKEN_ENV} in .watcher/.env (openssl rand -hex 32) and restart.`
    }
  }
}

/** The cookie value for a signed-in browser: the version, the expiry and an HMAC over both plus the token. The token is never in it. */
export function adminSessionValue(secret: string, token: string, nowMs: number): string {
  const expires = Math.floor(nowMs / 1000) + ADMIN_SESSION_TTL_SEC
  return `${SESSION_VERSION}.${expires}.${sessionMac(secret, token, expires)}`
}

function sessionMac(secret: string, token: string, expires: number): string {
  return createHmac('sha256', secret).update(`${SESSION_LABEL}:${expires}:${token}`).digest('base64url')
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** True when a cookie value was issued by this server for this token and has not expired. */
export function adminSessionValid(value: string | undefined, secret: string, token: string, nowMs: number): boolean {
  if (!value) return false
  const parts = value.split('.')
  if (parts.length !== 3 || parts[0] !== SESSION_VERSION || !/^\d{1,12}$/.test(parts[1])) return false
  const expires = Number(parts[1])
  if (expires * 1000 <= nowMs) return false
  return sameText(parts[2], sessionMac(secret, token, expires))
}

/** One cookie of a Cookie header, decoded only for the characters a cookie may hold; undefined when the header does not name it. */
export function cookieOf(header: string | undefined | null, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 1) continue
    if (part.slice(0, eq).trim() !== name) continue
    const value = part.slice(eq + 1).trim()
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return undefined
}

/** `Authorization: Bearer <token>` against the expected token, compared by SHA-256 digest so neither content nor length shows in the time. */
export function adminBearerOf(header: string | null | undefined): string | null {
  if (typeof header !== 'string') return null
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header)
  return m ? m[1] : null
}

export function adminBearerMatches(header: string | null | undefined, expected: string): boolean {
  if (expected === '') return false
  const got = adminBearerOf(header)
  return got !== null && adminTokenMatches(got, expected)
}

/** A submitted token against the configured one, compared by SHA-256 digest so neither content nor length shows in the time taken. */
export function adminTokenMatches(got: string, expected: string): boolean {
  if (expected === '' || got === '') return false
  const digest = (text: string): Buffer => createHash('sha256').update(text).digest()
  return timingSafeEqual(digest(got), digest(expected))
}

/** True when this request may see the wall and /api: no token configured (open), a matching Bearer, or a live session cookie. */
export function adminAuthorized(headers: Headers, secret: string, token: string, nowMs: number): boolean {
  if (token === '') return true
  if (adminBearerMatches(headers.get('authorization'), token)) return true
  return adminSessionValid(cookieOf(headers.get('cookie'), ADMIN_COOKIE), secret, token, nowMs)
}

/** The Set-Cookie value that signs a browser in. `secure` is true when the Watcher's public URL is https. */
export function adminSessionCookie(value: string, secure: boolean): string {
  return `${ADMIN_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ADMIN_SESSION_TTL_SEC}${secure ? '; Secure' : ''}`
}

/** The Set-Cookie value that signs a browser out: the same cookie, empty and already expired. */
export function adminClearCookie(secure: boolean): string {
  return `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
}

/**
 * A `next` a login may return to: a path on this server, never a scheme or a protocol-relative URL (//evil.example), so a crafted link cannot
 * send the browser somewhere else after the token is accepted. Anything else is the wall.
 */
export function safeNextPath(raw: string | undefined | null): string {
  if (typeof raw !== 'string') return '/'
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /[\r\n]/.test(raw)) return '/'
  return raw
}

/** How many failed logins one client may make inside the window before its answers are 429. */
export const LOGIN_MAX_FAILURES = 10
export const LOGIN_WINDOW_MS = 5 * 60_000

/**
 * A small in-memory brake on guessing the admin token: failures are counted per client address, a success clears them, and past
 * LOGIN_MAX_FAILURES inside LOGIN_WINDOW_MS the login answers 429 until the oldest has aged out. Restarting the server clears it; the token's
 * entropy is the real defence, this only stops an unbounded loop.
 */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>()
  private readonly now: () => number

  constructor(now: () => number) {
    this.now = now
  }

  /** True while this client has used up its attempts. Never changes the count. */
  blocked(client: string): boolean {
    return this.recent(client).length >= LOGIN_MAX_FAILURES
  }

  /** Seconds until this client may try again, at least 1; 0 when it is not blocked. */
  retryAfterSec(client: string): number {
    const recent = this.recent(client)
    if (recent.length < LOGIN_MAX_FAILURES) return 0
    const oldest = recent[recent.length - LOGIN_MAX_FAILURES]
    return Math.max(1, Math.ceil((oldest + LOGIN_WINDOW_MS - this.now()) / 1000))
  }

  fail(client: string): void {
    const recent = this.recent(client)
    recent.push(this.now())
    this.failures.set(client, recent)
  }

  clear(client: string): void {
    this.failures.delete(client)
  }

  private recent(client: string): number[] {
    const cutoff = this.now() - LOGIN_WINDOW_MS
    const kept = (this.failures.get(client) ?? []).filter((at) => at > cutoff)
    if (kept.length === 0) this.failures.delete(client)
    else this.failures.set(client, kept)
    return kept
  }
}

/**
 * The client address a login is counted against: the first hop of X-Forwarded-For when a reverse proxy sets it, else X-Real-IP, else one shared
 * name (a direct client's address is not exposed to the app by @hono/node-server, and a shared bucket is enough for a brake).
 */
export function loginClientOf(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (forwarded) return forwarded
  return headers.get('x-real-ip')?.trim() || 'direct'
}

// ---- the sign-in page ----------------------------------------------------------------------------------------------------------------

/**
 * The one script the page runs: the wall's deep links are hash routes (`/#/i/<incident>`), and a fragment never reaches the server, so `next`
 * cannot carry it. On submit it is appended to the hidden field, and the POST sees the whole path. No other behaviour, and the field is escaped.
 */
export const LOGIN_JS = `const form = document.querySelector('form')
const next = form && form.querySelector('input[name="next"]')
if (form && next && location.hash) next.value += location.hash
`

/**
 * The page is served by this process and cannot use the built app's hashed stylesheet, so its CSS is its own tiny file (/login.css). Every value
 * is copied from src/web/styles/tokens.css and named here: the neutrals (light and dark), the display, title and body type steps, the 4 px spacing
 * scale (8, 12, 16, 24, 32, 48), the two radii, the 44 px target, the 1 px hairline, the 2 px focus ring, the 150 ms duration and the two state
 * overlays. No script in the page body, no inline style, so the wall's Content-Security-Policy applies unchanged. The card is the one bold element:
 * a single raised sheet on the bare canvas, a hairline and no shadow, with the product's own name above the one field.
 */
export const LOGIN_CSS = `:root {
  color-scheme: light dark;
  --bg: light-dark(#faf8f3, #0d0d0d);
  --raised: light-dark(#f0ede5, #1a1a1c);
  --line: light-dark(#e3dfd6, #1e1e21);
  --line-strong: light-dark(#8a8780, #3a3b40);
  --fg: light-dark(#141310, #e6e8ee);
  --muted: light-dark(#5f5b52, #aeb1bc);
  --danger: light-dark(#a84f4f, #f23f42);
  --font-ui: SF Pro Rounded, ui-rounded, Inter, system-ui, sans-serif;
  --font-mono: ui-monospace, SF Mono, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace;
  --radius-8: 8px;
  --radius-16: 16px;
  --target: 44px;
  --hairline: 1px;
  --ring: 2px;
  --focus-offset: 2px;
  --duration-150: 150ms;
  /* the state-layer opacities: hover 0.06 and press 0.14, from the tokens file */
  --overlay-hover: 0.06;
  --overlay-press: 0.14;
  /* 48px (--spacing-48) x 8: a sign-in card one column wide */
  --card-max: calc(48px * 8);
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 400 13px/19px var(--font-ui);
  -webkit-font-smoothing: antialiased;
}
.shell { min-height: 100dvh; display: grid; place-items: center; padding: 24px; }
.card {
  width: 100%;
  max-width: var(--card-max);
  padding: 32px;
  background: var(--raised);
  border: var(--hairline) solid var(--line);
  border-radius: var(--radius-16);
}
.mark { margin: 0 0 32px; font: 600 15px/20px var(--font-ui); }
h1 { margin: 0; font: 600 32px/36px var(--font-ui); letter-spacing: -0.85px; text-wrap: balance; }
.lede { margin: 8px 0 32px; color: var(--muted); text-wrap: pretty; }
label { display: block; margin: 0 0 8px; font: 500 13px/19px var(--font-ui); color: var(--muted); }
input[type='password'] {
  width: 100%;
  min-height: var(--target);
  padding: 0 12px;
  background: var(--bg);
  color: var(--fg);
  border: var(--hairline) solid var(--line-strong);
  border-radius: var(--radius-8);
  font: 400 16px/19px var(--font-mono);
}
input:focus-visible, button:focus-visible { outline: var(--ring) solid var(--fg); outline-offset: var(--focus-offset); }
button {
  width: 100%;
  min-height: var(--target);
  margin-top: 16px;
  border: 0;
  border-radius: var(--radius-8);
  background: var(--fg);
  color: var(--bg);
  font: 600 15px/20px var(--font-ui);
  cursor: pointer;
  transition: background-color var(--duration-150) ease;
}
button:hover { background: color-mix(in srgb, var(--fg) calc(100% - var(--overlay-hover) * 100%), var(--bg)); }
button:active { background: color-mix(in srgb, var(--fg) calc(100% - var(--overlay-press) * 100%), var(--bg)); }
.error { margin: 16px 0 0; color: var(--danger); font: 500 13px/19px var(--font-ui); text-wrap: pretty; }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
`

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** The sign-in form. `error` is shown above the button and is always one of this module's own sentences, never input. */
export function loginPage(brand: string, next: string, error?: string): string {
  const name = escapeHtml(brand)
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="robots" content="noindex" />
    <title>Sign in - ${name}</title>
    <meta name="theme-color" content="#0d0d0d" media="(prefers-color-scheme: dark)" />
    <meta name="theme-color" content="#faf8f3" media="(prefers-color-scheme: light)" />
    <link rel="stylesheet" href="/login.css" />
    <script src="/login.js" defer></script>
  </head>
  <body>
    <main class="shell">
      <section class="card" aria-labelledby="title">
        <p class="mark">${name}</p>
        <h1 id="title">Sign in</h1>
        <p class="lede">The wall is protected.</p>
        <form method="post" action="/login">
          <label for="token">Admin token</label>
          <input id="token" name="token" type="password" autocomplete="current-password" required autofocus spellcheck="false" />
          <input type="hidden" name="next" value="${escapeHtml(next)}" />
          ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
          <button type="submit">Open the wall</button>
        </form>
      </section>
    </main>
  </body>
</html>
`
}
