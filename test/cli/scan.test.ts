import { describe, expect, it, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanProject } from '../../src/cli/signals/detect.ts'
import { runScan, SCAN_SPEC } from '../../src/cli/scan.ts'
import { capture, parse, rmTemp, tempDir } from './helpers.ts'

const dirs: string[] = []

function temp(prefix: string): string {
  const dir = tempDir(prefix)
  dirs.push(dir)
  return dir
}

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmTemp(dir)
})

describe('watcher scan: fixtures', () => {
  it('finds an Express health route, marks its constant answer liveness-only, and joins the Dockerfile evidence', () => {
    const result = scanProject(fixture('express-app'))
    const health = result.signals.find((s) => s.kind === 'http-probe' && String(s.suggests.args.url).endsWith('/healthz'))
    expect(health).toBeDefined()
    expect(health?.confidence).toBe('high')
    expect(health?.assertion).toBe('liveness-only')
    expect(health?.suggests.args).toMatchObject({ url: 'http://127.0.0.1:3000/healthz', 'expect-json': { ok: true }, service: 'app' })
    expect(health?.evidence.some((e) => e.file.includes('Dockerfile'))).toBe(true)
    expect(health?.evidence.some((e) => e.file.includes('src/server.js'))).toBe(true)
    expect(result.facts.listeners.some((l) => l.port === 3000)).toBe(true)
  })

  it('reads .env key names and never a value', () => {
    const result = scanProject(fixture('express-app'))
    expect(result.facts.envKeys.some((e) => e.key === 'STRIPE_SECRET_KEY')).toBe(true)
    const json = JSON.stringify(result)
    expect(json).not.toContain('sk_test_do_not_read_me')
    expect(json).not.toContain('whsec_do_not_read_me')
  })

  it('proposes the inbound webhook from the route and from the Stripe dependency', () => {
    const result = scanProject(fixture('express-app'))
    const webhooks = result.signals.filter((s) => s.kind === 'webhook')
    expect(webhooks.some((w) => w.evidence.some((e) => e.file.includes('src/server.js')))).toBe(true)
    expect(webhooks.some((w) => w.evidence.some((e) => e.file === 'package.json'))).toBe(true)
    expect(webhooks.every((w) => w.needs === 'credential')).toBe(true)
  })

  it('turns vercel crons into heartbeat proposals and reads Sentry from the dependency', () => {
    const result = scanProject(fixture('next-app'))
    const beats = result.signals.filter((s) => s.kind === 'heartbeat')
    expect(beats.length).toBeGreaterThanOrEqual(2)
    // A vercel crontab is directly usable as the heartbeat's schedule.
    expect(beats.every((b) => b.needs === 'none')).toBe(true)
    expect(beats.some((b) => typeof b.suggests.args.schedule === 'string')).toBe(true)
    expect(result.signals.some((s) => s.kind === 'sentry' && s.needs === 'credential')).toBe(true)
    const health = result.signals.find((s) => s.kind === 'http-probe' && String(s.suggests.args.url).includes('/api/health'))
    expect(health?.assertion).toBe('liveness-only')
  })

  it('reads a systemd timer as a silence candidate in a Django project', () => {
    const result = scanProject(fixture('django-app'))
    expect(result.facts.manifests.some((m) => m.file === 'requirements.txt')).toBe(true)
    expect(result.facts.deps.some((d) => d.dep === 'django')).toBe(true)
    expect(result.facts.schedules.some((s) => s.kind === 'systemd-timer')).toBe(true)
    expect(result.signals.some((s) => s.kind === 'heartbeat' && s.evidence.some((e) => e.file.endsWith('.timer')))).toBe(true)
  })

  it('joins an nginx vhost to the compose health port and keeps the published ports', () => {
    const result = scanProject(fixture('compose-app'))
    const urls = result.signals.map((s) => String(s.suggests.args.url ?? ''))
    expect(urls).toContain('https://api.example.com/healthz')
    expect(urls).toContain('http://127.0.0.1:3000/healthz')
    expect(result.facts.publicHosts.some((h) => h.host === 'api.example.com')).toBe(true)
    expect(result.facts.composeServices.map((s) => s.name).sort()).toEqual(['db', 'web'])
    expect(result.facts.composeServices.find((s) => s.name === 'db')?.ports[0]).toMatchObject({ hostPort: 5432, containerPort: 5432 })
  })

  it('reads k8s httpGet and tcpSocket probes and a CronJob schedule', () => {
    const result = scanProject(fixture('k8s-app'))
    expect(result.signals.some((s) => s.kind === 'http-probe' && String(s.suggests.args.url).includes('/readyz'))).toBe(true)
    expect(result.signals.some((s) => s.kind === 'tcp-probe' && s.suggests.args.port === 6379)).toBe(true)
    expect(result.facts.schedules.some((s) => s.kind === 'k8s-cronjob')).toBe(true)
    expect(result.signals.some((s) => s.kind === 'heartbeat' && s.evidence.some((e) => e.file.endsWith('cronjob.yaml')))).toBe(true)
  })

  it('suggests heartbeat durations the server reads ("1d", not 86400) and crons as --schedule', () => {
    const launchd = scanProject(fixture('launchd-app'))
    const beat = launchd.signals.find((s) => s.kind === 'heartbeat')
    expect(beat?.suggests.args.every).toBe('1d')
    expect(beat?.suggests.args.grace).toBe('8h')
    expect(launchd.suggestedCommands.some((c) => c.includes('--every 1d') && !c.includes('86400'))).toBe(true)

    const k8s = scanProject(fixture('k8s-app'))
    expect(k8s.suggestedCommands.some((c) => c.includes("--schedule '0 4 * * *'"))).toBe(true)
    // Every heartbeat suggestion is either a duration-string interval or a crontab.
    for (const signal of [...launchd.signals, ...k8s.signals].filter((s) => s.kind === 'heartbeat')) {
      const args = signal.suggests.args
      if ('every' in args) expect(String(args.every)).toMatch(/^\d{1,7}[smhd]$/)
      else expect(typeof args.schedule).toBe('string')
    }
  })

  it('abstains on a project with nothing to watch', () => {
    const result = scanProject(fixture('empty-project'))
    expect(result.signals).toEqual([])
    expect(result.facts.notes.some((n) => n.what.includes('nothing deterministic'))).toBe(true)
  })
})

describe('watcher scan: the fixes the proof learned', () => {
  it('reports capHit when the file cap stops the walk', () => {
    const dir = temp('scan-cap')
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `file-${i}.txt`), 'x')
    const result = scanProject(dir, { maxFiles: 8 })
    expect(result.facts.capHit).toBe(true)
    expect(result.facts.notes.some((n) => n.what.includes('cap'))).toBe(true)
  })

  it('trusts only env PORT, .listen(n) and compose ports: a `port: 443` object field is not a listener', () => {
    const dir = temp('scan-port')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'config.ts'), 'export const server = { port: 443, host: "0.0.0.0" }\n')
    const result = scanProject(dir)
    expect(result.facts.listeners).toEqual([])
  })

  it('ranks a production config above a test fixture for the same URL', () => {
    const dir = temp('scan-scope')
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'test'), { recursive: true })
    writeFileSync(join(dir, 'src', 'config.ts'), 'export const baseUrl = "https://prod.example.com/healthz"\n')
    writeFileSync(join(dir, 'test', 'config.test.ts'), 'const baseUrl = "https://prod.example.com/healthz"\n')
    const result = scanProject(dir)
    const signal = result.signals.find((s) => String(s.suggests.args.url) === 'https://prod.example.com/healthz')
    expect(signal).toBeDefined()
    expect(signal?.evidence[0].file).toBe('src/config.ts')
    expect(signal?.confidence).toBe('high')
  })

  it('marks a test-only URL as low confidence and not runnable', () => {
    const dir = temp('scan-testonly')
    mkdirSync(join(dir, 'test'), { recursive: true })
    writeFileSync(join(dir, 'test', 'config.test.ts'), 'const baseUrl = "https://only-in-tests.example.com/healthz"\n')
    const result = scanProject(dir)
    const signal = result.signals.find((s) => String(s.suggests.args.url).includes('only-in-tests'))
    expect(signal?.confidence).toBe('low')
    expect(signal?.needs).toBe('judgment')
    expect(result.suggestedCommands.some((c) => c.includes('only-in-tests'))).toBe(false)
  })

  it('collapses one ingest dispatcher family into one webhook proposal', () => {
    const dir = temp('scan-dispatch')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'app.ts'), [
      "app.post('/ingest/:source', handler)",
      "app.get('/ingest/:source/recheck-requests', handler)",
      "app.post('/ingest/:source/recheck-requests/:id', handler)",
      "app.get('/alerts/:id', handler)",
      ''
    ].join('\n'))
    const result = scanProject(dir)
    const webhooks = result.signals.filter((s) => s.kind === 'webhook')
    expect(webhooks).toHaveLength(1)
    expect(webhooks[0].needs).toBe('judgment')
    expect(webhooks[0].note).toContain('dispatcher')
  })
})

describe('watcher scan: output', () => {
  it('renders the same result as JSON and as Markdown', async () => {
    const cap = capture('json')
    const code = await runScan(parse(['scan', '--dir', fixture('express-app')], SCAN_SPEC), cap.out)
    expect(code).toBe(0)
    const json = JSON.parse(cap.stdout()) as { project: string; signals: unknown[]; suggestedCommands: string[]; facts: { fileCount: number } }
    expect(json.project).toContain('express-app')
    expect(json.signals.length).toBeGreaterThan(0)
    expect(json.facts.fileCount).toBeGreaterThan(0)

    const md = capture('md')
    expect(await runScan(parse(['scan', '--dir', fixture('express-app')], SCAN_SPEC), md.out)).toBe(0)
    expect(md.stdout()).toContain('# Telemetry scan:')
    expect(md.stdout()).toContain('## Suggested commands')
  })
})
