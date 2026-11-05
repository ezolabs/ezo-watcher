// The deterministic half of telemetry discovery, ported from an earlier prototype scanner
// (480 lines, 0.9 s on a 77k-file repo, 15 of 19 hand-labelled HTTP/TLS points on a
// four-repo sample) with every defect that prototype showed fixed:
//
//   - walk order: files before subdirectories, directory priority, and a `capHit` fact (a huge
//     data/ directory must not starve package.json);
//   - quoted JSON keys (`"baseUrl":`), which the first scanner could not see;
//   - scope-ranked dedupe: a test fixture never shadows the production config that names the same
//     target (*.test.*, test_*.py, fixtures and dev configs rank below production);
//   - port inference only from the three trustworthy reads: an env PORT default, `.listen(n)`, and
//     a compose `ports:` mapping. A `port: 443` object field is never a listener;
//   - the nginx/compose join: a vhost whose proxy_pass port equals the port a health path is served
//     on becomes one public target (URL + path), not two guesses;
//   - one ingest dispatcher collapses to one webhook proposal, never one per route;
//   - silence candidates (launchd, systemd timers, crontab, GitHub schedules, vercel/wrangler crons,
//     k8s CronJob, staleAfterSec-like keys) become heartbeat suggestions;
//   - a health handler that returns a LITERAL ({ok:true}, {status:'ok'}) is marked
//     `assertion: 'liveness-only'` and gets a suggestion to assert a dependency-gated path;
//   - `.env*` files are read for KEY NAMES ONLY: a value never leaves the file.
//
// It proposes; it never writes. `watcher add` is the write.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
import { slugify } from '../util.ts'
import { durationOfSeconds } from '../add.ts'
import { walkProject } from './walk.ts'

export type Confidence = 'high' | 'medium' | 'low'
export type Need = 'none' | 'credential' | 'judgment'

export interface Evidence {
  file: string
  line: number
}

export interface ScanSignal {
  id: string
  /** The Watcher source kind this signal suggests. */
  kind: string
  evidence: Evidence[]
  suggests: { kind: string; args: Record<string, unknown> }
  confidence: Confidence
  needs: Need
  /** Present when the discovered handler answers a constant: the probe would prove liveness only. */
  assertion?: 'liveness-only'
  /** One line for a human; the JSON keeps it too (the brief fixes the required fields, not their ceiling). */
  note?: string
}

export interface ScanFacts {
  fileCount: number
  capHit: boolean
  depthHit: boolean
  manifests: Array<{ file: string; name: string | null; scripts: string[] }>
  lockfiles: string[]
  deps: Array<{ dep: string; file: string }>
  envKeys: Array<{ key: string; file: string; line: number }>
  listeners: Array<{ port: number; file: string; line: number; scope: string; how: string }>
  healthRoutes: Array<{ path: string; file: string; line: number; scope: string; okJson: boolean }>
  webhookRoutes: Array<{ path: string; file: string; line: number; scope: string }>
  composeServices: Array<{ name: string; file: string; line: number; ports: Array<{ hostPort: number; containerPort: number }> }>
  dockerfiles: Array<{ file: string; expose: number | null }>
  schedules: Array<{ kind: string; file: string; line: number; detail: string }>
  publicHosts: Array<{ host: string; file: string; line: number; how: string }>
  platformConfigs: Array<{ file: string; kind: string; detail: string }>
  k8s: Array<{ file: string; line: number; path?: string; port?: number; tcp?: boolean; grpc?: boolean; cronjob?: string }>
  staleWindows: Array<{ file: string; line: number; key: string; seconds: number }>
  notes: Array<{ file: string; what: string }>
}

export interface ScanResult {
  project: string
  facts: ScanFacts
  signals: ScanSignal[]
  suggestedCommands: string[]
}

const MAX_BYTES = 512 * 1024
const MAX_FACT_ROWS = 300
const TEST_DIR = /(^|\/)(test|tests|__tests__|spec|fixtures|e2e)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|(^|\/)[^/]*_test\.(py|go)$/
const SRC_EXT = /\.(ts|tsx|mts|js|mjs|cjs|jsx|py|go|rb|rs|php)$/
const COMPOSE = /(^|\/)(docker-)?compose(\.\w+)?\.ya?ml$/
const ENVFILE = /(^|\/)(\.env(\.[\w.-]+)?|[^/]*\.env(\.template|\.example|\.sample)?|env\.example)$/
const MANIFESTS = new Set(['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Gemfile', 'composer.json'])
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'npm-shrinkwrap.json', 'poetry.lock', 'Pipfile.lock', 'Cargo.lock', 'go.sum', 'Gemfile.lock', 'composer.lock'])

const HEALTH_LIT = /(['"`])(\/(?:api\/)?(?:healthz?|health\/(?:live|ready|readiness|liveness)|readyz|livez|v1\/health|_health))(?:\1)/i
const ROUTE_LINE = /(app\.(get|post|put|patch|all)\(|\.route\(|\broute\(|HandleFunc|mux\.Handle|@app\.(route|get)|do_GET|do_POST|pathname\s*[=!]==|case\s+['"]\/|@(Get|Post)Mapping)/
const WEBHOOK_ROUTE = /(['"`])(\/[^'"` ]{2,80})\1/
// Only the three reads the #10 proof found trustworthy: a PORT env read with a default, an
// explicit `.listen(n)`, and a compose `ports:` mapping (handled in the compose pass). A bare
// `port: 443` object field or a `--port` example is not a listener.
const PORT_PATTERNS: Array<{ re: RegExp; how: string }> = [
  { re: /process\.env\.\w*PORT\w*\s*(?:\?\?|\|\|)\s*['"]?(\d{2,5})['"]?/, how: 'process.env PORT default' },
  { re: /\.listen\(\s*(\d{2,5})\s*[,)]/, how: '.listen(n)' },
  { re: /env\.get\(\s*["']([A-Z_]*PORT[A-Z_]*)["']\s*,\s*["'](\d{2,5})["']/, how: 'env.get PORT default' }
]
const URL_KEY = /\b(baseUrl|publicUrl|PUBLIC_URL|APP_URL|BASE_URL|NEXTAUTH_URL|WATCH_URL|SITE_URL|CANONICAL_URL|HEALTH_URL|HEALTHCHECK_URL)["']?\s*[:=]\s*["']?(https?:\/\/[^\s"',`\)\\]+)/g
const URL_KEY_RE = new RegExp(URL_KEY.source, 'g')
const DEV_DIR = /(^|\/)(dev|fixtures?|stories?)\//
const DEV_FILE = /([.\/-])(dev|fixture|story)[.-](m?[jt]sx?|py|json|ya?ml|toml)$|-(dev|fixture|story)-/
const DATA_FILE = /(^|\/)(reports?|data|samples?|logs?)\//

const SCOPE_RANK: Record<string, number> = { prod: 0, dev: 1, docs: 2, test: 3 }

function scopeOf(rel: string): 'prod' | 'dev' | 'docs' | 'test' {
  if (TEST_DIR.test(rel)) return 'test'
  if (/(^|\/)(docs?|examples?)\//.test(rel)) return 'docs'
  if (DEV_DIR.test(rel) || DEV_FILE.test(basename(rel))) return 'dev'
  return 'prod'
}

function srcRank(file: string): number {
  return /^(src|server|app|lib|internal|cmd)\//.test(file) ? 0 : /^(scripts|tools|bin)\//.test(file) ? 2 : 1
}

/** Quote one shell argument. */
export function quoteArg(value: string): string {
  return /^[A-Za-z0-9_./:=@%+,~-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/** Build the `watcher add …` line for a proposal. */
export function commandFor(kind: string, args: Record<string, unknown>): string {
  const parts = ['watcher', 'add', kind]
  const push = (flag: string, value: unknown): void => {
    if (value === undefined || value === null || value === '') return
    parts.push(`--${flag}`, quoteArg(typeof value === 'string' ? value : typeof value === 'number' ? String(value) : JSON.stringify(value)))
  }
  push('id', args.id)
  if (args.service !== undefined) push('service', args.service)
  const order = ['url', 'host', 'port', 'expect-json', 'expect-status', 'every', 'schedule', 'timezone', 'grace', 'name', 'token-env', 'stale-after-sec', 'poll-sec']
  for (const key of order) push(key, args[key])
  return parts.join(' ')
}

export function scanProject(root: string, opts: { maxFiles?: number } = {}): ScanResult {
  const walk = walkProject(root, { maxFiles: opts.maxFiles ?? 4000 })
  const files = walk.files
  const cache = new Map<string, string>()
  const text = (rel: string): string => {
    const hit = cache.get(rel)
    if (hit !== undefined) return hit
    let out = ''
    try {
      const st = statSync(join(root, rel))
      out = st.size <= MAX_BYTES ? readFileSync(join(root, rel), 'utf8') : readFileSync(join(root, rel), 'utf8').slice(0, MAX_BYTES)
    } catch {
      out = ''
    }
    cache.set(rel, out)
    return out
  }
  const lines = (rel: string): string[] => text(rel).split('\n')
  const lineOf = (rel: string, needle: string): number => {
    const ls = lines(rel)
    const i = ls.findIndex((l) => l.includes(needle))
    return i < 0 ? 0 : i + 1
  }

  const facts: ScanFacts = {
    fileCount: files.length,
    capHit: walk.capHit,
    depthHit: walk.depthHit,
    manifests: [],
    lockfiles: [],
    deps: [],
    envKeys: [],
    listeners: [],
    healthRoutes: [],
    webhookRoutes: [],
    composeServices: [],
    dockerfiles: [],
    schedules: [],
    publicHosts: [],
    platformConfigs: [],
    k8s: [],
    staleWindows: [],
    notes: []
  }
  const signals: ScanSignal[] = []
  const byKey = new Map<string, ScanSignal>()
  let counter = 0

  const propose = (input: {
    key: string
    kind: string
    evidence: Evidence[]
    suggests: { kind: string; args: Record<string, unknown> }
    confidence: Confidence
    needs: Need
    assertion?: 'liveness-only'
    note?: string
  }): void => {
    // A signal whose only evidence is a test or a doc is not a production target: it is listed at
    // low confidence and needs judgement, so it never becomes a runnable `watcher add` on its own.
    const scope = input.evidence.reduce((worst, e) => (SCOPE_RANK[scopeOf(e.file)] > SCOPE_RANK[worst] ? scopeOf(e.file) : worst), 'prod' as 'prod' | 'dev' | 'docs' | 'test')
    const best = input.evidence.reduce((bestSoFar, e) => (SCOPE_RANK[scopeOf(e.file)] < SCOPE_RANK[bestSoFar] ? scopeOf(e.file) : bestSoFar), 'test' as 'prod' | 'dev' | 'docs' | 'test')
    let confidence = input.confidence
    let needs = input.needs
    let noteText = input.note
    if (best === 'test' || best === 'docs') {
      confidence = 'low'
      needs = 'judgment'
      noteText = `${noteText ?? ''}${noteText ? ' ' : ''}(evidence is in ${best} files only; verify it is a production target)`
    } else if (best === 'dev' && confidence === 'high') {
      confidence = 'medium'
    }
    const existing = byKey.get(input.key)
    if (existing) {
      // A test fixture must never shadow the production config that names the same target.
      const existingScope = existing.evidence.reduce((worst, e) => (SCOPE_RANK[scopeOf(e.file)] > SCOPE_RANK[worst] ? scopeOf(e.file) : worst), 'prod' as 'prod' | 'dev' | 'docs' | 'test')
      if (SCOPE_RANK[scope] < SCOPE_RANK[existingScope]) {
        existing.evidence = input.evidence
        existing.confidence = confidence
        existing.needs = needs
        existing.suggests = input.suggests
        existing.note = noteText
      }
      return
    }
    counter += 1
    const signal: ScanSignal = {
      id: `signal-${String(counter).padStart(3, '0')}`,
      kind: input.kind,
      evidence: input.evidence,
      suggests: input.suggests,
      confidence,
      needs,
      ...(input.assertion ? { assertion: input.assertion } : {}),
      ...(noteText ? { note: noteText } : {})
    }
    signals.push(signal)
    byKey.set(input.key, signal)
  }
  const note = (file: string, what: string): void => {
    if (facts.notes.length < MAX_FACT_ROWS) facts.notes.push({ file, what })
  }

  // ---- 1. manifests, lockfiles, dependencies --------------------------------------------------------
  for (const f of files) {
    const base = basename(f)
    if (LOCKFILES.has(base) && facts.lockfiles.length < MAX_FACT_ROWS) facts.lockfiles.push(f)
    if (!MANIFESTS.has(base) || f.split(sep).length > 4) continue
    if (base === 'package.json') {
      try {
        const j = JSON.parse(text(f)) as { name?: string; scripts?: Record<string, unknown>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
        const deps = { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) }
        if (facts.manifests.length < MAX_FACT_ROWS) facts.manifests.push({ file: f, name: j.name ?? null, scripts: Object.keys(j.scripts ?? {}) })
        for (const dep of Object.keys(deps)) if (facts.deps.length < MAX_FACT_ROWS) facts.deps.push({ dep, file: f })
      } catch {
        note(f, 'package.json is not valid JSON')
      }
    } else {
      if (facts.manifests.length < MAX_FACT_ROWS) facts.manifests.push({ file: f, name: null, scripts: [] })
      for (const l of lines(f)) {
        const m = l.match(/^\s*"?([a-zA-Z][\w.-]*)"?\s*(?:[=<>~!]{1,2}|\s)\s*["']?[\d^~*]/)
        if (m && facts.deps.length < MAX_FACT_ROWS) facts.deps.push({ dep: m[1].toLowerCase(), file: f })
      }
    }
  }
  const depSet = new Set(facts.deps.map((d) => d.dep))
  const hasDep = (re: RegExp): boolean => [...depSet].some((d) => re.test(d))
  const depEvidence = (re: RegExp): Evidence | null => {
    const d = facts.deps.find((x) => re.test(x.dep))
    return d ? { file: d.file, line: lineOf(d.file, `"${d.dep}"`) } : null
  }
  const DEPS = {
    httpApp: /^(hono|express|fastify|koa|next|@hono\/node-server|nitro|flask|fastapi|django|starlette|axum|actix-web|rocket|warp|sinatra|rails)$/,
    db: /^(prisma|@prisma\/client|pg|postgres|mysql2|mysql|mongoose|mongodb|better-sqlite3|sequelize|knex|drizzle-orm|clickhouse|@clickhouse\/client)$/,
    redis: /^(redis|ioredis|bullmq|@upstash\/redis|bee-queue)$/,
    sentry: /^(@sentry\/|sentry-sdk)/,
    stripe: /^stripe$/
  }

  // ---- 2. env files: KEY NAMES ONLY ----------------------------------------------------------------
  for (const f of files) {
    if (!ENVFILE.test(f) || /\.env\.example$|\.env\.template$/.test(f) === false && /(^|\/)\.env(\.[\w.-]+)?$/.test(f) === false) {
      // still allow *.env.example / env.example through the filter below
    }
    if (!ENVFILE.test(f)) continue
    for (const [i, l] of lines(f).entries()) {
      const m = l.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=/)
      if (!m) continue
      if (facts.envKeys.length < MAX_FACT_ROWS) facts.envKeys.push({ key: m[1], file: f, line: i + 1 })
    }
  }
  const envKeySet = new Set(facts.envKeys.map((e) => e.key))
  const envEvidence = (re: RegExp): Evidence | null => {
    const e = facts.envKeys.find((x) => re.test(x.key))
    return e ? { file: e.file, line: e.line } : null
  }

  // ---- 3. source: listeners, health routes, webhook routes ------------------------------------------
  for (const f of files) {
    if (!SRC_EXT.test(f)) continue
    const ls = lines(f)
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i]
      const h = HEALTH_LIT.exec(l)
      if (h && (ROUTE_LINE.test(l) || ROUTE_LINE.test(ls[i + 1] ?? '') || ROUTE_LINE.test(ls[i - 1] ?? ''))) {
        const body = ls.slice(i, i + 6).join(' ')
        const okJson = /\bok\b\s*:\s*true|["']ok["']\s*:\s*true|\bstatus\b\s*:\s*["']ok["']/.test(body)
        if (facts.healthRoutes.length < MAX_FACT_ROWS) facts.healthRoutes.push({ path: h[2], file: f, line: i + 1, scope: scopeOf(f), okJson })
      }
      if (/\b(webhook|ingest|alert)/i.test(l) && ROUTE_LINE.test(l)) {
        const m = WEBHOOK_ROUTE.exec(l)
        if (m && /(webhook|ingest|alert)/i.test(m[2]) && facts.webhookRoutes.length < MAX_FACT_ROWS) {
          facts.webhookRoutes.push({ path: m[2], file: f, line: i + 1, scope: scopeOf(f) })
        }
      }
      for (const p of PORT_PATTERNS) {
        const m = p.re.exec(l)
        if (!m) continue
        const captured = m[2] !== undefined && /^\d{2,5}$/.test(m[2]) ? m[2] : m[1]
        const port = Number(captured)
        if (!Number.isInteger(port) || port < 1 || port > 65535) break
        if (facts.listeners.length < MAX_FACT_ROWS) facts.listeners.push({ port, file: f, line: i + 1, scope: scopeOf(f), how: p.how })
        break
      }
    }
  }
  // Next's file-based API routes: a file named health/healthz/ping under pages/api or app/api IS
  // the route, and its handler's literal is readable. Deterministic, and the framework's own map.
  for (const f of files) {
    const m = /(^|\/)(?:pages|app)\/api\/([^/]+)(?:\/route)?\.(ts|tsx|js|jsx)$/.exec(f)
    if (!m || !/^(health|healthz|ping|status)$/i.test(m[2])) continue
    const body = text(f)
    const okJson = /\bok\b\s*:\s*true|["']ok["']\s*:\s*true|\bstatus\b\s*:\s*["']ok["']/.test(body)
    if (facts.healthRoutes.length < MAX_FACT_ROWS) facts.healthRoutes.push({ path: `/api/${m[2]}`, file: f, line: 1, scope: scopeOf(f), okJson })
  }
  const prodListeners = [...new Map(facts.listeners.filter((l) => l.scope === 'prod').map((l) => [l.port, l])).values()]

  // ---- 4. compose ----------------------------------------------------------------------------------
  const composeHealth: Array<{ port: number; path: string; file: string; line: number; service: string }> = []
  for (const f of files) {
    if (!COMPOSE.test(f)) continue
    const ls = lines(f)
    let current: { name: string; file: string; line: number; ports: Array<{ hostPort: number; containerPort: number }> } | null = null
    let inHealth = false
    let inPorts = false
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i]
      const sm = /^ {2}([a-zA-Z0-9_.-]+):\s*$/.exec(l)
      if (sm && !/^(services|volumes|networks|x-)/.test(sm[1])) {
        current = { name: sm[1], file: f, line: i + 1, ports: [] }
        if (facts.composeServices.length < MAX_FACT_ROWS) facts.composeServices.push(current)
        inHealth = false
        inPorts = false
        continue
      }
      if (!current) continue
      if (/^\s{4}healthcheck:/.test(l)) {
        inHealth = true
        continue
      }
      if (/^\s{4}\w/.test(l)) inHealth = false
      if (/^\s{4}ports:/.test(l)) {
        inPorts = true
        continue
      }
      if (/^\s{4}\w/.test(l) && !/^\s{4}ports:/.test(l)) inPorts = false
      const pm = /^\s+-\s*["']?(?:[\d.]+:)?(\d{2,5}):(\d{2,5})["']?/.exec(l)
      if (inPorts && pm) current.ports.push({ hostPort: Number(pm[1]), containerPort: Number(pm[2]) })
      const url = /https?:\/\/[^\s"'`,)\]]+/.exec(l)
      if (url && (inHealth || /health|test:/.test(l))) {
        try {
          const u = new URL(url[0])
          if (u.port) composeHealth.push({ port: Number(u.port), path: u.pathname, file: f, line: i + 1, service: current.name })
        } catch {
          // not a URL after all
        }
      }
      if (/network_mode:\s*["']?host/.test(l)) note(f, `service ${current.name} uses host networking: loopback URLs are the host's`)
    }
  }
  for (const s of facts.composeServices) {
    for (const p of s.ports) {
      propose({
        key: `compose.ports|${p.hostPort}`,
        kind: 'http-probe',
        evidence: [{ file: s.file, line: s.line }],
        suggests: { kind: 'http-probe', args: { id: slugify(`${s.name}-port-${p.hostPort}`), service: s.name, url: `http://127.0.0.1:${p.hostPort}/` } },
        confidence: 'low',
        needs: 'judgment',
        note: `published port ${p.hostPort} of compose service ${s.name}; the path is unknown, so this is a bare-200 probe until you name a health route`
      })
    }
  }
  for (const h of composeHealth) {
    propose({
      key: `compose.healthcheck|${h.port}${h.path}`,
      kind: 'http-probe',
      evidence: [{ file: h.file, line: h.line }],
      suggests: { kind: 'http-probe', args: { id: slugify(`${h.service}-health`), service: h.service, url: `http://127.0.0.1:${h.port}${h.path}` } },
      confidence: 'high',
      needs: 'none',
      note: `compose service ${h.service} already declares this as its health URL`
    })
  }

  // ---- 5. Dockerfile -------------------------------------------------------------------------------
  for (const f of files) {
    if (!/(^|\/)Dockerfile[^/]*$/.test(f)) continue
    const ls = lines(f)
    let expose: number | null = null
    for (let i = 0; i < ls.length; i++) {
      const e = /^\s*EXPOSE\s+(\d{2,5})/.exec(ls[i])
      if (e) expose = Number(e[1])
      if (!/^\s*HEALTHCHECK/.test(ls[i])) continue
      const block = ls.slice(i, i + 4).join(' ')
      const url = /https?:\/\/[^\s"'`]+/.exec(block)
      facts.dockerfiles.push({ file: f, expose })
      if (url) {
        propose({
          key: `dockerfile.healthcheck|${url[0]}`,
          kind: 'http-probe',
          evidence: [{ file: f, line: i + 1 }],
          suggests: { kind: 'http-probe', args: { id: slugify(`${basename(f)}-health`), service: 'app', url: url[0] } },
          confidence: 'high',
          needs: 'none',
          note: 'path and port lifted from the Dockerfile HEALTHCHECK'
        })
      } else {
        propose({
          key: `dockerfile.healthcheck|${f}`,
          kind: 'http-probe',
          evidence: [{ file: f, line: i + 1 }],
          suggests: { kind: 'http-probe', args: { id: slugify(`${basename(f)}-health`), service: 'app', ...(expose ? { url: `http://127.0.0.1:${expose}/` } : {}) } },
          confidence: 'low',
          needs: 'judgment',
          note: 'HEALTHCHECK has no URL (it runs a script); the agent must read it and name the route'
        })
      }
    }
    if (!facts.dockerfiles.some((d) => d.file === f)) facts.dockerfiles.push({ file: f, expose })
  }

  // ---- 6. nginx: public hostnames and the proxy_pass port ------------------------------------------
  const nginxProxies: Array<{ host: string; port: number; file: string; line: number }> = []
  for (const f of files) {
    if (!/\.conf$/.test(f) || !/nginx|location|server_name/.test(text(f))) continue
    const ls = lines(f)
    let hosts: string[] = []
    for (let i = 0; i < ls.length; i++) {
      if (/^\s*server\s*\{/.test(ls[i])) hosts = []
      const pp = /proxy_pass\s+https?:\/\/[^:\s]+:(\d{2,5})/.exec(ls[i])
      if (pp) for (const h of hosts) nginxProxies.push({ host: h, port: Number(pp[1]), file: f, line: i + 1 })
      const m = /^\s*server_name\s+([^;]+);/.exec(ls[i])
      if (!m) continue
      hosts = m[1].trim().split(/\s+/).filter((h) => h && !/^[_~.]/.test(h) && h !== 'localhost')
      for (const host of hosts) {
        if (facts.publicHosts.length < MAX_FACT_ROWS) facts.publicHosts.push({ host, file: f, line: i + 1, how: 'nginx.server_name' })
        propose({
          key: `nginx.server_name|${host}`,
          kind: 'http-probe',
          evidence: [{ file: f, line: i + 1 }],
          suggests: { kind: 'http-probe', args: { id: slugify(host), service: slugify(host.split('.')[0]), url: `https://${host}/` } },
          confidence: 'high',
          needs: 'none',
          note: 'TLS and HTTP liveness for a vhost this repo publishes'
        })
      }
    }
  }

  // ---- 7. config URLs (never from .env: values stay in the file) ------------------------------------
  for (const f of files) {
    if (ENVFILE.test(f)) continue
    if (!/\.(json|ya?ml|toml|ts|js|mjs|py|template)$/.test(f)) continue
    if (DATA_FILE.test(f) && /\.json$/.test(f)) continue
    const ls = lines(f)
    for (let i = 0; i < ls.length; i++) {
      URL_KEY_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = URL_KEY_RE.exec(ls[i])) !== null) {
        let u: URL
        try {
          u = new URL(m[2])
        } catch {
          continue
        }
        const loopback = /^(127\.|localhost$|0\.0\.0\.0$|\[::1\])/.test(u.hostname)
        const label = m[1]
        if (loopback) {
          propose({
            key: `config.url|${u.toString()}`,
            kind: 'http-probe',
            evidence: [{ file: f, line: i + 1 }],
            suggests: { kind: 'http-probe', args: { id: slugify(u.port ? `local-${u.port}` : 'local-app'), service: 'app', url: u.toString() } },
            confidence: 'medium',
            needs: 'none',
            note: `loopback dependency from ${label}`
          })
        } else {
          if (facts.publicHosts.length < MAX_FACT_ROWS) facts.publicHosts.push({ host: u.hostname, file: f, line: i + 1, how: label })
          propose({
            key: `config.url|https://${u.hostname}`,
            kind: 'http-probe',
            evidence: [{ file: f, line: i + 1 }],
            suggests: { kind: 'http-probe', args: { id: slugify(u.hostname), service: slugify(u.hostname.split('.')[0]), url: `https://${u.hostname}${u.pathname === '/' ? '/' : u.pathname}` } },
            confidence: 'high',
            needs: 'none',
            note: `public base URL from ${label}: certificate expiry and liveness`
          })
        }
      }
    }
  }

  // The public join also stands without a health route in source: a vhost whose proxy_pass port is
  // the port a compose healthcheck names serves that path publicly.
  for (const h of composeHealth) {
    for (const np of nginxProxies) {
      if (np.port !== h.port) continue
      propose({
        key: `join.nginx+compose|${np.host}${h.path}`,
        kind: 'http-probe',
        evidence: [{ file: np.file, line: np.line }, { file: h.file, line: h.line }],
        suggests: { kind: 'http-probe', args: { id: slugify(`${np.host}${h.path.replace(/\//g, '-')}`), service: 'app', url: `https://${np.host}${h.path}` } },
        confidence: 'high',
        needs: 'none',
        note: 'the vhost proxy port and the compose healthcheck port are the same: this is the public health URL'
      })
    }
  }

  // ---- 8. schedules: launchd, systemd, crontab, GitHub, vercel, wrangler, k8s ----------------------
  for (const f of files) {
    const base = basename(f)
    if (/\.plist$/.test(f)) {
      const s = text(f)
      const label = (/<key>Label<\/key>\s*<string>([^<]+)/.exec(s) ?? [])[1] ?? base
      const interval = (/<key>StartInterval<\/key>\s*<integer>(\d+)/.exec(s) ?? [])[1]
      const calendar = /<key>StartCalendarInterval<\/key>/.test(s)
      const keepAlive = /<key>KeepAlive<\/key>/.test(s)
      if (interval || calendar || keepAlive) {
        facts.schedules.push({ kind: 'launchd', file: f, line: lineOf(f, interval ? 'StartInterval' : calendar ? 'StartCalendarInterval' : 'KeepAlive'), detail: label })
        propose({
          key: `launchd|${label}`,
          kind: 'heartbeat',
          evidence: [{ file: f, line: lineOf(f, interval ? 'StartInterval' : calendar ? 'StartCalendarInterval' : 'KeepAlive') }],
          suggests: { kind: 'heartbeat', args: { id: slugify(label), every: durationOfSeconds(interval ? Number(interval) : 86_400), grace: durationOfSeconds(interval ? Math.max(60, Math.round(Number(interval) / 3)) : 3600) } },
          confidence: 'high',
          needs: 'none',
          note: `launchd job ${label}${interval ? ` every ${interval}s` : calendar ? ' on a calendar' : ' (KeepAlive)'}: silence is invisible without a heartbeat`
        })
      }
    }
    if (/\.timer$/.test(f)) {
      const oc = (/OnCalendar=([^\n]+)/.exec(text(f)) ?? [])[1]
      if (oc) {
        facts.schedules.push({ kind: 'systemd-timer', file: f, line: lineOf(f, 'OnCalendar'), detail: oc.trim() })
        propose({
          key: `systemd.timer|${base}`,
          kind: 'heartbeat',
          evidence: [{ file: f, line: lineOf(f, 'OnCalendar') }],
          suggests: { kind: 'heartbeat', args: { id: slugify(base.replace(/\.timer$/, '')), every: '24h', grace: '1h' } },
          confidence: 'high',
          needs: 'judgment',
          note: `systemd timer OnCalendar=${oc.trim()}; the agent must turn the calendar into a sensible every/grace`
        })
      }
    }
    if (/(^|\.)crontab$|\.cron$|\.crontab$/.test(base)) {
      for (const [i, l] of lines(f).entries()) {
        const m = l.match(/^\s*(?:[\d*/,.-]+\s+){5}\S+/)
        if (!m) continue
        const fields = l.trim().split(/\s+/).slice(0, 5).join(' ')
        facts.schedules.push({ kind: 'crontab', file: f, line: i + 1, detail: l.trim().slice(0, 80) })
        propose({
          key: `crontab|${f}|${i}`,
          kind: 'heartbeat',
          evidence: [{ file: f, line: i + 1 }],
          suggests: { kind: 'heartbeat', args: { id: slugify(`${basename(f)}-cron-${i + 1}`), schedule: fields } },
          confidence: 'medium',
          needs: 'none',
          note: `crontab line: ${l.trim().slice(0, 80)}`
        })
      }
    }
    if (/\.github\/workflows\/[^/]+\.ya?ml$/.test(f)) {
      const s = text(f)
      const crons = [...s.matchAll(/-\s*cron:\s*['"]?([^'"\n]+)/g)].map((m) => m[1].trim())
      if (crons.length > 0) {
        facts.schedules.push({ kind: 'github-schedule', file: f, line: lineOf(f, 'cron:'), detail: crons.join(', ') })
        propose({
          key: `github.schedule|${f}`,
          kind: 'heartbeat',
          evidence: [{ file: f, line: lineOf(f, 'cron:') }],
          suggests: { kind: 'heartbeat', args: { id: slugify(base.replace(/\.ya?ml$/, '')), schedule: crons[0] } },
          confidence: 'high',
          needs: 'none',
          note: `scheduled workflow (${crons.join(', ')}); the agent must pick every/grace from the cron`
        })
      }
    }
    if (base === 'vercel.json') {
      try {
        const j = JSON.parse(text(f)) as { crons?: Array<{ path?: string; schedule?: string }> }
        for (const c of j.crons ?? []) {
          facts.schedules.push({ kind: 'vercel-cron', file: f, line: lineOf(f, '"crons"'), detail: `${c.path ?? '?'} ${c.schedule ?? '?'}` })
          propose({
            key: `vercel.cron|${c.path ?? '?'}`,
            kind: 'heartbeat',
            evidence: [{ file: f, line: lineOf(f, '"crons"') }],
            suggests: { kind: 'heartbeat', args: { id: slugify(`cron-${c.path ?? 'job'}`), schedule: c.schedule ?? '0 3 * * *' } },
            confidence: 'high',
            needs: 'none',
            note: `vercel cron ${c.path ?? '?'} ${c.schedule ?? '?'}`
          })
        }
      } catch {
        note(f, 'vercel.json is not valid JSON')
      }
    }
    if (base === 'wrangler.toml' || base === 'wrangler.jsonc' || base === 'wrangler.json') {
      const s = text(f)
      const crons = [...s.matchAll(/crons?\s*=\s*\[([^\]]*)\]/g)].map((m) => m[1].replace(/["'\s]/g, '')).filter(Boolean)
      const route = (/route\s*=\s*["']([^"']+)/.exec(s) ?? [])[1]
      if (route) {
        const host = route.replace(/^https?:\/\//, '').split('/')[0]
        facts.platformConfigs.push({ file: f, kind: 'wrangler', detail: `route ${host}` })
        propose({
          key: `wrangler.route|${host}`,
          kind: 'http-probe',
          evidence: [{ file: f, line: lineOf(f, 'route') }],
          suggests: { kind: 'http-probe', args: { id: slugify(host), service: slugify(host.split('.')[0]), url: `https://${host}/` } },
          confidence: 'high',
          needs: 'none',
          note: 'Worker route host: certificate and liveness'
        })
      }
      for (const c of crons) {
        facts.schedules.push({ kind: 'wrangler-cron', file: f, line: lineOf(f, 'cron'), detail: c })
        propose({
          key: `wrangler.cron|${c}`,
          kind: 'heartbeat',
          evidence: [{ file: f, line: lineOf(f, 'cron') }],
          suggests: { kind: 'heartbeat', args: { id: slugify(`worker-cron-${c}`), schedule: c } },
          confidence: 'high',
          needs: 'none',
          note: `Worker cron ${c.slice(0, 60)}`
        })
      }
    }
    if (!/\.ya?ml$/.test(f)) continue
    const s = text(f)
    if (!/livenessProbe|readinessProbe|startupProbe|kind:\s*CronJob/.test(s)) continue
    const ls = lines(f)
    if (/kind:\s*CronJob/.test(s)) {
      const schedule = (/^\s*schedule:\s*['"]?([^'"\n]+)/m.exec(s) ?? [])[1]
      if (schedule) {
        const service = slugify(basename(f).replace(/\.ya?ml$/, ''))
        facts.schedules.push({ kind: 'k8s-cronjob', file: f, line: lineOf(f, 'schedule:'), detail: schedule.trim() })
        propose({
          key: `k8s.cronjob|${service}`,
          kind: 'heartbeat',
          evidence: [{ file: f, line: lineOf(f, 'schedule:') }],
          suggests: { kind: 'heartbeat', args: { id: slugify(`${service}-cron`), schedule: schedule.trim() } },
          confidence: 'high',
          needs: 'none',
          note: `CronJob schedule ${schedule.trim()}`
        })
      }
    }
    for (let i = 0; i < ls.length; i++) {
      if (!/Probe:/.test(ls[i])) continue
      const block = ls.slice(i, i + 10).join('\n')
      const path = (/httpGet:[\s\S]*?path:\s*(\S+)/.exec(block) ?? [])[1]?.replace(/['"]/g, '')
      const rawPort = (/httpGet:[\s\S]*?port:\s*(\d+)/.exec(block) ?? [])[1] ?? (/tcpSocket:[\s\S]*?port:\s*(\d+)/.exec(block) ?? [])[1]
      const tcp = /tcpSocket:/.test(block)
      const grpc = /grpc:/.test(block)
      if (facts.k8s.length < MAX_FACT_ROWS) facts.k8s.push({ file: f, line: i + 1, ...(path ? { path } : {}), ...(rawPort ? { port: Number(rawPort) } : {}), tcp, grpc })
      const service = slugify(basename(f).replace(/\.ya?ml$/, ''))
      if (path) {
        propose({
          key: `k8s.httpGet|${service}|${path}|${rawPort ?? ''}`,
          kind: 'http-probe',
          evidence: [{ file: f, line: i + 1 }],
          suggests: { kind: 'http-probe', args: { id: slugify(`${service}-health`), service, url: rawPort ? `http://127.0.0.1:${Number(rawPort)}${path}` : `http://127.0.0.1/${path.replace(/^\//, '')}` } },
          confidence: rawPort ? 'high' : 'medium',
          needs: rawPort ? 'none' : 'judgment',
          note: 'the manifest already names the health route'
        })
      }
      if ((tcp || grpc) && rawPort) {
        propose({
          key: `k8s.tcp|${service}|${rawPort}`,
          kind: 'tcp-probe',
          evidence: [{ file: f, line: i + 1 }],
          suggests: { kind: 'tcp-probe', args: { id: slugify(`${service}-tcp`), service, host: '127.0.0.1', port: Number(rawPort) } },
          confidence: 'medium',
          needs: 'judgment',
          note: 'a TCP/gRPC port the manifest probes; the host is not in the manifest, so the agent names where it runs'
        })
      }
    }
  }

  // ---- 9. platform configs whose health path is a literal -----------------------------------------
  for (const f of files) {
    const base = basename(f)
    if (base === 'fly.toml') {
      const s = text(f)
      const internalPort = (/internal_port\s*=\s*(\d{2,5})/.exec(s) ?? [])[1]
      for (const m of s.matchAll(/\[\[http_service\.checks\]\][\s\S]*?path\s*=\s*["']([^"']+)/g)) {
        const path = m[1]
        facts.platformConfigs.push({ file: f, kind: 'fly', detail: `health ${path}` })
        propose({
          key: `fly.health|${path}`,
          kind: 'http-probe',
          evidence: [{ file: f, line: lineOf(f, 'path') }],
          suggests: { kind: 'http-probe', args: { id: slugify(`${base}-health`), service: slugify(base.replace(/\..*$/, '')), url: `http://127.0.0.1:${internalPort ?? 8080}${path}` } },
          confidence: 'medium',
          needs: 'judgment',
          note: `fly.io already runs this check (${path}); the public hostname is agent judgement`
        })
      }
    }
    if (base === 'railway.json' || base === 'render.yaml' || base === 'render.yml') {
      const s = text(f)
      const path = (/healthcheckPath["']?\s*[:=]\s*["']([^"']+)/.exec(s) ?? /healthCheckPath["']?\s*[:=]\s*["']([^"']+)/.exec(s) ?? [])[1]
      if (path) {
        facts.platformConfigs.push({ file: f, kind: base.replace(/\.(json|ya?ml)$/, ''), detail: `health ${path}` })
        propose({
          key: `platform.health|${base}|${path}`,
          kind: 'http-probe',
          evidence: [{ file: f, line: lineOf(f, path) }],
          suggests: { kind: 'http-probe', args: { id: slugify(`${base.replace(/\..*$/, '')}-health`), service: slugify(base.replace(/\..*$/, '')), url: `http://127.0.0.1:${prodListeners[0]?.port ?? 3000}${path}` } },
          confidence: 'medium',
          needs: 'judgment',
          note: `the platform already checks ${path}`
        })
      }
    }
  }

  // ---- 10. declared silence: staleAfterSec-like keys in the project's own config ------------------
  for (const f of files) {
    if (!/\.(json|ya?ml|ts|js|mjs)$/.test(f) || DATA_FILE.test(f)) continue
    const ls = lines(f)
    for (let i = 0; i < ls.length; i++) {
      const m = ls[i].match(/["']?(staleAfterSec|presenceTtlSec|heartbeatSec|intervalSec)["']?\s*[:=]\s*(\d{1,9})/)
      if (!m) continue
      const seconds = Number(m[2])
      if (facts.staleWindows.length < MAX_FACT_ROWS) facts.staleWindows.push({ file: f, line: i + 1, key: m[1], seconds })
      propose({
        key: `stale.window|${f}|${m[1]}|${seconds}`,
        kind: 'heartbeat',
        evidence: [{ file: f, line: i + 1 }],
        suggests: { kind: 'heartbeat', args: { id: slugify(`${basename(f)}-${m[1]}`), every: durationOfSeconds(seconds), grace: durationOfSeconds(Math.max(60, Math.round(seconds / 3))) } },
        confidence: 'high',
        needs: 'judgment',
        note: `${m[1]}=${seconds} is a silence already declared: the heartbeat should match it`
      })
    }
  }

  // ---- 11. health routes -> probes (port inference and the nginx join) ----------------------------
  const healthByPath = new Map<string, { canonical: { path: string; file: string; line: number; okJson: boolean }; all: Array<{ path: string; file: string; line: number; okJson: boolean }> }>()
  for (const h of facts.healthRoutes) {
    if (h.scope !== 'prod') continue
    const held = healthByPath.get(h.path) ?? { canonical: h, all: [] }
    held.all.push(h)
    if (srcRank(h.file) < srcRank(held.canonical.file)) held.canonical = h
    healthByPath.set(h.path, held)
  }
  for (const [path, group] of healthByPath) {
    const h = group.canonical
    const port = prodListeners.length > 0 ? prodListeners[0].port : null
    const evidence = group.all.slice().sort((a, b) => srcRank(a.file) - srcRank(b.file)).map((x) => ({ file: x.file, line: x.line }))
    if (port !== null) {
      propose({
        key: `source.healthRoute|${port}${path}`,
        kind: 'http-probe',
        evidence,
        suggests: {
          kind: 'http-probe',
          args: {
            id: slugify(path === '/' ? 'app' : path.replace(/^\//, '').replace(/\//g, '-')),
            service: 'app',
            url: `http://127.0.0.1:${port}${path}`,
            ...(h.okJson ? { 'expect-json': { ok: true } } : {})
          }
        },
        confidence: h.okJson ? 'high' : 'medium',
        needs: h.okJson ? 'none' : 'judgment',
        ...(h.okJson ? { assertion: 'liveness-only' as const } : {}),
        note: h.okJson
          ? 'the handler answers a constant ({ok:true} or {status:"ok"}): this proves liveness only. Add a dependency-gated path (a DB/queue check) as a second assertion.'
          : 'health route found; the body assertion is agent judgement'
      })
    } else {
      propose({
        key: `source.healthRoute|no-port|${path}`,
        kind: 'http-probe',
        evidence,
        suggests: { kind: 'http-probe', args: { id: slugify(path.replace(/^\//, '').replace(/\//g, '-') || 'app'), service: 'app', url: `http://127.0.0.1:<port>${path}` } },
        confidence: 'medium',
        needs: 'judgment',
        ...(h.okJson ? { assertion: 'liveness-only' as const } : {}),
        note: `health route found${h.okJson ? ' (its handler answers a constant: liveness only)' : ''}, but no trusted port read (env PORT, .listen(n) or compose ports); the agent names the port`
      })
    }
    // The join the catalogue implies: a public vhost whose proxy_pass port equals the port a health
    // path is served on (a compose healthcheck naming the same path) is the real public target.
    const joinedPorts = composeHealth.filter((c) => c.path === path).map((c) => c.port)
    for (const np of nginxProxies) {
      if (!joinedPorts.includes(np.port)) continue
      propose({
        key: `join.nginx+health|${np.host}${path}`,
        kind: 'http-probe',
        evidence: [{ file: np.file, line: np.line }, ...evidence.slice(0, 1)],
        suggests: {
          kind: 'http-probe',
          args: { id: slugify(`${np.host}${path.replace(/\//g, '-')}`), service: slugify(np.host.split('.')[0]), url: `https://${np.host}${path}`, ...(h.okJson ? { 'expect-json': { ok: true } } : {}) }
        },
        confidence: 'high',
        needs: h.okJson ? 'none' : 'judgment',
        ...(h.okJson ? { assertion: 'liveness-only' as const } : {}),
        note: 'the vhost and the health route are joined by the same backend port: this is the real public target'
      })
    }
  }

  // ---- 12. webhooks: one dispatcher collapses to one proposal -------------------------------------
  const webhookByNorm = new Map<string, { path: string; file: string; line: number }>()
  for (const w of facts.webhookRoutes) {
    if (w.scope !== 'prod') continue
    const norm = w.path.replace(/:[A-Za-z_]+/g, ':x')
    if (!webhookByNorm.has(norm)) webhookByNorm.set(norm, w)
  }
  const familyOf = (path: string): string => path.replace(/^\//, '').split('/')[0] ?? ''
  const familyCounts = new Map<string, number>()
  for (const norm of webhookByNorm.keys()) familyCounts.set(familyOf(norm), (familyCounts.get(familyOf(norm)) ?? 0) + 1)
  const dispatcherFamily = [...familyCounts].find(([, n]) => n >= 3)?.[0]
  const manyWebhooks = webhookByNorm.size > 4 || dispatcherFamily !== undefined
  if (manyWebhooks) {
    const all = [...webhookByNorm.values()]
    propose({
      key: 'source.webhookRoute|dispatcher',
      kind: 'webhook',
      evidence: all.slice(0, 8).map((w) => ({ file: w.file, line: w.line })),
      suggests: { kind: 'webhook', args: { id: slugify('ingest'), 'token-env': 'WATCHER_INGEST_TOKEN', 'stale-after-sec': 86_400 } },
      confidence: 'low',
      needs: 'judgment',
      note: `${all.length} ingest-like routes${dispatcherFamily ? ` (one /${dispatcherFamily}/* family)` : ''} look like one dispatcher, not ${all.length} senders: the agent picks the real senders`
    })
  } else {
    for (const [norm, w] of webhookByNorm) {
      propose({
        key: `source.webhookRoute|${norm}`,
        kind: 'webhook',
        evidence: [{ file: w.file, line: w.line }],
        suggests: { kind: 'webhook', args: { id: slugify(norm.replace(/^\//, '').replace(/[/:]/g, '-')), 'token-env': `${slugify(norm.replace(/^\//, '').replace(/[/:]/g, '-')).toUpperCase().replace(/-/g, '_')}_TOKEN`, 'stale-after-sec': 86_400 } },
        confidence: 'medium',
        needs: 'credential',
        note: 'inbound webhook: a silence guard (staleAfterSec) is the monitor; the expected cadence is agent judgement'
      })
    }
  }

  // ---- 13. dependencies that already imply a monitor ----------------------------------------------
  if (hasDep(DEPS.sentry) || envKeySet.has('SENTRY_DSN')) {
    const evidence = [depEvidence(DEPS.sentry) ?? envEvidence(/SENTRY_DSN/)].filter((e): e is Evidence => e !== null)
    if (evidence.length > 0) {
      propose({
        key: 'dep.sentry',
        kind: 'sentry',
        evidence,
        suggests: { kind: 'sentry', args: { id: 'sentry', 'token-env': 'SENTRY_TOKEN' } },
        confidence: 'high',
        needs: 'credential',
        note: 'an error tracker already exists: read it (sentry source), do not duplicate it'
      })
    }
  }
  if (hasDep(DEPS.stripe) || [...envKeySet].some((k) => /^STRIPE_/.test(k))) {
    const evidence = [depEvidence(DEPS.stripe) ?? envEvidence(/^STRIPE_/)].filter((e): e is Evidence => e !== null)
    if (evidence.length > 0) {
      propose({
        key: 'dep.stripe',
        kind: 'webhook',
        evidence,
        suggests: { kind: 'webhook', args: { id: 'stripe', 'token-env': 'STRIPE_WEBHOOK_SECRET' } },
        confidence: 'medium',
        needs: 'credential',
        note: 'the payment webhook must keep arriving: a webhook source with a silence guard'
      })
    }
  }
  for (const e of facts.envKeys) {
    if (!/_WEBHOOK_SECRET$|_SIGNING_SECRET$/.test(e.key)) continue
    if (facts.deps.some((d) => /^stripe$/.test(d.dep)) && /^STRIPE_/.test(e.key)) continue
    propose({
      key: `env.webhookSecret|${e.key}`,
      kind: 'webhook',
      evidence: [{ file: e.file, line: e.line }],
      suggests: { kind: 'webhook', args: { id: slugify(e.key.replace(/_WEBHOOK_SECRET$|_SIGNING_SECRET$/, '')), 'token-env': e.key } },
      confidence: 'medium',
      needs: 'credential',
      note: `${e.key} implies an inbound webhook`
    })
  }
  if (hasDep(DEPS.httpApp) && healthByPath.size === 0) {
    const evidence = depEvidence(DEPS.httpApp)
    if (evidence) {
      propose({
        key: 'dep.httpApp',
        kind: 'http-probe',
        evidence: [evidence],
        suggests: { kind: 'http-probe', args: { id: slugify('app'), service: 'app' } },
        confidence: 'low',
        needs: 'judgment',
        note: 'an HTTP app is here, but no health route and no trusted port were found: the agent names the URL'
      })
    }
  }
  if (hasDep(DEPS.db) || hasDep(DEPS.redis)) {
    const evidence = depEvidence(DEPS.db) ?? depEvidence(DEPS.redis)
    if (evidence) {
      propose({
        key: 'dep.data',
        kind: 'http-probe',
        evidence: [evidence],
        suggests: { kind: 'http-probe', args: { id: slugify('app'), service: 'app' } },
        confidence: 'low',
        needs: 'judgment',
        note: 'a database or queue is in the path: only a dependency-gated health route (or a checks push) can prove it'
      })
    }
  }

  // ---- 14. listeners with no health route ----------------------------------------------------------
  for (const l of prodListeners) {
    if (!/^(src|server|app|lib)\//.test(l.file) && !/(^|\/)(index|main|server|app|cli|worker|collect|serve|service)\.(m?[jt]sx?|py|go)$/.test(l.file)) continue
    propose({
      key: `source.listener|${l.port}`,
      kind: 'http-probe',
      evidence: [{ file: l.file, line: l.line }],
      suggests: { kind: 'http-probe', args: { id: slugify(`${l.port}-app`), service: 'app', url: `http://127.0.0.1:${l.port}/` } },
      confidence: 'low',
      needs: 'judgment',
      note: `listener on ${l.port} (${l.how}); no health route in source, so only a bare 200 is checkable until you add one`
    })
  }

  // ---- 15. nothing found ---------------------------------------------------------------------------
  if (facts.manifests.length === 0 && facts.listeners.length === 0 && facts.healthRoutes.length === 0 && facts.schedules.length === 0) {
    note('.', 'no manifest, listener, health route or scheduler found: nothing deterministic to propose')
  }
  if (facts.capHit) note('.', `file cap (${files.length}) reached: the scan saw only part of the tree (walk order matters)`)
  if (facts.depthHit) note('.', 'directory depth cap reached: a deep branch was not scanned')

  // ---- 16. one signal per target: the health route, the Dockerfile, a compose check and a platform
  // config often name the same URL. Keep the most confident one and merge the evidence, so a target
  // is proposed once (the #10 run had three duplicates of a covered target).
  const RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 }
  const byTarget = new Map<string, ScanSignal>()
  const deduped: ScanSignal[] = []
  for (const signal of signals) {
    const url = typeof signal.suggests.args.url === 'string' ? signal.suggests.args.url : null
    if (url === null) {
      deduped.push(signal)
      continue
    }
    const normalize = (u: string): string => u.replace('//localhost:', '//127.0.0.1:')
    const key = `${signal.kind}|${normalize(url)}`
    const held = byTarget.get(key)
    if (!held) {
      byTarget.set(key, signal)
      deduped.push(signal)
      continue
    }
    // Merge the evidence into the better proposal, and take its note only when it has one.
    // Equal confidence: a source file outranks a Dockerfile, compose or platform config.
    const sourceRank = (x: ScanSignal): number => srcRank(x.evidence[0]?.file ?? '')
    const better = RANK[signal.confidence] < RANK[held.confidence] || (RANK[signal.confidence] === RANK[held.confidence] && sourceRank(signal) < sourceRank(held))
    const winner = better ? signal : held
    const loser = winner === held ? signal : held
    for (const e of loser.evidence) if (!winner.evidence.some((x) => x.file === e.file && x.line === e.line)) winner.evidence.push(e)
    if (!winner.note && loser.note) winner.note = loser.note
    if (!winner.assertion && loser.assertion) winner.assertion = loser.assertion
    if (winner !== held) {
      const at = deduped.indexOf(held)
      deduped[at] = winner
      byTarget.set(key, winner)
    }
  }
  // Renumber after dedupe so the ids are dense and stable for this run.
  deduped.forEach((signal, i) => { signal.id = `signal-${String(i + 1).padStart(3, '0')}` })
  signals.length = 0
  signals.push(...deduped)

  // ---- 17. suggested commands: only proposals complete enough to run ------------------------------
  const suggestedCommands: string[] = []
  for (const signal of signals) {
    if (signal.needs === 'judgment') continue
    if (signal.kind === 'sentry' && signal.suggests.args['org'] === undefined) continue
    const line = commandFor(signal.suggests.kind, signal.suggests.args)
    if (!suggestedCommands.includes(line)) suggestedCommands.push(line)
  }

  return { project: root, facts, signals, suggestedCommands }
}
