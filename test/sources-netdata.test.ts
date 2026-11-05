import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/server/app.ts'
import type { AppDeps } from '../src/server/app.ts'
import { loadConfig } from '../src/server/config.ts'
import type { WatchConfig } from '../src/server/config.ts'
import { matchService } from '../src/server/derive.ts'
import { openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'
import { matchedRoutes } from '../src/server/notify/match.ts'
import {
  UNKNOWN_HOST,
  canonicalHost,
  diskRule as diskRuleAt,
  hostOf,
  ignoredBy,
  isDiskCapacity,
  netdataPayloadKind
} from '../src/server/sources/netdata.ts'
import { DEFAULT_IGNORE_INSTANCES } from '../src/server/sources/netdata-cloud.ts'

/** The operator's own host lists: config in production, a fixed pair here. */
const GRAFANA_DISK_HOSTS = ['node-1', 'node-2', 'node-4', 'node-5', 'node-6']
const NETDATA_HOSTS = ['node-1', 'node-2', 'node-3', 'node-4', 'node-5']
const diskRule = (host: string, alert: string, level: 'warning' | 'critical', hosts: readonly string[] = GRAFANA_DISK_HOSTS) => diskRuleAt(host, alert, level, hosts)
import { BadPayload, normalizeWebhook } from '../src/server/sources/webhook.ts'
import type { SourceDeps } from '../src/server/sources/types.ts'
import { SqlitePushStore } from '../src/server/stores.ts'
import { makeAlert } from '../src/server/derive.ts'
import { severityOf } from '../src/shared/incident.ts'
import type { Alert, Observation } from '../src/shared/types.ts'

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))
const fixture = JSON.parse(readFileSync(here('./fixtures/netdata-webhook.json'), 'utf8')) as {
  verification: Record<string, unknown>
  alerts: Record<string, Record<string, unknown>>
  reachability: Record<string, Record<string, unknown>>
}
const A = fixture.alerts
const cfg: WatchConfig = loadConfig(here('./fixtures/watch.config.json'))

const T0 = Date.parse('2026-10-15T14:35:00.000Z')
let clock = T0
const iso = (ms = clock): string => new Date(ms).toISOString()
let logs: string[]

function deps(over: Partial<SourceDeps> = {}): SourceDeps {
  return {
    fetch: (() => {
      throw new Error('a webhook never fetches')
    }) as unknown as typeof fetch,
    env: {},
    nowIso: () => iso(),
    serviceMap: cfg.serviceMap,
    log: (line) => logs.push(line),
    ...over
  }
}
const NETDATA_CFG = { grafanaDiskHosts: GRAFANA_DISK_HOSTS, netdataHosts: NETDATA_HOSTS }
const ingest = (payload: unknown, source = 'netdata'): Observation => normalizeWebhook(payload, { source, deps: deps(), netdata: NETDATA_CFG })
const only = (o: Observation): Alert => {
  expect(o.firing).toHaveLength(1)
  return o.firing[0]
}

beforeEach(() => {
  clock = T0
  logs = []
})

describe('diskRule: the Netdata disk-capacity alert and the Grafana rule it shares an incident with', () => {
  const titles = (host: string) => ({
    imminent: `Host disk full imminent (${host})`,
    filling: `Host disk filling up (${host})`,
    low: `Host disk space low (${host})`
  })

  it.each(['node-1', 'node-2', 'node-4', 'node-5'])('%s has Grafana disk rules: disk_space_usage and out_of_disk_space_time take the title of the tier of the same meaning', (h) => {
    const t = titles(h)
    expect(diskRule(h, 'disk_space_usage', 'critical')).toEqual({ rule: t.imminent, tier: 'imminent', family: 'space' })
    expect(diskRule(h, 'disk_space_usage', 'warning')).toEqual({ rule: t.low, tier: 'low', family: 'space' })
    expect(diskRule(h, 'out_of_disk_space_time', 'critical')).toEqual({ rule: t.imminent, tier: 'imminent', family: 'space' })
    expect(diskRule(h, 'out_of_disk_space_time', 'warning')).toEqual({ rule: t.filling, tier: 'filling', family: 'space' })
  })

  it('node-3 has no Grafana disk rule: its space alerts stand alone under one incident per host', () => {
    for (const alert of ['disk_space_usage', 'out_of_disk_space_time'])
      for (const level of ['warning', 'critical'] as const) expect(diskRule('node-3', alert, level)).toEqual({ rule: 'Netdata: disk space (node-3)', tier: null, family: 'space' })
  })

  it('inode alerts never join a Grafana rule (Grafana has none): own incident per host, on every host', () => {
    for (const h of NETDATA_HOSTS)
      for (const alert of ['disk_inode_usage', 'out_of_disk_inodes_time']) expect(diskRule(h, alert, 'critical')).toEqual({ rule: `Netdata: disk inodes (${h})`, tier: null, family: 'inodes' })
  })

  it('a host outside the fleet passes through unchanged, as its own incident', () => {
    expect(diskRule('build-box-2', 'disk_space_usage', 'critical')).toEqual({ rule: 'Netdata: disk space (build-box-2)', tier: null, family: 'space' })
    expect(diskRule(UNKNOWN_HOST, 'disk_space_usage', 'warning')?.tier).toBeNull()
  })

  it('reads a fully qualified fleet host as the fleet host', () => {
    expect(diskRule('Node-5.example.net', 'disk_space_usage', 'critical', GRAFANA_DISK_HOSTS)?.rule).toBe('Host disk full imminent (node-5)')
    expect(canonicalHost('node-3.example.net', NETDATA_HOSTS)).toBe('node-3')
    expect(canonicalHost('`build-box.example.com`')).toBe('build-box.example.com')
  })

  it('is null for an alert that is not about capacity, and only the four capacity alerts count as disk-full', () => {
    for (const alert of ['ram_in_use', '10min_disk_backlog', 'disk_fill_rate', 'mdstat_disks']) {
      expect(diskRule('node-5', alert, 'critical')).toBeNull()
      expect(isDiskCapacity(alert)).toBe(false)
    }
    for (const alert of ['disk_space_usage', 'out_of_disk_space_time', 'disk_inode_usage', 'out_of_disk_inodes_time']) expect(isDiskCapacity(alert)).toBe(true)
  })

  it("agrees with the Grafana rules in the fixture rule set: every title it produces exists, and the hosts are exactly those that have all three", () => {
    const rules = (JSON.parse(readFileSync(here('./fixtures/api-alert-rules.json'), 'utf8')) as { rules: { title: string }[] }).rules
    const titlesSeen = new Set(rules.map((r) => r.title))
    const hostsWith = (re: RegExp): string[] => rules.flatMap((r) => (re.exec(r.title)?.[1] ? [re.exec(r.title)![1]] : []))
    const imminent = hostsWith(/^Host disk full imminent \(([a-z0-9-]+)\)$/)
    const filling = hostsWith(/^Host disk filling up \(([a-z0-9-]+)\)$/)
    const low = hostsWith(/^Host disk space low \(([a-z0-9-]+)\)$/)
    expect([...GRAFANA_DISK_HOSTS].sort()).toEqual(imminent.filter((h) => filling.includes(h) && low.includes(h)).sort())
    for (const h of GRAFANA_DISK_HOSTS) for (const alert of ['disk_space_usage', 'out_of_disk_space_time'])
      for (const level of ['warning', 'critical'] as const) expect(titlesSeen.has(diskRule(h, alert, level)!.rule), `${h} ${alert} ${level}`).toBe(true)
    expect(imminent).not.toContain('node-3')
    expect(NETDATA_HOSTS).toEqual(['node-1', 'node-2', 'node-3', 'node-4', 'node-5'])
  })
})

describe('telling the three Netdata bodies apart', () => {
  it('knows an alert, a reachability change and a verification body', () => {
    expect(netdataPayloadKind(A.s3DiskSpaceCritical)).toBe('alert')
    expect(netdataPayloadKind(fixture.reachability.s2Unreachable)).toBe('reachability')
    expect(netdataPayloadKind(fixture.verification)).toBe('verification')
  })

  it('a token wins over alert-looking fields: a Test notification never becomes an alert', () => {
    expect(netdataPayloadKind({ ...A.s3DiskSpaceCritical, token: 'x' })).toBe('verification')
  })

  it('is none of them for an Alertmanager-like body, an empty object, and an alert missing its severity', () => {
    expect(netdataPayloadKind({})).toBeNull()
    expect(netdataPayloadKind({ version: '4', receiver: 'x' })).toBeNull()
    expect(netdataPayloadKind({ alert: 'disk_space_usage', chart: 'x' })).toBeNull()
    expect(netdataPayloadKind({ alert: 7, severity: 'critical', chart: 'x' })).toBeNull()
  })
})

describe('which node an alert is about: the payload table has no host field, so it is read defensively', () => {
  const base = { alert: 'ram_in_use', chart: 'system.ram', severity: 'warning', alert_url: 'https://app.netdata.cloud/x' }

  it('takes a host field when there is one, in any of the usual spellings', () => {
    expect(hostOf({ ...base, host: 'build-box' })).toEqual({ host: 'build-box', from: 'field' })
    expect(hostOf({ ...base, hostname: 'node-4.example.net' }, NETDATA_HOSTS)).toEqual({ host: 'node-4', from: 'field' })
    expect(hostOf({ ...base, node: { hostname: 'ml-1' } })).toEqual({ host: 'ml-1', from: 'field' })
  })

  it.each([
    ['disk_space_usage on node-3 is critical: 98.9% used', 'node-3'],
    ['Critical: ram_in_use on node-2.example.net (system.ram)', 'node-2'],
    ['**node-5** is critical, 98% used', 'node-5'],
    ['ram_in_use on `build-box.example.com` is critical', 'build-box.example.com'],
    ['host: ml-gpu-1 / ram_in_use critical', 'ml-gpu-1'],
    ['ram_in_use is critical on node ml-gpu-2 for 5m', 'ml-gpu-2'],
    ['Alert is critical on average for 5 minutes on app-7', 'app-7']
  ])('finds the node in the message %j', (message, host) => {
    expect(hostOf({ ...base, message }, NETDATA_HOSTS)).toEqual({ host, from: 'message' })
  })

  it('falls back to a clearly labelled unknown host rather than guessing a word of the sentence', () => {
    for (const message of ['', 'The alert is critical on average', 'disk usage is above 90% on the system', 'Something happened']) {
      expect(hostOf({ ...base, message })).toEqual({ host: UNKNOWN_HOST, from: 'unknown' })
    }
    expect(UNKNOWN_HOST).toBe('unknown host')
  })

  it('labels where the name came from, so a wrong guess can be told from a field', () => {
    expect(only(ingest({ ...base, message: 'ram_in_use on node-2 is critical' })).labels.netdata_host_from).toBe('message')
    expect(only(ingest({ ...base, host: 'node-2' })).labels.netdata_host_from).toBe('field')
    const lost = only(ingest({ ...base, message: 'nothing useful here' }))
    expect(lost.labels.netdata_host_from).toBe('unknown')
    expect(lost.host).toBe(UNKNOWN_HOST)
    expect(lost.annotations.where).toContain('named no node')
  })
})

describe('an alert becomes a Watch alert', () => {
  it('node-3 disk space critical: a page, on the Host disks tile, its own incident, origin netdata', () => {
    const o = ingest(A.s3DiskSpaceCritical)
    const a = only(o)
    expect(o).toMatchObject({ source: 'netdata', kind: 'webhook', complete: false, resolved: [] })
    expect(a).toMatchObject({
      origin: 'netdata',
      rule: 'Netdata: disk space (node-3)',
      service: 'Host disks',
      host: 'node-3',
      severity: 'page',
      severityLabel: 'critical',
      startsAt: '2026-10-15T14:00:00.000Z',
      generatorURL: 'https://app.netdata.cloud/spaces/the operator-space/rooms/all-nodes/alerts/constructed-0001',
      resolvedAt: null
    })
    expect(a.key).toMatch(/^netdata:[0-9a-f]{8}$/)
    expect(a.labels).toMatchObject({ alertname: 'disk_space_usage', component: 'host-disk', chart: 'disk_space./', mountpoint: '/', netdata_severity: 'critical', netdata_space: 'Example space', netdata_rooms: 'All nodes' })
    expect(a.annotations.summary).toBe('Disk space usage on node-3 (/) is critical')
    expect(a.annotations.description).toContain('98.9% used')
    expect(a.annotations.netdata_other_warning).toBe('1')
    expect(a.links.generator).toBe(a.generatorURL)
    expect(a.raw).toEqual(A.s3DiskSpaceCritical)
  })

  it('says how the alert reached Watch: a Cloud relay names its space, a push from the agent itself does not', () => {
    expect(only(ingest(A.s5DiskSpaceCritical)).annotations.where).toContain('Raised through Netdata Cloud, space Example space')
    const local = { ...A.s5DiskSpaceCritical }
    delete local.space
    const where = only(ingest(local)).annotations.where
    expect(where).toContain('Raised by the Netdata agent that sent this notification')
    expect(where).not.toContain('Netdata Cloud')
  })

  it('node-5 disk space critical joins the Grafana "full imminent" incident title and resolves the lower tier it leaves', () => {
    const o = ingest(A.s5DiskSpaceCritical)
    const a = only(o)
    expect(a).toMatchObject({ rule: 'Host disk full imminent (node-5)', service: 'Host disks', severity: 'page', host: 'node-5' })
    expect(a.labels.mountpoint).toBe('/var/lib/docker')
    expect(o.resolved).toHaveLength(1)
    expect(o.resolved[0]).toMatchObject({ rule: 'Host disk space low (node-5)', resolvedAt: '2026-10-15T14:10:00.000Z', endsAt: '2026-10-15T14:10:00.000Z' })
  })

  it('moving down to warning fires the lower-tier incident and resolves the page one, with the same keys both ways', () => {
    const crit = only(ingest(A.s5DiskSpaceCritical))
    const down = ingest(A.s5DiskSpaceWarning)
    const warn = only(down)
    expect(warn).toMatchObject({ rule: 'Host disk space low (node-5)', severity: 'warning', severityLabel: 'warning' })
    expect(down.resolved.map((r) => r.key)).toEqual([crit.key])
    expect(warn.key).not.toBe(crit.key)
    // and the clear closes whichever is open
    const clear = ingest(A.s5DiskSpaceClear)
    expect(clear.firing).toEqual([])
    expect(clear.resolved.map((r) => r.key).sort()).toEqual([crit.key, warn.key].sort())
    expect(clear.resolved.every((r) => r.resolvedAt === '2026-10-15T15:00:00.000Z')).toBe(true)
  })

  it('the key is stable per node, alert and chart: a resend is the same alert, another chart or node is not', () => {
    const k = only(ingest(A.s3DiskSpaceCritical)).key
    expect(only(ingest({ ...A.s3DiskSpaceCritical, date: '2026-10-15T14:05:00.000Z', duration: '7m' })).key).toBe(k)
    expect(only(ingest({ ...A.s3DiskSpaceCritical, chart: 'disk_space./tmp' })).key).not.toBe(k)
    expect(only(ingest({ ...A.s3DiskSpaceCritical, message: 'disk_space_usage on node-1 is critical' })).key).not.toBe(k)
    expect(only(ingest(A.s3DiskFillWarning)).key).not.toBe(k)
  })

  it('out_of_disk_space_time on node-3 is a warning in the same incident as node-3 disk space usage', () => {
    const w = only(ingest(A.s3DiskFillWarning))
    expect(w).toMatchObject({ rule: 'Netdata: disk space (node-3)', severity: 'warning', service: 'Host disks' })
  })

  it('inode exhaustion pages as a disk-full class, in its own incident per host', () => {
    expect(only(ingest(A.s3InodesCritical))).toMatchObject({ rule: 'Netdata: disk inodes (node-3)', severity: 'page', service: 'Host disks', labels: expect.objectContaining({ mountpoint: '/tmp' }) })
  })

  it('every other critical is a warning: a RAM critical never pages, and says why', () => {
    const a = only(ingest(A.s2RamCritical))
    expect(a).toMatchObject({ rule: 'Netdata: ram_in_use', service: 'Netdata', host: 'node-2', severity: 'warning', severityLabel: 'warning' })
    expect(a.labels.netdata_severity).toBe('critical')
    expect(a.annotations.netdata_demoted).toContain('warning')
    expect(a.annotations.summary).toBe('Ram in use on node-2 (system.ram) is critical')
  })

  it('a disk-health alert that is not capacity (md, backlog, smart) is a warning on the Host disks tile', () => {
    const a = only(ingest(A.s4BacklogWarning))
    expect(a).toMatchObject({ rule: 'Netdata: 10min_disk_backlog', service: 'Host disks', host: 'node-4', severity: 'warning' })
    for (const alert of ['mdstat_disks', 'smartctl_overall_health', 'md_mismatch_cnt']) {
      expect(only(ingest({ ...A.s4BacklogWarning, alert, severity: 'critical', chart: `x.${alert}`, context: 'md.health' }))).toMatchObject({ service: 'Host disks', severity: 'warning' })
    }
  })

  it('clear resolves, for an alert Watch never saw as well (the engine ignores a resolve it holds no firing alert for)', () => {
    const o = ingest({ ...A.s2RamCritical, severity: 'clear' })
    expect(o.firing).toEqual([])
    expect(o.resolved).toHaveLength(1)
    expect(o.resolved[0]).toMatchObject({ rule: 'Netdata: ram_in_use', resolvedAt: '2026-10-15T14:20:00.000Z' })
  })

  it('an unknown severity word is a warning: shown, never a page', () => {
    expect(only(ingest({ ...A.s3DiskSpaceCritical, severity: 'panic' }))).toMatchObject({ severity: 'warning' })
    expect(only(ingest({ ...A.s2RamCritical, severity: 'Warn' }))).toMatchObject({ severity: 'warning' })
  })

  it('uses the time of the notification when the date is missing or junk, and clips oversized text', () => {
    expect(only(ingest({ ...A.s2RamCritical, date: 'yesterday-ish' })).startsAt).toBe(iso())
    const a = only(ingest({ ...A.s2RamCritical, message: 'x'.repeat(5000), info: 'y'.repeat(5000), Rooms: 'not an object', additional_active_warning_alerts: 'many' }))
    expect(a.annotations.description.length).toBeLessThanOrEqual(600)
    expect(a.labels.netdata_rooms).toBeUndefined()
    expect(a.annotations.netdata_other_warning).toBeUndefined()
  })

  it('does not link a URL that is not http(s)', () => {
    const a = only(ingest({ ...A.s2RamCritical, alert_url: 'javascript:alert(1)' }))
    expect(a.generatorURL).toBeUndefined()
    expect(a.links.generator).toBeUndefined()
  })

  it('takes the origin from the source, never from X-Alert-Source', () => {
    const o = normalizeWebhook(A.s3DiskSpaceCritical, { source: 'netdata', headerSource: 'dev', deps: deps(), netdata: NETDATA_CFG })
    expect(o.firing[0].origin).toBe('netdata')
  })
})

describe('reachability', () => {
  it('an unreachable node is a page on the Netdata tile, keyed by node', () => {
    const a = only(ingest(fixture.reachability.s2Unreachable))
    expect(a).toMatchObject({ rule: 'Netdata: node unreachable', service: 'Netdata', host: 'node-2', severity: 'page', origin: 'netdata' })
    expect(a.labels.alertname).toBe('NetdataNodeUnreachable')
    expect(a.annotations.where).toContain('not proof the machine is down')
    expect(a.generatorURL).toContain('/nodes/constructed-node-node-2')
  })

  it('reachable again resolves the same alert', () => {
    const down = only(ingest(fixture.reachability.s2Unreachable))
    const up = ingest(fixture.reachability.s2Reachable)
    expect(up.firing).toEqual([])
    expect(up.resolved.map((r) => r.key)).toEqual([down.key])
    expect(up.resolved[0].resolvedAt).toBe(iso())
  })

  it('reads the node from the message when the host field is missing', () => {
    const a = only(ingest({ ...fixture.reachability.s2Unreachable, host: undefined, message: 'Node node-4 is unreachable' }))
    expect(a.host).toBe('node-4')
  })
})

describe('a Test notification', () => {
  it('marks the source heard, makes no alert, and writes the verification token to the log for the operator', () => {
    const o = ingest(fixture.verification)
    expect(o).toMatchObject({ source: 'netdata', firing: [], resolved: [], complete: false })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(String(fixture.verification.token))
    expect(logs[0]).toContain('["message","token"]')
  })

  it('works without a logger', () => {
    expect(() => normalizeWebhook(fixture.verification, { source: 'netdata', deps: deps({ log: undefined }) })).not.toThrow()
  })
})

describe('a body that is not a Netdata one is still a bad payload, and the log names its fields, never its values', () => {
  it('rejects an unknown object and logs only keys', () => {
    expect(() => ingest({ hello: 'world-secret-value', nested: { a: 1 } })).toThrow(BadPayload)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('["hello","nested"]')
    expect(logs[0]).not.toContain('world-secret-value')
  })

  it('keeps the Alertmanager and Grafana rejections as they were', () => {
    expect(() => ingest({ alerts: [{ status: 'firing', labels: {} }], receiver: 'x' })).toThrow('payload is neither an Alertmanager v4 nor a Grafana webhook')
  })
})

// ---- the wall: dedupe against Grafana, and who is paged ------------------------------------------------

let engine: Engine
beforeEach(() => {
  engine = new Engine(openDb(':memory:'), cfg, () => clock)
})

function grafanaDisk(host: string, title: string, severity: 'page' | 'warn'): Observation {
  const a = makeAlert(
    {
      origin: 'grafana',
      fingerprint: `${host}${title.length}abcdef0123456789`,
      rule: title,
      labels: { alertname: title, component: 'host-disk', host, severity, team: 'api', instance: host },
      annotations: { summary: `/ on ${host} has 4% free` },
      startsAt: iso(clock - 20 * 60_000),
      via: { source: 'grafana', kind: 'grafana', lastSeen: iso() },
      raw: {}
    },
    cfg.serviceMap,
    iso()
  )
  return { source: 'grafana', kind: 'grafana', at: iso(), firing: [a], resolved: [], complete: true }
}
const incidents = () => engine.wall().incidents.map((i) => ({ key: i.key, origins: i.alerts.map((a) => a.origin).sort(), severity: i.severity }))

describe('one fault is one incident: a Netdata disk alert and the Grafana rule of the same tier', () => {
  it('Netdata critical on node-5 and the Grafana "full imminent" rule firing are one incident with two alerts, in either order', () => {
    engine.ingest(ingest(A.s5DiskSpaceCritical))
    expect(incidents()).toEqual([{ key: 'Host disks|Host disk full imminent (node-5)', origins: ['netdata'], severity: 'page' }])
    engine.ingest(grafanaDisk('node-5', 'Host disk full imminent (node-5)', 'page'))
    expect(incidents()).toEqual([{ key: 'Host disks|Host disk full imminent (node-5)', origins: ['grafana', 'netdata'], severity: 'page' }])

    const other = new Engine(openDb(':memory:'), cfg, () => clock)
    other.ingest(grafanaDisk('node-5', 'Host disk full imminent (node-5)', 'page'))
    other.ingest(ingest(A.s5DiskSpaceCritical))
    expect(other.wall().incidents.map((i) => [i.key, i.alerts.length])).toEqual([['Host disks|Host disk full imminent (node-5)', 2]])
  })

  it('a warning joins "space low", not "full imminent": tiers do not mix', () => {
    engine.ingest(grafanaDisk('node-5', 'Host disk full imminent (node-5)', 'page'))
    engine.ingest(ingest(A.s5DiskSpaceWarning))
    expect(incidents().map((i) => i.key).sort()).toEqual(['Host disks|Host disk full imminent (node-5)', 'Host disks|Host disk space low (node-5)'])
  })

  it('node-3 has no Grafana rule: its alert stands as its own incident, "Netdata: disk space (node-3)", next to the node-5 one', () => {
    engine.ingest(ingest(A.s3DiskSpaceCritical))
    engine.ingest(ingest(A.s5DiskSpaceCritical))
    expect(incidents().map((i) => i.key).sort()).toEqual(['Host disks|Host disk full imminent (node-5)', 'Host disks|Netdata: disk space (node-3)'])
  })

  it('a page that eases to a warning leaves the page incident with a resolved event and moves to the lower incident', () => {
    engine.ingest(ingest(A.s5DiskSpaceCritical))
    clock += 20 * 60_000
    engine.ingest(ingest(A.s5DiskSpaceWarning))
    expect(incidents()).toEqual([{ key: 'Host disks|Host disk space low (node-5)', origins: ['netdata'], severity: 'warning' }])
    expect(engine.history(24).map((h) => h.rule)).toEqual(['Host disk full imminent (node-5)'])
    clock += 20 * 60_000
    engine.ingest(ingest(A.s5DiskSpaceClear))
    expect(incidents()).toEqual([])
    expect(engine.history(24).map((h) => h.rule).sort()).toEqual(['Host disk full imminent (node-5)', 'Host disk space low (node-5)'])
  })

  it('the clear of an alert Watch never saw changes nothing', () => {
    engine.ingest(ingest(A.s5DiskSpaceClear))
    expect(incidents()).toEqual([])
    expect(engine.history(24)).toEqual([])
  })
})

// node-14, 2026-11-02: one user's 10 GiB sandbox volume under /run/box-space went out_of_disk_space_time CRITICAL and the poll source paged
// `Netdata: disk space (node-14)` while node-14's / sat at 47 %. The webhook takes the poll source's own list (DEFAULT_IGNORE_INSTANCES), not a copy.
describe('a chart that is never a host disk (DEFAULT_IGNORE_INSTANCES) raises nothing from the webhook either', () => {
  const SANDBOX_VOLUME = '/run/box-space/box-prod/pvc-00000000-0000-4000-8000-000000000012_desk-usr-00000000-0000-4000-8000-000000000011-space'
  const onS14 = (alert: string, severity: string, chart: string): Record<string, unknown> => ({
    ...A.s3DiskSpaceCritical,
    host: 'node-14',
    message: `${alert} on node-14 is ${severity}`,
    alert,
    severity,
    chart,
    family: chart.replace(/^disk_(?:space|inodes)\./, '')
  })

  it("drops the node-14 sandbox 'space' volume at every level, space or inodes: no alert, only resolves for the incident it could have opened", () => {
    for (const alert of ['disk_space_usage', 'out_of_disk_space_time']) {
      for (const severity of ['warning', 'critical', 'clear']) {
        const o = ingest(onS14(alert, severity, `disk_space.${SANDBOX_VOLUME}`))
        expect(o.firing, `${alert} ${severity}`).toEqual([])
        expect(o.resolved.map((r) => r.rule)).toEqual(['Netdata: disk space (node-14)'])
        expect(o.resolved.every((r) => r.resolvedAt === '2026-10-15T14:00:00.000Z')).toBe(true)
      }
    }
    for (const alert of ['disk_inode_usage', 'out_of_disk_inodes_time']) {
      const o = ingest(onS14(alert, 'critical', `disk_inodes.${SANDBOX_VOLUME}`))
      expect(o.firing).toEqual([])
      expect(o.resolved.map((r) => r.rule)).toEqual(['Netdata: disk inodes (node-14)'])
    }
    expect(logs.at(-1)).toContain(`ignored out_of_disk_inodes_time (critical) on node-14 chart disk_inodes.${SANDBOX_VOLUME}`)
    expect(logs.at(-1)).toContain('sandbox')
  })

  it("still pages for node-14's own mounts: disk_space./, /data/box-space that holds the images, and paths that only look alike", () => {
    for (const chart of ['disk_space./', 'disk_space./data/box-space', 'disk_space./run/box-spaces/x', 'disk_space./data/run/box-space/x']) {
      const a = only(ingest(onS14('out_of_disk_space_time', 'critical', chart)))
      expect(a, chart).toMatchObject({ rule: 'Netdata: disk space (node-14)', service: 'Host disks', host: 'node-14', severity: 'page', severityLabel: 'critical' })
    }
    expect(only(ingest(onS14('disk_inode_usage', 'critical', 'disk_inodes./data/box-space')))).toMatchObject({ rule: 'Netdata: disk inodes (node-14)', severity: 'page' })
  })

  it('is the poll source list: /Volumes, the macOS auxiliary volumes and /snap/ are dropped too, /System/Volumes/Data is not', () => {
    const notes = DEFAULT_IGNORE_INSTANCES.map((r) => r.note)
    for (const [host, chart] of [
      ['mac-a1.example.net', 'disk_space./Volumes/Google Chrome'],
      ['mac-a1.example.net', 'disk_space./System/Volumes/VM'],
      ['node-3', 'disk_space./snap/core20/1974'],
      ['node-14', `disk_space.${SANDBOX_VOLUME}`]
    ] as const) {
      expect(notes, chart).toContain(ignoredBy(host, chart)?.note)
      expect(ingest({ ...A.s3DiskSpaceCritical, host, chart }).firing, chart).toEqual([])
    }
    for (const chart of ['disk_space./System/Volumes/Data', 'disk_space./', 'system.ram', '']) expect(ignoredBy('mac-a1.example.net', chart), chart).toBeUndefined()
    expect(only(ingest({ ...A.s3DiskSpaceCritical, host: 'mac-a1.example.net', chart: 'disk_space./System/Volumes/Data' })).severity).toBe('page')
  })

  it('an alert the volume raised before the rule existed leaves the wall at its next notification, and the node is never paged again for it', () => {
    const [held] = ingest(onS14('out_of_disk_space_time', 'critical', `disk_space.${SANDBOX_VOLUME}`)).resolved
    engine.ingest({ source: 'netdata', kind: 'webhook', at: iso(), firing: [{ ...held, severity: 'page', endsAt: null, resolvedAt: null }], resolved: [], complete: false })
    expect(incidents()).toEqual([{ key: 'Host disks|Netdata: disk space (node-14)', origins: ['netdata'], severity: 'page' }])
    clock += 5 * 60_000
    engine.ingest(ingest(onS14('out_of_disk_space_time', 'critical', `disk_space.${SANDBOX_VOLUME}`)))
    expect(incidents()).toEqual([])
    engine.ingest(ingest(onS14('disk_space_usage', 'critical', `disk_space.${SANDBOX_VOLUME}`)))
    expect(incidents()).toEqual([])
  })
})

describe('the Netdata tile and the unreachable node', () => {
  it('non-disk alerts group on a "Netdata" tile, one incident per alert class across nodes', () => {
    engine.ingest(ingest(A.s2RamCritical))
    engine.ingest(ingest({ ...A.s2RamCritical, message: 'ram_in_use on node-4 is critical' }))
    const w = engine.wall()
    expect(w.incidents.map((i) => [i.service, i.rule, i.alerts.length, i.severity])).toEqual([['Netdata', 'Netdata: ram_in_use', 2, 'warning']])
  })

  it('an unreachable node is a page incident that resolves when the node returns', () => {
    engine.ingest(ingest(fixture.reachability.s2Unreachable))
    expect(incidents()).toEqual([{ key: 'Netdata|Netdata: node unreachable', origins: ['netdata'], severity: 'page' }])
    engine.ingest(ingest(fixture.reachability.s2Reachable))
    expect(incidents()).toEqual([])
  })

  it('the source reads idle until the first body, then ok; it is never stale for being quiet', () => {
    expect(engine.sources().find((s) => s.id === 'netdata')?.state).toBe('idle')
    engine.recordSource('netdata', true, null)
    clock += 30 * 24 * 3600_000
    const s = engine.sources().find((x) => x.id === 'netdata')
    expect(s?.state).toBe('ok')
    expect(engine.wall().header.stale).toBe(false)
  })

  it('a long-lived warning is not dropped for want of a resend inside three days, and is after them', () => {
    engine.ingest(ingest(A.s3DiskFillWarning))
    clock += 2.9 * 24 * 3600_000
    engine.sweep()
    expect(incidents().map((i) => i.key)).toEqual(['Host disks|Netdata: disk space (node-3)'])
    clock += 0.2 * 24 * 3600_000
    engine.sweep()
    expect(incidents()).toEqual([])
  })
})

describe('who is paged (the full config)', () => {
  const phone = new Set(['ntfy', 'webpush', 'sms-telnyx'])
  const reach = (c: WatchConfig, a: Alert): string[] =>
    matchedRoutes(c.routes, { severity: a.severity, origin: a.origin, labels: a.labels }).flatMap((r) => [...r.receivers, ...(r.escalate ?? []).flatMap((e) => e.receivers)])

  describe.each(['watch.json'])('%s', (file) => {
    const c = loadConfig(here('./fixtures/watch.config.json'))
    // A warning is posted to Chat #notifications and stays silent on phones; the dev file has no Chat channel
    const notices = ['hook']
    const alertOf = (payload: Record<string, unknown>): Alert => only(normalizeWebhook(payload, { source: 'netdata', deps: deps({ serviceMap: c.serviceMap }), netdata: NETDATA_CFG }))

    it('registers the source with its own token, no staleness (it pushes on transitions only) and a presence TTL of days', () => {
      const s = c.sources.find((x) => x.id === 'netdata')
      expect(s?.type).toBe('webhook')
      if (s?.type !== 'webhook') return
      expect(s.tokenEnv).toBe('NETDATA_INGEST_TOKEN')
      expect(s.staleAfterSec).toBeUndefined()
      expect(s.presenceTtlSec).toBeGreaterThanOrEqual(2 * 24 * 3600)
      expect(c.sources.filter((x) => x.type === 'webhook' && x.tokenEnv === 'NETDATA_INGEST_TOKEN')).toHaveLength(1)
    })

    it('puts disk alerts on Host disks and everything else on Netdata, with this file own service map', () => {
      expect(alertOf(A.s3DiskSpaceCritical).service).toBe('Host disks')
      expect(alertOf(A.s4BacklogWarning).service).toBe('Host disks')
      expect(alertOf(A.s2RamCritical).service).toBe('Netdata')
      expect(alertOf(fixture.reachability.s2Unreachable).service).toBe('Netdata')
      expect(matchService('netdata', 'Netdata: anything', {}, c.serviceMap)).toBe('Netdata')
    })

    it('pages for a full disk and a dead node, and for nothing else', () => {
      expect(reach(c, alertOf(A.s3DiskSpaceCritical)).some((id) => phone.has(id))).toBe(true)
      expect(reach(c, alertOf(A.s5DiskSpaceCritical)).some((id) => phone.has(id))).toBe(true)
      expect(reach(c, alertOf(A.s3InodesCritical)).some((id) => phone.has(id))).toBe(true)
      expect(reach(c, alertOf(fixture.reachability.s2Unreachable)).some((id) => phone.has(id))).toBe(true)
      // a warning never reaches a phone: it is one post in Chat #notifications or the wall alone
      for (const quiet of [A.s2RamCritical, A.s4BacklogWarning, A.s3DiskFillWarning, A.s5DiskSpaceWarning]) expect(reach(c, alertOf(quiet)), String(quiet.alert)).toEqual(notices)
    })

    it('holds an unreachable page for three minutes first, so an agent that restarts does not page', () => {
      const routes = matchedRoutes(c.routes, { severity: 'page', origin: 'netdata', labels: alertOf(fixture.reachability.s2Unreachable).labels })
      expect(routes[0].id).toBe('netdata-unreachable')
      expect(routes[0].groupWaitSec).toBe(180)
      const disk = matchedRoutes(c.routes, { severity: 'page', origin: 'netdata', labels: alertOf(A.s3DiskSpaceCritical).labels })
      expect(disk[0].id).toBe('page')
      expect(disk[0].groupWaitSec).toBe(0)
    })

    it('a warning from Netdata is a #notifications post and never a phone, whatever Netdata called it (the wall alone in the dev file)', () => {
      for (const label of ['warning', 'critical']) {
        const a = alertOf({ ...A.s2RamCritical, severity: label })
        expect(severityOf(a.labels.severity)).toBe('warning')
        expect(reach(c, a)).toEqual(notices)
        expect(reach(c, a).some((id) => phone.has(id))).toBe(false)
      }
    })
  })
})

// ---- the ingest route ----------------------------------------------------------------------------------

describe('POST /ingest/netdata', () => {
  function appWith(env: NodeJS.ProcessEnv): { app: ReturnType<typeof createApp>; engine: Engine } {
    const db = openDb(':memory:')
    const e = new Engine(db, cfg, () => clock)
    const d: AppDeps = {
      engine: e,
      cfg,
      env,
      db,
      push: new SqlitePushStore(db),
      ackSecret: 'ack',
      webDir: '/nonexistent',
      normalizeWebhook: (payload, ctx) => normalizeWebhook(payload, { ...ctx, deps: deps(), netdata: NETDATA_CFG }),
      testChannel: async () => ({ ok: true, status: 'ok', latencyMs: 1 }),
      nudge: () => undefined,
      vapidPublicKey: null,
      now: () => clock
    }
    return { app: createApp(d), engine: e }
  }
  const post = (app: ReturnType<typeof createApp>, body: unknown, token?: string) =>
    Promise.resolve(app.request('/ingest/netdata', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }))

  it('refuses every request with 401 while NETDATA_INGEST_TOKEN is not set on the host, and nothing crashes or is stored', async () => {
    const { app, engine: e } = appWith({ INGEST_TOKEN: 'the-other-senders-token' })
    expect((await post(app, A.s3DiskSpaceCritical)).status).toBe(401)
    expect((await post(app, A.s3DiskSpaceCritical, 'the-other-senders-token')).status).toBe(401)
    expect((await post(app, A.s3DiskSpaceCritical, 'anything')).status).toBe(401)
    expect(e.wall().incidents).toEqual([])
    expect(e.sources().find((s) => s.id === 'netdata')?.state).toBe('idle')
    expect((await app.request('/healthz')).status).toBe(200)
    expect((await app.request('/api/state')).status).toBe(200)
  })

  it('takes alerts with its own token and not with the shared one', async () => {
    const { app, engine: e } = appWith({ INGEST_TOKEN: 'shared-token-value', NETDATA_INGEST_TOKEN: 'netdata-token-value' })
    expect((await post(app, A.s3DiskSpaceCritical, 'shared-token-value')).status).toBe(401)
    const ok = await post(app, A.s3DiskSpaceCritical, 'netdata-token-value')
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, firing: 1, resolved: 0 })
    expect(e.wall().incidents.map((i) => i.key)).toEqual(['Host disks|Netdata: disk space (node-3)'])
    expect(e.sources().find((s) => s.id === 'netdata')?.state).toBe('ok')
  })

  it('answers a Test notification with 200 so Netdata Cloud can verify, and rejects junk with 400', async () => {
    const { app } = appWith({ NETDATA_INGEST_TOKEN: 'netdata-token-value' })
    expect((await post(app, fixture.verification, 'netdata-token-value')).status).toBe(200)
    expect((await post(app, { nonsense: true }, 'netdata-token-value')).status).toBe(400)
  })
})
