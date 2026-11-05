import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { checkWallGroups, configServiceNames, loadConfig, plainHttpAllowed, probeUrlAllowed, validateConfig } from '../src/server/config.ts'
import type { WatchConfig } from '../src/server/config.ts'
import { matchedRoutes } from '../src/server/notify/match.ts'
import { severityOf } from '../src/shared/incident.ts'
import type { Severity } from '../src/shared/types.ts'

const example = (): unknown => JSON.parse(readFileSync(fileURLToPath(new URL('../config/watch.example.json', import.meta.url)), 'utf8')) as unknown
const clone = (): WatchConfig => structuredClone(example() as WatchConfig)
const errorsOf = (cfg: unknown): string[] => {
  const out = validateConfig(cfg)
  return out.ok ? [] : out.errors
}
const bad = (over: (c: WatchConfig) => void): string => {
  const cfg = clone()
  over(cfg)
  return errorsOf(cfg).join()
}

describe('config/watch.example.json', () => {
  const file = fileURLToPath(new URL('../config/watch.example.json', import.meta.url))

  it('loads and validates as it stands', () => {
    const cfg = loadConfig(file)
    expect(validateConfig(example())).toMatchObject({ ok: true })
    expect(cfg.sources.map((s) => s.type).sort()).toEqual(['heartbeat', 'host', 'http-probe', 'tcp-probe', 'webhook'])
    expect(cfg.channels.map((c) => c.type).sort()).toEqual(['ntfy', 'webhook'])
  })

  it('probes loopback health with a JSON check, on example data only', () => {
    const cfg = example() as WatchConfig
    const probe = cfg.sources.find((s) => s.type === 'http-probe')
    expect(probe?.type).toBe('http-probe')
    if (probe?.type !== 'http-probe') return
    expect(probe.targets[0]).toMatchObject({ id: 'api-health', service: 'api', url: 'http://127.0.0.1:3000/healthz', expectJson: { status: 'ok' } })
  })

  it('routes a page to a phone-shaped channel and leaves info on the wall', () => {
    const cfg = loadConfig(file)
    const phone = new Set(['ntfy', 'webpush', 'sms'])
    const reachable = (sev: Severity): string[] => matchedRoutes(cfg.routes, { severity: sev, origin: 'probe', labels: { alertname: 'ProbeDown' } }).flatMap((r) => [...r.receivers, ...(r.escalate ?? []).flatMap((e) => e.receivers)])
    expect(reachable('page').some((id) => phone.has(id))).toBe(true)
    expect(reachable('warning')).toEqual(['hook'])
    expect(reachable('info')).toEqual([])
  })

  it('reads severity the way the alert model does: critical is a page, warn is a warning', () => {
    expect(severityOf('critical')).toBe('page')
    expect(severityOf('warn')).toBe('warning')
    expect(severityOf('')).toBe('page')
  })

  it('names the services the config itself can give a tile', () => {
    const names = configServiceNames(loadConfig(file))
    expect([...names].sort()).toEqual(['Netdata', 'Watcher sources', 'api', 'host', 'postgres', 'worker'])
  })
})

describe('validateConfig', () => {
  it('refuses a value that is not an object', () => {
    for (const raw of [null, [], 'x', 3]) expect(validateConfig(raw).ok).toBe(false)
  })

  it('requires the lists the server iterates', () => {
    for (const field of ['sources', 'channels', 'routes', 'serviceMap']) {
      const cfg = clone() as unknown as Record<string, unknown>
      delete cfg[field]
      expect(errorsOf(cfg).join()).toContain(`${field} must be a list`)
    }
  })

  it('names a duplicate source or channel id', () => {
    expect(bad((c) => c.channels.push({ id: 'webhook', type: 'webhook', urlEnv: 'X' }))).toContain('duplicate id webhook')
  })

  it('requires an id on every source and channel', () => {
    expect(bad((c) => c.channels.push({ id: '', type: 'webhook', urlEnv: 'X' }))).toContain('needs an id')
  })

  it('names a route that points at a channel the config does not have', () => {
    expect(bad((c) => (c.routes[0].receivers = ['pager']))).toContain('route page names unknown channel pager')
  })

  it('checks a route escalation and its record list against the channels too', () => {
    expect(bad((c) => (c.routes[0].escalate = [{ afterSec: 60, receivers: ['pager'] }]))).toContain('unknown channel pager')
    expect(bad((c) => (c.routes[1].record = ['pager']))).toContain('unknown channel pager')
  })

  it('checks a brand, an embed origin and a port', () => {
    expect(bad((c) => (c.brand = { name: '' }))).toContain('brand.name')
    expect(bad((c) => (c.brand = { name: 'ok', shortName: 'x'.repeat(25) }))).toContain('brand.shortName')
    expect(bad((c) => (c.embedOrigins = ['https://chat.example.com/panel']))).toContain('embedOrigins')
    expect(bad((c) => (c.port = 70000))).toContain('port')
    expect(bad((c) => (c.port = 0))).toBe('')
    expect(bad((c) => (c.host = ''))).toContain('host')
  })

  it('checks coalesce: whole numbers in range, an object otherwise', () => {
    expect(bad((c) => (c.routes[0].coalesce = { maxPages: -1 }))).toContain('coalesce.maxPages')
    expect(bad((c) => (c.routes[0].coalesce = { windowSec: 10 }))).toContain('coalesce.windowSec')
    expect(bad((c) => (c.routes[0].coalesce = 'on' as never))).toContain('coalesce must be an object')
  })

  it('checks severityCaps: a matcher that narrows, a compiling regex, a cap that caps, and a one-line note', () => {
    expect(bad((c) => (c.severityCaps = [{ match: { rule: '[' }, max: 'warning', note: 'x' }]))).toContain('severityCaps[0].match.rule')
    expect(bad((c) => (c.severityCaps = [{ match: {}, max: 'warning', note: 'x' }]))).toContain('would cap every alert')
    expect(bad((c) => (c.severityCaps = [{ match: { rule: 'x' }, max: 'page' as never, note: 'x' }]))).toContain('max must be warning or info')
    expect(bad((c) => (c.severityCaps = [{ match: { rule: 'x' }, max: 'warning', note: 'a\nb' }]))).toContain('one line')
  })

  it('checks splitIncidents and inferredCellExclude', () => {
    expect(bad((c) => (c.splitIncidents = [{ match: { origin: 'x' }, by: '' }]))).toContain('splitIncidents entry needs a `by` label')
    expect(bad((c) => (c.inferredCellExclude = [{ note: 'why' }]))).toContain('inferredCellExclude entry needs an origin or a rule')
  })

  it('checks wallGroups once, through checkWallGroups', () => {
    expect(bad((c) => (c.wallGroups = [{ id: 'other', label: 'Other', services: ['api'] }]))).toContain('wallGroups')
    expect(() => checkWallGroups([{ id: 'a', label: 'A', services: ['api', 'api'] }])).toThrow()
  })

  it('checks an http-probe target: id, service, URL, JSON expectation and certificate tiers', () => {
    const target = (over: Record<string, unknown>) => bad((c) => {
      const s = c.sources.find((x) => x.type === 'http-probe')
      if (s?.type !== 'http-probe') throw new Error('no probe')
      Object.assign(s.targets[0], over)
    })
    expect(target({ id: 'bad id' })).toContain('targets[0].id')
    expect(target({ service: '' })).toContain('targets[0].service')
    expect(target({ url: 'http://example.com/healthz' })).toContain('targets[0].url')
    expect(target({ expectJson: { 'a..b': 'x' } })).toContain('expectJson')
    expect(target({ certWarnDays: 2, certPageDays: 3 })).toContain('certPageDays')
    expect(target({ expectStatus: 42 })).toContain('expectStatus')
  })

  it('checks a vmalert and a feed source', () => {
    expect(bad((c) => c.sources.push({ id: 'vm', type: 'vmalert', url: 'http://127.0.0.1:8428', pollSec: 0 }))).toContain('needs a pollSec above 0')
    expect(bad((c) => c.sources.push({ id: 'f', type: 'feed', url: 'http://example.com/alerts', tokenEnv: 'T' }))).toContain('needs a url that is https')
    expect(bad((c) => c.sources.push({ id: 'f2', type: 'feed', url: 'https://example.com/alerts', tokenEnv: '' }))).toContain('needs a tokenEnv')
  })

  it('checks a sentry source: an org, https URLs, projects and a crash-free band', () => {
    const sentry = (over: Record<string, unknown>) => bad((c) => c.sources.push({ id: 's', type: 'sentry', url: 'https://sentry.io', webUrl: 'https://example.sentry.io', org: 'example', tokenEnv: 'T', pollSec: 60, projects: { app: 'App' }, ...over } as never))
    expect(sentry({ org: '' })).toContain('needs an org')
    expect(sentry({ url: 'http://sentry.io' })).toContain('needs an https url')
    expect(sentry({ projects: {} })).toContain('needs projects')
    expect(sentry({ crashFreeWarnBelow: 0.9, crashFreePageBelow: 0.95 })).toContain('crashFreePageBelow')
    expect(sentry({ devReleases: '[' })).toContain('devReleases is not a regular expression')
  })

  it('checks a Netdata Cloud source: space, room, nodes, contexts and the disk floor', () => {
    const cloud = (over: Record<string, unknown>) => bad((c) => c.sources.push({ id: 'nd', type: 'netdata-cloud', url: 'https://app.netdata.cloud', tokenEnv: 'T', spaceId: 's', roomId: 'r', pollSec: 60, fleetNodes: ['node-1'], ...over } as never))
    expect(cloud({ roomId: '' })).toContain('needs a spaceId and a roomId')
    expect(cloud({ fleetNodes: 'node-1' as never })).toContain('fleetNodes')
    expect(cloud({ groups: [{ id: 'g', name: 'G', contexts: ['*'], alerts: ['x'] }] })).toContain('never "*"')
    expect(cloud({ groups: [{ id: 'g', name: 'G', contexts: ['disk.space'], alerts: [] }] })).toContain('needs alerts')
    expect(cloud({ diskWarningFloor: { usedPct: 101, note: 'x' } })).toContain('diskWarningFloor.usedPct')
  })

  it('checks a Netdata fleet source: the window and the hysteresis of every rule', () => {
    const fleet = (over: Record<string, unknown>) => bad((c) => c.sources.push({ id: 'nf', type: 'netdata-fleet', url: 'https://app.netdata.cloud', tokenEnv: 'T', spaceId: 's', roomId: 'r', pollSec: 60, fleetNodes: ['node-1'], ...over } as never))
    expect(fleet({ windowMin: 10 })).toContain('windowMin')
    expect(fleet({ rules: { cpu: { warnAbove: 70, clearBelow: 80, forMin: 5 } } })).toContain('clearBelow must be under warnAbove')
    expect(fleet({ rules: { load: { warnAbove: 1, clearBelow: 0.5, forMin: 999 } } })).toContain('forMin')
    expect(fleet({ rules: { memory: { warnAbove: 80, clearBelow: 70, pageAbove: 70, pageClearBelow: 60, forMin: 5 } } })).toContain('pageAbove must not be under warnAbove')
  })

  it('checks the Netdata host lists of a webhook source and of the cloud source', () => {
    expect(bad((c) => {
      const s = c.sources.find((x) => x.type === 'webhook')
      if (s?.type === 'webhook') s.netdata = { grafanaDiskHosts: ['not a host'] }
    })).toContain('netdata.grafanaDiskHosts')
    expect(bad((c) => c.sources.push({ id: 'nd2', type: 'netdata-cloud', url: 'https://app.netdata.cloud', tokenEnv: 'T', spaceId: 's', roomId: 'r', pollSec: 60, fleetNodes: [], grafanaDiskHosts: ['a b'] }))).toContain('grafanaDiskHosts')
  })

  it('refuses a recheckRequests block on anything but a webhook source, and a pickup outside 30..3600', () => {
    expect(bad((c) => {
      const s = c.sources.find((x) => x.type === 'http-probe')
      if (s) (s as unknown as { recheckRequests?: unknown }).recheckRequests = { pickupWithinSec: 60 }
    })).toContain('recheckRequests is only for a webhook source')
    expect(bad((c) => {
      const s = c.sources.find((x) => x.type === 'webhook')
      if (s?.type === 'webhook') s.recheckRequests = { pickupWithinSec: 5 }
    })).toContain('pickupWithinSec')
  })

  it('lets a source type it does not know through the checks it never reaches', () => {
    expect(bad((c) => c.sources.push({ id: 'x', type: 'carrier-pigeon' } as never))).toBe('')
    expect(errorsOf(clone())).toEqual([])
  })
})

const CLEAR = ['http://127.0.0.1:3000/healthz', 'http://localhost:3000/', 'http://10.0.0.5/', 'http://192.168.1.4/', 'http://100.64.1.2/', 'https://api.example.com/healthz']
const REFUSED = ['http://example.com/healthz', 'http://user:pass@127.0.0.1/', 'not a url', 'ftp://127.0.0.1/', 'http://172.32.0.1/', 'http://100.128.0.1/']

describe.each(CLEAR)('a request in the clear to %s', (url) => {
  it('is allowed', () => expect(probeUrlAllowed(url)).toBe(true))
})

describe.each(REFUSED)('a request to %s', (url) => {
  it('is refused, or only allowed over https', () => expect(probeUrlAllowed(url)).toBe(false))
})

describe('plainHttpAllowed', () => {
  it('allows loopback, RFC 1918 and the CGNAT range', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '100.64.0.1', '100.127.255.255']) expect(plainHttpAllowed(host), host).toBe(true)
  })

  it('refuses a public address, a name and an out-of-range octet', () => {
    for (const host of ['8.8.8.8', 'example.com', '172.32.0.1', '100.128.0.1', '256.1.1.1']) expect(plainHttpAllowed(host), host).toBe(false)
  })
})

describe('a config the example proves', () => {
  it('accepts the recheckRequests range at both ends', () => {
    const at = (sec: number) => bad((c) => {
      const s = c.sources.find((x) => x.type === 'webhook')
      if (s?.type === 'webhook') s.recheckRequests = { pickupWithinSec: sec }
    })
    expect(at(30)).toBe('')
    expect(at(3600)).toBe('')
    expect(at(29)).toContain('pickupWithinSec')
    expect(at(3601)).toContain('pickupWithinSec')
  })

  it('accepts a wall-only route: empty receivers, matching, so later routes do not', () => {
    expect(bad((c) => (c.routes[0].receivers = []))).toBe('')
  })

  it('accepts a continue route and an escalation of a channel that exists', () => {
    expect(bad((c) => {
      c.routes[0].continue = true
      c.routes[0].escalate = [{ afterSec: 600, receivers: ['hook'] }]
    })).toBe('')
  })

  it('accepts a target that expects a 3xx, and refuses 99 and 600', () => {
    const at = (status: number) => bad((c) => {
      const s = c.sources.find((x) => x.type === 'http-probe')
      if (s?.type === 'http-probe') s.targets[0].expectStatus = status
    })
    expect(at(302)).toBe('')
    expect(at(99)).toContain('expectStatus')
    expect(at(600)).toContain('expectStatus')
  })

  it('accepts a slow threshold under the timeout and refuses one over it', () => {
    const at = (slowMs: number, timeoutMs: number) => bad((c) => {
      const s = c.sources.find((x) => x.type === 'http-probe')
      if (s?.type === 'http-probe') Object.assign(s.targets[0], { slowMs, timeoutMs })
    })
    expect(at(500, 1000)).toBe('')
    expect(at(1000, 1000)).toContain('slowMs')
  })

  it('accepts a JSON expectation of strings, numbers and booleans, and refuses an object', () => {
    const at = (value: unknown) => bad((c) => {
      const s = c.sources.find((x) => x.type === 'http-probe')
      if (s?.type === 'http-probe') s.targets[0].expectJson = { a: value as never }
    })
    expect(at('x')).toBe('')
    expect(at(1)).toBe('')
    expect(at(true)).toBe('')
    expect(at({})).toContain('must be a string, a number or true or false')
  })

  it('accepts a wall group that lists one service, and refuses a duplicated service inside one', () => {
    expect(bad((c) => (c.wallGroups = [{ id: 'a', label: 'A', services: ['api'] }]))).toBe('')
    expect(bad((c) => (c.wallGroups = [{ id: 'a', label: 'A', services: ['api', 'API'] }]))).toContain('in two places')
  })

  it('accepts a severity cap with a label matcher and refuses one with an empty label name', () => {
    expect(bad((c) => (c.severityCaps = [{ match: { labels: { service: '^worker$' } }, max: 'info', note: 'worker is chatty' }]))).toBe('')
    expect(bad((c) => (c.severityCaps = [{ match: { labels: { '': 'x' } }, max: 'info', note: 'x' }]))).toContain('empty name')
  })

  it('accepts a split rule by a label and refuses an unparsable coalesce window', () => {
    expect(bad((c) => (c.splitIncidents = [{ match: { rule: 'ProbeDown' }, by: 'instance' }]))).toBe('')
    expect(bad((c) => (c.routes[0].coalesce = { windowSec: 1.5 }))).toContain('coalesce.windowSec')
  })

  it('reports the first problem and never a second config from the same object', () => {
    const cfg = clone()
    cfg.channels.push({ id: 'webhook', type: 'webhook', urlEnv: 'X' })
    cfg.routes[0].receivers = ['pager']
    const out = validateConfig(cfg)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.errors).toHaveLength(1)
  })
})
