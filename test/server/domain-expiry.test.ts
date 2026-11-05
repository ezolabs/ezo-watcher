// The domain-expiry source against a recorded RDAP record for example.com (fetched from https://rdap.org/domain/example.com on 2026-11-04,
// which redirects to the Verisign registry's own server) and an injected fetch, so no test reaches the network. The registry's record is the
// fixture the parser must keep understanding; the clock is the test's own, so the warn and page tiers move only when a test says.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { configServiceNames, loadConfig } from '../../src/server/config.ts'
import type { DomainExpirySourceConfig, WatchConfig } from '../../src/server/config.ts'
import { openDb } from '../../src/server/db.ts'
import { Engine } from '../../src/server/engine.ts'
import { POLLED } from '../../src/server/source-registry.ts'
import { DOMAIN_ASSERTS, DOMAIN_EXPIRY_DEFAULTS, DOMAIN_RULES, createDomainExpirySource, normalizeDomainExpiry, rdapUrl, readDomainExpiry } from '../../src/server/sources/domain-expiry.ts'
import type { DomainReading } from '../../src/server/sources/domain-expiry.ts'
import type { SourceDeps } from '../../src/server/sources/types.ts'
import type { Observation, RuleCell } from '../../src/shared/types.ts'

const DAY = 86_400_000
const T0 = Date.parse('2026-11-04T12:00:00Z')

/** Recorded from https://rdap.org/domain/example.com (Verisign's com registry), 2026-11-04. Trimmed of notices only. */
const RDAP_EXAMPLE_COM = {
  objectClassName: 'domain',
  handle: '2336799_DOMAIN_COM-VRSN',
  ldhName: 'EXAMPLE.COM',
  status: ['client delete prohibited', 'client transfer prohibited', 'client update prohibited'],
  entities: [
    {
      objectClassName: 'entity',
      handle: '376',
      roles: ['registrar'],
      vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'RESERVED-Internet Assigned Numbers Authority']]]
    }
  ],
  events: [
    { eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' },
    { eventAction: 'expiration', eventDate: '2027-08-13T04:00:00Z' },
    { eventAction: 'last changed', eventDate: '2026-08-14T08:01:43Z' },
    { eventAction: 'last update of RDAP database', eventDate: '2026-11-05T01:51:20Z' }
  ],
  secureDNS: { delegationSigned: true },
  nameservers: [
    { objectClassName: 'nameserver', ldhName: 'ELLIOTT.NS.CLOUDFLARE.COM' },
    { objectClassName: 'nameserver', ldhName: 'HERA.NS.CLOUDFLARE.COM' }
  ],
  rdapConformance: ['rdap_level_0', 'icann_rdap_technical_implementation_guide_1', 'icann_rdap_response_profile_1']
} as const

/** A fetch that answers one JSON document, whatever it is asked. */
const jsonFetch = (body: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('one RDAP lookup', () => {
  it('reads the expiration event from the recorded record, and asks rdap.org for that domain only', async () => {
    let asked = ''
    let accept = ''
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      asked = String(url)
      accept = String((init?.headers as Record<string, string>).Accept)
      return new Response(JSON.stringify(RDAP_EXAMPLE_COM), { status: 200 })
    }) as unknown as typeof fetch
    expect(await readDomainExpiry(f, 'example.com')).toEqual({ ok: true, expiresAtMs: Date.parse('2027-08-13T04:00:00Z') })
    expect(asked).toBe('https://rdap.org/domain/example.com')
    expect(accept).toBe('application/rdap+json')
    expect(rdapUrl('example.com')).toBe('https://rdap.org/domain/example.com')
  })

  it('says what a failed lookup did, and never a body', async () => {
    expect(await readDomainExpiry(jsonFetch({ errorCode: 404 }, 404), 'nope.example')).toEqual({ ok: false, detail: 'RDAP answered HTTP 404' })
    const broken = (async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })
    }) as unknown as typeof fetch
    expect(await readDomainExpiry(broken, 'example.com')).toEqual({ ok: false, detail: 'no answer: ENOTFOUND' })
    const html = (async () => new Response('<html>no</html>', { status: 200 })) as unknown as typeof fetch
    expect(await readDomainExpiry(html, 'example.com')).toEqual({ ok: false, detail: 'the RDAP record is not JSON' })
    expect(await readDomainExpiry(jsonFetch([]), 'example.com')).toEqual({ ok: false, detail: 'the RDAP record is not an object' })
  })

  it('treats a record with no expiration event or an unreadable date as a failed lookup, not as expiry', async () => {
    const noExpiry = { ...RDAP_EXAMPLE_COM, events: [{ eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' }] }
    expect(await readDomainExpiry(jsonFetch(noExpiry), 'example.com')).toEqual({ ok: false, detail: 'the RDAP record has no expiration event' })
    const badDate = { ...RDAP_EXAMPLE_COM, events: [{ eventAction: 'expiration', eventDate: 'soon' }] }
    expect(await readDomainExpiry(jsonFetch(badDate), 'example.com')).toEqual({ ok: false, detail: 'the RDAP expiration date is not a time' })
  })
})

// ---- the damped reading, without a network ------------------------------------------------------------------------------------------------

const cfg = (over: Partial<DomainExpirySourceConfig> = {}): DomainExpirySourceConfig => ({ id: 'domains', type: 'domain-expiry', service: 'web', domains: ['example.com'], ...over })
const ctx = (nowMs = T0) => ({ nowIso: new Date(nowMs).toISOString(), serviceMap: [] })
const reading = (days: number | null): DomainReading =>
  days === null ? { domain: 'example.com', expiry: { ok: false, detail: 'RDAP answered HTTP 500' } } : { domain: 'example.com', expiry: { ok: true, expiresAtMs: T0 + days * DAY } }
const cellOf = (o: Observation): RuleCell | undefined => o.checks?.cells.find((c) => c.checkId === DOMAIN_RULES.expiring)

describe('DomainExpiring', () => {
  it('reads ok with plenty of time left, and proves the page-day assertion', () => {
    const o = normalizeDomainExpiry([reading(45)], cfg(), ctx())
    expect(o.firing).toEqual([])
    // like CertExpiring, both tiers are said resolved whenever there is plenty of time, so a renewal clears history
    expect(o.resolved.map((a) => a.severity)).toEqual(['page', 'warning'])
    expect(cellOf(o)).toMatchObject({ state: 'ok', service: 'web', name: 'example.com', asserts: [DOMAIN_ASSERTS.expires(7)] })
    expect(cellOf(o)?.detail).toMatch(/^expires in 45 days \(\d{4}-\d{2}-\d{2}\)$/)
    expect(cellOf(o)?.url).toBe('https://rdap.org/domain/example.com')
  })

  it('warns under warnDays, pages under pageDays, and resolves the other tier', () => {
    const warn = normalizeDomainExpiry([reading(20)], cfg(), ctx())
    expect(warn.firing.map((a) => [a.rule, a.severity, a.labels.instance, a.via[0].kind])).toEqual([['DomainExpiring', 'warning', 'example.com', 'domain-expiry']])
    expect(warn.resolved.filter((a) => a.rule === 'DomainExpiring').map((a) => a.severity)).toEqual(['page'])
    expect(cellOf(warn)).toMatchObject({ state: 'firing' })
    expect(cellOf(warn)?.detail).toMatch(/^expires in 20 days \(/)
    const page = normalizeDomainExpiry([reading(5)], cfg(), ctx())
    expect(page.firing.filter((a) => a.rule === 'DomainExpiring').map((a) => a.severity)).toEqual(['page'])
    expect(page.resolved.filter((a) => a.rule === 'DomainExpiring').map((a) => a.severity)).toEqual(['warning'])
    expect(page.firing[0].annotations.page_reason).toMatch(/^The domain example\.com expires in 5 days/)
  })

  it('still pages once the domain has expired, in words that say so', () => {
    const o = normalizeDomainExpiry([reading(-2)], cfg(), ctx())
    expect(o.firing.map((a) => a.severity)).toEqual(['page'])
    expect(o.firing[0].annotations.summary).toMatch(/^The domain example\.com has expired \(\d{4}-\d{2}-\d{2}\)$/)
    expect(cellOf(o)?.detail).toMatch(/^expired \d{4}-\d{2}-\d{2}$/)
  })

  it('fires and resolves nothing when the lookup failed, and says why on the cell', () => {
    const o = normalizeDomainExpiry([reading(null)], cfg(), ctx())
    expect(o.firing).toEqual([])
    expect(o.resolved).toEqual([])
    expect(cellOf(o)).toMatchObject({ state: 'nodata', detail: 'RDAP lookup failed: RDAP answered HTTP 500' })
    expect(cellOf(o)?.evaluatedAt).toBeUndefined()
  })

  it('takes its own warn and page days, and the source id as the tile when it names none', () => {
    const own = normalizeDomainExpiry([reading(5)], cfg({ warnDays: 10, pageDays: 3 }), ctx())
    expect(own.firing.map((a) => a.severity)).toEqual(['warning'])
    expect(cellOf(own)?.asserts).toEqual(['rdap:expires>3d'])
    const tileless = normalizeDomainExpiry([reading(45)], cfg({ service: undefined }), ctx())
    expect(cellOf(tileless)?.service).toBe('domains')
  })
})

// ---- the source and the engine ------------------------------------------------------------------------------------------------------------

describe('the domain-expiry source', () => {
  it('polls each domain lowercased, reports the 12 h interval, and keeps the RDAP link as evidence', async () => {
    let asked = ''
    const f = (async (url: string | URL | Request) => {
      asked = String(url)
      return new Response(JSON.stringify(RDAP_EXAMPLE_COM), { status: 200 })
    }) as unknown as typeof fetch
    const deps: SourceDeps = { fetch: f, env: {}, nowIso: () => new Date(T0).toISOString(), serviceMap: [] }
    const source = createDomainExpirySource(cfg({ domains: ['Example.COM'] }), deps)
    expect(source).toMatchObject({ id: 'domains', kind: 'domain-expiry', name: 'Domain expiry', pollSec: 43_200 })
    const obs = await source.poll()
    expect(asked).toBe('https://rdap.org/domain/example.com')
    expect(obs.checks?.cells[0]).toMatchObject({ name: 'example.com', state: 'ok', asserts: ['rdap:expires>7d'], url: 'https://rdap.org/domain/example.com' })
  })

  it('pages a nearly-expired domain through the engine, on the tile the config names', async () => {
    const expiring = { ...RDAP_EXAMPLE_COM, events: RDAP_EXAMPLE_COM.events.map((e) => (e.eventAction === 'expiration' ? { ...e, eventDate: new Date(T0 + 5 * DAY).toISOString() } : e)) }
    const deps: SourceDeps = { fetch: jsonFetch(expiring), env: {}, nowIso: () => new Date(T0).toISOString(), serviceMap: [] }
    const c = cfg()
    const watch: WatchConfig = {
      baseUrl: 'https://watch.test',
      port: 0,
      host: '127.0.0.1',
      dataDir: ':memory:',
      historyHours: 24,
      staleAfterMisses: 3,
      sources: [c],
      serviceMap: [],
      splitIncidents: [{ match: { origin: `^${c.id}$` }, by: 'instance' }],
      channels: [],
      routes: [],
      quietHours: null
    }
    const engine = new Engine(openDb(':memory:'), watch, () => T0)
    const source = createDomainExpirySource(c, deps)
    const obs = await source.poll()
    engine.ingest(obs)
    engine.recordSource(c.id, true, null)
    const incidents = engine.wall().incidents.filter((i) => i.rule === DOMAIN_RULES.expiring)
    expect(incidents).toHaveLength(1)
    expect(incidents[0]).toMatchObject({ severity: 'page', service: 'Web', instance: 'example.com' })
    expect(incidents[0].alerts[0].via[0].kind).toBe('domain-expiry')
  })
})

// ---- the config ---------------------------------------------------------------------------------------------------------------------------

describe('the domain-expiry rule and the config', () => {
  const write = (source: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), 'watch-domain-cfg-'))
    const file = join(dir, 'watch.json')
    writeFileSync(file, JSON.stringify({ baseUrl: 'https://watch.test', port: 0, host: '127.0.0.1', dataDir: ':memory:', historyHours: 24, staleAfterMisses: 3, sources: [source], serviceMap: [], channels: [], routes: [], quietHours: null }))
    return file
  }
  const domainSource = (over: Record<string, unknown> = {}) => ({ id: 'domains', type: 'domain-expiry', service: 'web', domains: ['example.com'], ...over })

  it('takes the shape with its defaults, and the registry starts it at 12 h', () => {
    const loaded = loadConfig(write(domainSource()))
    const built = POLLED['domain-expiry']?.(loaded.sources[0], { fetch, env: {}, nowIso: () => new Date(T0).toISOString(), serviceMap: [] }, { loadNodes: [] })
    expect(built?.source).toMatchObject({ id: 'domains', kind: 'domain-expiry', pollSec: 43_200 })
    expect(DOMAIN_EXPIRY_DEFAULTS).toEqual({ pollSec: 43_200, warnDays: 30, pageDays: 7 })
    expect(loadConfig(write(domainSource({ service: undefined }))).sources).toHaveLength(1)
    expect([...configServiceNames(loadConfig(write(domainSource())))].sort()).toContain('web')
  })

  it('refuses a domain it cannot look up, naming the field', () => {
    const bad: Array<[unknown, RegExp]> = [
      [domainSource({ domains: [] }), /needs domains/],
      [domainSource({ domains: ['https://example.com'] }), /domains\[0\] must be a domain name/],
      [domainSource({ domains: ['example'] }), /domains\[0\] must be a domain name/],
      [domainSource({ domains: ['exa mple.test'] }), /domains\[0\] must be a domain name/],
      [domainSource({ domains: ['example.com/path'] }), /domains\[0\] must be a domain name/],
      [domainSource({ domains: ['example.com', 'EXAMPLE.COM'] }), /domains\[1\] EXAMPLE\.COM is listed twice/],
      [domainSource({ warnDays: 0 }), /pageDays must be 0 or more and at most warnDays/],
      [domainSource({ warnDays: 5, pageDays: 7 }), /pageDays must be 0 or more and at most warnDays/],
      [domainSource({ pageDays: -1 }), /pageDays must be 0 or more and at most warnDays/],
      [domainSource({ pollSec: 0 }), /pollSec must be a number of seconds above 0/],
      [domainSource({ service: '' }), /service must name the wall tile/]
    ]
    for (const [source, message] of bad) expect(() => loadConfig(write(source)), JSON.stringify(source)).toThrow(message)
  })
})
