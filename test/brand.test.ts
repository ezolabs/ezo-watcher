// The brand (config `brand`): one codebase serves watch.example.com (config/watch.example.json, no brand, so EZO Watcher as always) and a second Watcher that names
// itself. Every place the product name is written follows the config: the served page and its title, the manifest, the ntfy
// notice, the test notification, the email, the MCP server. Every token below is a test value.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/server/app.ts'
import type { AppDeps } from '../src/server/app.ts'
import { brandOf, loadConfig } from '../src/server/config.ts'
import type { WatchConfig } from '../src/server/config.ts'
import { openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'
import { manifestWithBrand, pageWithInstance } from '../src/server/instance.ts'
import { serverInfoOf } from '../src/server/mcp/server.ts'
import { createChannel } from '../src/server/notify/channels/index.ts'
import { emailHtml, emailText, fromHeader } from '../src/server/notify/channels/email.ts'
import { smsText } from '../src/server/notify/channels/sms.ts'
import { testMessage } from '../src/server/notify/message.ts'
import type { Message } from '../src/server/notify/types.ts'
import { SqlitePushStore } from '../src/server/stores.ts'
import { DEFAULT_BRAND, parseInstance } from '../src/shared/instance.ts'
import type { InstanceInfo } from '../src/shared/types.ts'
import { instanceFromDocument, pageTitle } from '../src/web/lib/instance.ts'

const MAKEFUN = { name: 'Infra Wall', shortName: 'Infra' }

const minimal = (over: Partial<WatchConfig> = {}): WatchConfig => ({
  baseUrl: 'https://watch.example.com',
  port: 0,
  host: '127.0.0.1',
  dataDir: ':memory:',
  historyHours: 24,
  staleAfterMisses: 3,
  sources: [{ id: 'webhook', type: 'webhook', tokenEnv: 'INGEST_TOKEN' }],
  serviceMap: [],
  channels: [],
  routes: [],
  quietHours: null,
  ...over
})

/** Write a config to a scratch file and load it the way main does. */
function load(raw: unknown): WatchConfig {
  const dir = mkdtempSync(join(tmpdir(), 'watch-brand-'))
  const file = join(dir, 'watch.json')
  writeFileSync(file, JSON.stringify(raw))
  return loadConfig(file)
}

describe('the config brand', () => {
  it('is EZO Watcher for the example config and for a config that names none', () => {
    const cfg = loadConfig('config/watch.example.json')
    expect(cfg.brand).toEqual({ name: 'EZO Watcher', shortName: 'Watcher' })
    expect(brandOf(cfg)).toEqual({ name: 'EZO Watcher', shortName: 'Watcher' })
    expect(brandOf(load(minimal()))).toEqual({ name: 'EZO Watcher', shortName: 'Watcher' })
    expect(DEFAULT_BRAND).toEqual({ name: 'EZO Watcher', shortName: 'Watcher' })
  })

  it('is what a config says, the name standing in for a short name it leaves out', () => {
    expect(brandOf(load(minimal({ brand: MAKEFUN })))).toEqual(MAKEFUN)
    expect(brandOf(load(minimal({ brand: { name: 'Infra Wall' } })))).toEqual({ name: 'Infra Wall', shortName: 'Infra Wall' })
  })

  it('refuses a brand that is not one short line, field by field', () => {
    const bad: Array<[unknown, RegExp]> = [
      ['Infra Wall', /brand must be an object/],
      [{}, /brand\.name must be one line of 1 to 40 characters/],
      [{ name: '' }, /brand\.name must be one line/],
      [{ name: ' padded' }, /brand\.name must be one line/],
      [{ name: 'two\nlines' }, /brand\.name must be one line/],
      [{ name: 'x'.repeat(41) }, /brand\.name must be one line/],
      [{ name: 'Infra Wall', shortName: 'y'.repeat(25) }, /brand\.shortName must be one line of 1 to 24 characters/],
      [{ name: 'Infra Wall', logo: 'x.svg' }, /brand\.logo is not a brand field/]
    ]
    for (const [brand, message] of bad) expect(() => load({ ...minimal(), brand }), JSON.stringify(brand)).toThrow(message)
  })
})

describe('the page and the manifest the server serves', () => {
  const html = readFileSync('index.html', 'utf8')
  const manifest = readFileSync('public/manifest.webmanifest', 'utf8')
  const second: InstanceInfo = { brand: MAKEFUN, features: [] }

  it('titles the page with the brand and carries the instance in a meta tag the web reads back', () => {
    const page = pageWithInstance(html, second)
    expect(page).toContain('<title>Infra Wall</title>')
    expect(page).not.toContain('<title>EZO Watcher</title>')
    const meta = /<meta name="watch-instance" content="([^"]*)" \/>/.exec(page)
    expect(meta).not.toBeNull()
    // the web's own reader, over a stand-in document that answers the one query it makes
    const doc = { querySelector: () => ({ getAttribute: () => meta![1].replace(/&quot;/g, '"').replace(/&amp;/g, '&') }) } as unknown as Document
    expect(instanceFromDocument(doc)).toEqual(second)
    expect(page.indexOf('watch-instance')).toBeLessThan(page.indexOf('</head>'))
  })

  it('keeps EZO Watcher in the title for the default brand and escapes what it writes', () => {
    expect(pageWithInstance(html, { brand: { ...DEFAULT_BRAND }, features: [] })).toContain('<title>EZO Watcher</title>')
    const odd = pageWithInstance(html, { brand: { name: 'a<b>"c', shortName: 'a' }, features: [] })
    expect(odd).toContain('<title>a&lt;b&gt;&quot;c</title>')
    expect(odd).not.toContain('a<b>')
  })

  it('names the installed app for the instance, and serves watch.example.com its manifest byte for byte', () => {
    expect(manifestWithBrand(manifest, { ...DEFAULT_BRAND })).toBe(manifest)
    const m = JSON.parse(manifestWithBrand(manifest, MAKEFUN)) as Record<string, unknown>
    expect(m.name).toBe('Infra Wall')
    expect(m.short_name).toBe('Infra')
    expect(m.icons).toEqual((JSON.parse(manifest) as { icons?: unknown }).icons)
    expect(manifestWithBrand('not json', MAKEFUN)).toBe('not json')
  })

  it('serves both through the app, and /api/instance says the same', async () => {
    const webDir = mkdtempSync(join(tmpdir(), 'watch-web-'))
    writeFileSync(join(webDir, 'index.html'), html)
    writeFileSync(join(webDir, 'manifest.webmanifest'), manifest)
    writeFileSync(join(webDir, 'theme.js'), '// as built\n')
    const boot = (cfg: WatchConfig, env: NodeJS.ProcessEnv = {}) => {
      const engine = new Engine(openDb(':memory:'), cfg, () => Date.parse('2026-11-04T12:00:00Z'))
      const deps: AppDeps = {
        engine,
        cfg,
        env,
        db: engine.db,
        push: new SqlitePushStore(engine.db),
        ackSecret: ['brand', 'test', '0001'].join('-'),
        webDir,
        normalizeWebhook: () => {
          throw new Error('no ingest here')
        },
        testChannel: async () => ({ ok: true, status: 'ok', latencyMs: 1 }),
        nudge: () => undefined,
        vapidPublicKey: null,
        now: () => Date.parse('2026-11-04T12:00:00Z'),
        log: () => undefined
      }
      return createApp(deps)
    }
    const app = boot(minimal({ brand: MAKEFUN }))
    const page = await (await app.request('/')).text()
    expect(page).toContain('<title>Infra Wall</title>')
    // a deep link falls back to the same shell, with the same name
    expect(await (await app.request('/fleet')).text()).toContain('<title>Infra Wall</title>')
    expect(((await (await app.request('/manifest.webmanifest')).json()) as { name: string }).name).toBe('Infra Wall')
    expect(await (await app.request('/theme.js')).text()).toBe('// as built\n')
    const info = parseInstance(await (await app.request('/api/instance')).json())
    expect(info).toEqual({ brand: MAKEFUN, features: [] })

    const shipped = boot(loadConfig('config/watch.example.json'))
    expect(await (await shipped.request('/')).text()).toContain('<title>EZO Watcher</title>')
    expect(await (await shipped.request('/manifest.webmanifest')).text()).toBe(manifest)

    // the MCP server introduces itself by the brand, and its tools speak of this Watch
    const token = 'mcp-brand-test-token-'.padEnd(64, '0')
    const mcp = boot(minimal({ brand: MAKEFUN }), { WATCHER_MCP_TOKEN: token })
    const rpc = async (method: string, params: unknown) =>
      (await (
        await mcp.request('/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
        })
      ).json()) as { result: { serverInfo?: { name: string; title?: string }; instructions?: string; tools?: Array<{ name: string; description: string }> } }
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'brand-test', version: '1' } })
    expect(init.result.serverInfo).toMatchObject({ name: 'infra-wall', title: 'Infra Wall' })
    expect(init.result.instructions).toMatch(/^Infra Wall is the alert wall/)
    const tools = await rpc('tools/list', {})
    expect(tools.result.tools?.find((t) => t.name === 'watch_state')?.description).toMatch(/^The Infra Wall wall in one answer/)
    expect(JSON.stringify(tools.result)).not.toContain('EZO Watcher')
  })
})

describe('what the channels write under the brand', () => {
  const page: Message = {
    kind: 'alert',
    title: 'Page: api prod is down',
    body: 'api prod, 1 instance firing since 12:00 UTC, 2m old.\nsecond-prod-health',
    severity: 'page',
    tag: 'api prod|ProbeDown',
    url: 'https://watch.example.com/#/i/x',
    noticeUrl: 'https://watch.example.com/go/0123',
    ackUrl: 'https://watch.example.com/api/ack?k=x&s=y'
  }

  it('titles the content-free ntfy.sh notice with the brand', async () => {
    const titles: string[] = []
    const fetchFake = (async (_url: unknown, init?: RequestInit) => {
      titles.push((init?.headers as Record<string, string>).Title)
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const cfg = { id: 'ntfy', type: 'ntfy' as const, server: 'https://ntfy.example', topicEnv: 'TOPIC' }
    await createChannel(cfg, { fetch: fetchFake, env: { TOPIC: 'test-topic' }, now: Date.now, brand: 'Infra Wall' }).send(page)
    await createChannel(cfg, { fetch: fetchFake, env: { TOPIC: 'test-topic' }, now: Date.now }).send(page)
    expect(titles).toEqual(['Infra Wall: page', 'EZO Watcher: page'])
  })

  it('names the brand in the test notification, the SMS that carries it and the email', () => {
    const test = testMessage('https://watch.example.com', 'Infra Wall')
    expect(test.title).toBe('Infra Wall test')
    expect(test.body).toBe('This is a test notification from Infra Wall.')
    expect(smsText(test)).toBe('Infra Wall test. This is a test notification from Infra Wall. https://watch.example.com/')
    expect(testMessage('https://watch.example.com').title).toBe('EZO Watcher test')
    const html = emailHtml(page, 'Infra Wall')
    expect(html).toContain('>Open in Infra Wall</a>')
    expect(html).toContain('Sent by Infra Wall.')
    expect(html).not.toContain('EZO Watcher')
    expect(emailText(page, 'Infra Wall')).toContain('Open in Infra Wall: https://watch.example.com/#/i/x')
    expect(emailHtml(page)).toContain('>Open in EZO Watcher</a>')
  })

  it('sends a bare From address under the brand, and a From that names its sender as written', async () => {
    expect(fromHeader('watch@alerts.example.com', 'Infra Wall')).toBe('Infra Wall <watch@alerts.example.com>')
    expect(fromHeader('EZO Watcher <watch@alerts.example.com>', 'Infra Wall')).toBe('EZO Watcher <watch@alerts.example.com>')
    const bodies: Array<{ from: string; html: string }> = []
    const fetchFake = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as { from: string; html: string })
      return new Response('{"id":"em_1"}', { status: 200 })
    }) as unknown as typeof fetch
    const cfg = { id: 'email', type: 'email' as const, provider: 'resend' as const, apiKeyEnv: 'KEY', from: 'Infra Wall <watch@alerts.example.com>', toEnv: 'TO' }
    await createChannel(cfg, { fetch: fetchFake, env: { KEY: 'test-key', TO: 'ops@example.test' }, now: Date.now, brand: 'Infra Wall' }).send(page)
    expect(bodies[0].from).toBe('Infra Wall <watch@alerts.example.com>')
    expect(bodies[0].html).toContain('Sent by Infra Wall.')
  })
})

describe('the MCP server and the page title', () => {
  it('names the MCP server by the brand, ezo-watcher as always for EZO Watcher', () => {
    expect(serverInfoOf(undefined)).toEqual({ name: 'ezo-watcher', title: 'EZO Watcher', version: '1.0.0' })
    expect(serverInfoOf({ name: 'EZO Watcher' })).toEqual({ name: 'ezo-watcher', title: 'EZO Watcher', version: '1.0.0' })
    expect(serverInfoOf(MAKEFUN)).toEqual({ name: 'infra-wall', title: 'Infra Wall', version: '1.0.0' })
  })

  it('puts the unattended page count in front of the brand in the tab title', () => {
    expect(pageTitle('EZO Watcher', 0)).toBe('EZO Watcher')
    expect(pageTitle('EZO Watcher', 3)).toBe('(3) EZO Watcher')
    expect(pageTitle('Infra Wall', 1)).toBe('(1) Infra Wall')
  })
})
