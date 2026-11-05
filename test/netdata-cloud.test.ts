// The Netdata Cloud pull source against responses recorded from the live API (test/fixtures/netdata-cloud-*.json, 2026-10-15) and a fake
// Cloud that serves them. No network. The token in these tests is a stand-in; the point is that it never shows up in a message.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/server/config.ts'
import type { NetdataCloudSourceConfig, NetdataFleetSourceConfig, ServiceRule, WatchConfig } from '../src/server/config.ts'
import { openDb } from '../src/server/db.ts'
import { makeAlert } from '../src/server/derive.ts'
import { matchedRoutes } from '../src/server/notify/match.ts'
import { Engine, incidentKeyOf } from '../src/server/engine.ts'
import {
  DEFAULT_GROUPS,
  classifyNetdataAlert,
  createNetdataCloudSource,
  friendlyAlert,
  groupSelectors,
  instanceDetail,
  locateAlerts,
  netdataPolicyOf,
  nodeIdentity,
  nodeUrl,
  parseData,
  readCloudNodes
} from '../src/server/sources/netdata-cloud.ts'
import { isDiskCapacity } from '../src/server/sources/netdata.ts'
const GRAFANA_DISK_HOSTS = ['node-1', 'node-2', 'node-4', 'node-5', 'node-6']
import type { NetdataFinding, NetdataPolicy } from '../src/server/sources/netdata-cloud.ts'
import type { SourceDeps } from '../src/server/sources/types.ts'
import type { Alert, Observation } from '../src/shared/types.ts'

function fixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
}

const NOW = '2026-10-15T15:16:00.000Z'
// A stand-in value. It must never appear in an error, an alert or an Observation.
const FAKE_TOKEN = 'fake-netdata-token-for-tests-0123456789'
const SPACE = '00000000-0000-4000-8000-00000000000f'
const ROOM = '00000000-0000-4000-8000-000000000010'

const cfg: NetdataCloudSourceConfig = {
  id: 'netdata-cloud',
  type: 'netdata-cloud',
  url: 'https://app.netdata.cloud',
  tokenEnv: 'NETDATA_CLOUD_TOKEN',
  spaceId: SPACE,
  roomId: ROOM,
  pollSec: 60,
  fleetNodes: ['node-1', 'node-2', 'node-3', 'node-4', 'node-5'],
  watchOnlyNodes: ['print', 'mac-a1.example.net'],
  grafanaDiskHosts: ['node-1', 'node-2', 'node-4', 'node-5', 'node-6']
}

// The service map that matters here.
const serviceMap: ServiceRule[] = [{ match: { labels: { component: '^host-disk' } }, service: 'Host disks' }]

// ---- the policy table ---------------------------------------------------------------------------------------------

const policy: NetdataPolicy = netdataPolicyOf(cfg)
const finding = (node: string, alert: string, level: 'warning' | 'critical', instance = 'disk_space./'): NetdataFinding => ({ node, alert, instance, level })

describe('classifyNetdataAlert: a disk alert on a host with Grafana disk rules joins that rule', () => {
  const rows = [
    { alert: 'disk_space_usage', level: 'warning', title: 'Host disk space low', severity: 'warning', tier: 'low' },
    { alert: 'disk_space_usage', level: 'critical', title: 'Host disk full imminent', severity: 'page', tier: 'imminent' },
    { alert: 'out_of_disk_space_time', level: 'warning', title: 'Host disk filling up', severity: 'warning', tier: 'filling' },
    { alert: 'out_of_disk_space_time', level: 'critical', title: 'Host disk full imminent', severity: 'page', tier: 'imminent' }
  ] as const
  for (const host of ['node-1', 'node-2', 'node-4', 'node-5']) {
    for (const row of rows) {
      it(`${host} ${row.alert} ${row.level} is "${row.title} (${host})", ${row.severity}`, () => {
        expect(classifyNetdataAlert(finding(host, row.alert, row.level), policy)).toMatchObject({
          show: true,
          rule: `${row.title} (${host})`,
          service: 'Host disks',
          severity: row.severity,
          tier: row.tier,
          family: 'space',
          watchOnly: false
        })
      })
    }
  }
})

describe('classifyNetdataAlert: a disk alert on a host without Grafana disk rules stands alone', () => {
  it('node-3 has no Grafana rule: "Netdata: disk space (node-3)" for both alerts and both levels, a critical pages (node-3 is a fleet node)', () => {
    for (const alert of ['disk_space_usage', 'out_of_disk_space_time']) {
      expect(classifyNetdataAlert(finding('node-3', alert, 'warning'), policy)).toMatchObject({ rule: 'Netdata: disk space (node-3)', service: 'Host disks', severity: 'warning', tier: null })
      expect(classifyNetdataAlert(finding('node-3', alert, 'critical'), policy)).toMatchObject({ rule: 'Netdata: disk space (node-3)', service: 'Host disks', severity: 'page', tier: null, demoted: false })
    }
  })

  it('inode alerts have no Grafana twin anywhere: "Netdata: disk inodes (host)", a critical on a fleet node pages', () => {
    for (const host of ['node-3', 'node-4']) {
      for (const alert of ['disk_inode_usage', 'out_of_disk_inodes_time']) {
        expect(classifyNetdataAlert(finding(host, alert, 'warning', 'disk_inodes./'), policy)).toMatchObject({ rule: `Netdata: disk inodes (${host})`, service: 'Host disks', severity: 'warning', tier: null, family: 'inodes' })
        expect(classifyNetdataAlert(finding(host, alert, 'critical', 'disk_inodes./'), policy)).toMatchObject({ rule: `Netdata: disk inodes (${host})`, severity: 'page' })
      }
    }
  })
})

describe('classifyNetdataAlert: severity', () => {
  it('only a critical disk-full class on a fleet node pages: every other critical is a warning', () => {
    const v = classifyNetdataAlert(finding('node-5', 'clickhouse_replication_lag', 'critical', 'clickhouse_local.replication'), policy)
    expect(v).toMatchObject({ show: true, severity: 'warning', demoted: true, service: 'Netdata', rule: 'Netdata: ClickHouse replication lag (node-5)' })
    expect(classifyNetdataAlert(finding('node-1', 'ram_available', 'critical', 'mem.available'), policy)).toMatchObject({ severity: 'warning', demoted: true })
    expect(classifyNetdataAlert(finding('node-2', 'mdstat_disks', 'critical', 'md.health'), policy)).toMatchObject({ severity: 'warning', demoted: true })
    expect(classifyNetdataAlert(finding('node-4', 'docker_container_unhealthy', 'warning', 'docker_local.container_x_health_status'), policy)).toMatchObject({ severity: 'warning', demoted: false })
  })

  it('a watch-only node is capped at a warning, even for a full disk', () => {
    for (const host of ['print', 'mac-a1.example.net']) {
      expect(classifyNetdataAlert(finding(host, 'disk_space_usage', 'critical', 'disk_space./data'), policy)).toMatchObject({
        show: true,
        rule: `Netdata: disk space (${host})`,
        severity: 'warning',
        demoted: true,
        watchOnly: true
      })
      expect(classifyNetdataAlert(finding(host, 'out_of_disk_inodes_time', 'critical', 'disk_inodes./data'), policy)).toMatchObject({ severity: 'warning', watchOnly: true })
    }
  })

  it('a node in neither list is treated as watch-only: nothing it says pages', () => {
    expect(classifyNetdataAlert(finding('newbox', 'disk_space_usage', 'critical'), policy)).toMatchObject({ severity: 'warning', watchOnly: true })
  })

  it('host names compare without case', () => {
    expect(classifyNetdataAlert(finding('NODE-4', 'disk_space_usage', 'critical'), policy)).toMatchObject({ severity: 'page' })
  })

  it('names the four disk-full alerts and nothing else as disk capacity', () => {
    for (const a of ['disk_space_usage', 'out_of_disk_space_time', 'disk_inode_usage', 'out_of_disk_inodes_time']) expect(isDiskCapacity(a)).toBe(true)
    for (const a of ['disk_fill_rate', '10min_disk_backlog', 'mdstat_disks', 'ram_available']) expect(isDiskCapacity(a)).toBe(false)
  })
})

describe('classifyNetdataAlert: what is never shown', () => {
  it('drops the Google Chrome installer image on mac-a1.example.net, a read-only image at 100 %, and every other macOS volume', () => {
    expect(classifyNetdataAlert(finding('mac-a1.example.net', 'disk_space_usage', 'critical', 'disk_space./Volumes/Google Chrome'), policy)).toEqual({ show: false, reason: 'ignored' })
    expect(classifyNetdataAlert(finding('mac-a1.example.net', 'disk_inode_usage', 'critical', 'disk_inodes./Volumes/Google Chrome'), policy)).toEqual({ show: false, reason: 'ignored' })
    expect(classifyNetdataAlert(finding('mac-a1.example.net', 'out_of_disk_space_time', 'critical', 'disk_space./Volumes/OWC Express 1M2'), policy)).toEqual({ show: false, reason: 'ignored' })
  })

  it('/Volumes is ignored on any node, as are snap mounts and the macOS auxiliary volumes, but not the macOS data volume', () => {
    expect(classifyNetdataAlert(finding('node-4', 'disk_space_usage', 'critical', 'disk_space./Volumes/x'), policy)).toMatchObject({ show: false })
    expect(classifyNetdataAlert(finding('node-3', 'disk_space_usage', 'critical', 'disk_space./snap/core20/1974'), policy)).toMatchObject({ show: false })
    expect(classifyNetdataAlert(finding('mac-a1.example.net', 'disk_space_usage', 'critical', 'disk_space./System/Volumes/VM'), policy)).toMatchObject({ show: false })
    expect(classifyNetdataAlert(finding('mac-a1.example.net', 'disk_space_usage', 'warning', 'disk_space./System/Volumes/Data'), policy)).toMatchObject({ show: true })
    expect(classifyNetdataAlert(finding('node-4', 'disk_space_usage', 'warning', 'disk_space./data/volumes'), policy)).toMatchObject({ show: true })
  })

  // node-14, 2026-11-02: one user's 10 GiB box-prod sandbox volume took a 3 GB write, its out_of_disk_space_time went CRITICAL, and Watch paged
  // `Netdata: disk space (node-14)` while node-14's / sat at 47 %. The volume is a loop image, that user's own quota.
  const SANDBOX_VOLUME = '/run/box-space/box-prod/pvc-00000000-0000-4000-8000-000000000012_desk-usr-00000000-0000-4000-8000-000000000011-space'
  const withS14 = netdataPolicyOf({ ...cfg, fleetNodes: [...cfg.fleetNodes, 'node-14'] })

  it("drops a per-user sandbox 'space' volume under /run/box-space, on a fleet node, at either level, space or inodes: it is never a host disk", () => {
    for (const alert of ['disk_space_usage', 'out_of_disk_space_time']) {
      for (const level of ['warning', 'critical'] as const) {
        expect(classifyNetdataAlert(finding('node-14', alert, level, `disk_space.${SANDBOX_VOLUME}`), withS14)).toEqual({ show: false, reason: 'ignored' })
      }
    }
    for (const alert of ['disk_inode_usage', 'out_of_disk_inodes_time']) {
      expect(classifyNetdataAlert(finding('node-14', alert, 'critical', `disk_inodes.${SANDBOX_VOLUME}`), withS14)).toEqual({ show: false, reason: 'ignored' })
    }
    expect(classifyNetdataAlert(finding('node-4', 'out_of_disk_space_time', 'critical', 'disk_space./run/box-space/box-dev/pvc-1_desk-usr-1-space'), policy)).toEqual({ show: false, reason: 'ignored' })
  })

  it("still pages for the node's own mounts beside the sandbox volumes: /, /data/box-space that holds their images, and paths that only look alike", () => {
    for (const instance of ['disk_space./', 'disk_space./data/box-space', 'disk_space./run/box-spaces/x', 'disk_space./data/run/box-space/x']) {
      expect(classifyNetdataAlert(finding('node-14', 'out_of_disk_space_time', 'critical', instance), withS14), instance).toMatchObject({
        show: true,
        rule: 'Netdata: disk space (node-14)',
        service: 'Host disks',
        severity: 'page'
      })
    }
    expect(classifyNetdataAlert(finding('node-14', 'disk_inode_usage', 'critical', 'disk_inodes./data/box-space'), withS14)).toMatchObject({ show: true, rule: 'Netdata: disk inodes (node-14)', severity: 'page' })
  })

  it('config rules add to the built-in ones, and a node matcher limits a rule to that node', () => {
    const custom = netdataPolicyOf({ ...cfg, ignoreInstances: [{ node: '^node-3$', instance: '^disk_space\\./data/scratch$' }] })
    expect(classifyNetdataAlert(finding('node-3', 'disk_space_usage', 'critical', 'disk_space./data/scratch'), custom)).toMatchObject({ show: false, reason: 'ignored' })
    expect(classifyNetdataAlert(finding('node-4', 'disk_space_usage', 'critical', 'disk_space./data/scratch'), custom)).toMatchObject({ show: true })
    expect(classifyNetdataAlert(finding('mac-a1.example.net', 'disk_space_usage', 'critical', 'disk_space./Volumes/Google Chrome'), custom)).toMatchObject({ show: false })
  })

  it('drops every alert of an ignoreNodes node, whatever it is and whatever its level; an unlisted node that is not ignored still reaches the wall as before', () => {
    const ignoring = netdataPolicyOf({ ...cfg, watchOnlyNodes: ['mac-a1.example.net'], ignoreNodes: { print: 'print spooler, not monitored' } })
    for (const level of ['warning', 'critical'] as const) {
      expect(classifyNetdataAlert(finding('print', 'disk_space_usage', level, 'disk_space./data'), ignoring)).toEqual({ show: false, reason: 'ignored-node' })
      expect(classifyNetdataAlert(finding('print', 'system_post_update_reboot_status', level, 'system.post_update_reboot_status'), ignoring)).toEqual({ show: false, reason: 'ignored-node' })
      expect(classifyNetdataAlert(finding('print', '10min_cpu_usage', level, 'system.cpu'), ignoring)).toEqual({ show: false, reason: 'ignored-node' })
    }
    expect(classifyNetdataAlert(finding('PRINT', 'ram_in_use', 'warning', 'system.ram'), ignoring)).toEqual({ show: false, reason: 'ignored-node' })
    // the others are unchanged: a fleet node pages, a watch-only node and a node nobody listed are capped at a warning
    expect(classifyNetdataAlert(finding('node-4', 'disk_space_usage', 'critical'), ignoring)).toMatchObject({ show: true, severity: 'page' })
    expect(classifyNetdataAlert(finding('mac-a1.example.net', 'disk_space_usage', 'critical', 'disk_space./data'), ignoring)).toMatchObject({ show: true, severity: 'warning', watchOnly: true })
    expect(classifyNetdataAlert(finding('newbox', 'disk_space_usage', 'critical'), ignoring)).toMatchObject({ show: true, severity: 'warning', watchOnly: true, rule: 'Netdata: disk space (newbox)' })
    // without the entry print is the watch-only node it was
    expect(classifyNetdataAlert(finding('print', 'disk_space_usage', 'critical', 'disk_space./data'), policy)).toMatchObject({ show: true, watchOnly: true })
  })

  it('drops the quiet alerts by name (wildcards and case allowed) and a config list replaces the default', () => {
    expect(classifyNetdataAlert(finding('node-4', '10min_disk_backlog', 'warning', 'disk_backlog.md0'), policy)).toEqual({ show: false, reason: 'quiet' })
    expect(classifyNetdataAlert(finding('node-5', '10min_disk_utilization', 'critical', 'disk_util.nvme0n1'), policy)).toEqual({ show: false, reason: 'quiet' })
    const wild = netdataPolicyOf({ ...cfg, quietAlerts: ['CLICKHOUSE_*'] })
    expect(classifyNetdataAlert(finding('node-5', 'clickhouse_restarted', 'warning', 'x'), wild)).toEqual({ show: false, reason: 'quiet' })
    expect(classifyNetdataAlert(finding('node-4', '10min_disk_backlog', 'warning', 'disk_backlog.md0'), wild)).toMatchObject({ show: true })
  })
})

describe('the Grafana host-disk rules this mapping joins', () => {
  it('exist for exactly the default hosts, in the three tiers whose titles the mapping writes', () => {
    const rules: Array<{ title: string; component: string; severity: string }> = fixture('api-alert-rules.json').rules
    const disk = rules.filter((r) => r.component === 'host-disk')
    const hosts = new Set(disk.map((r) => /\(([\w-]+)\)$/.exec(r.title)?.[1] ?? ''))
    expect([...hosts].sort()).toEqual([...GRAFANA_DISK_HOSTS].sort())
    for (const host of GRAFANA_DISK_HOSTS) {
      const titles = new Map(disk.filter((r) => r.title.endsWith(`(${host})`)).map((r) => [r.title, r.severity]))
      const a = classifyNetdataAlert(finding(host, 'disk_space_usage', 'critical'), policy)
      const b = classifyNetdataAlert(finding(host, 'out_of_disk_space_time', 'warning'), policy)
      const c = classifyNetdataAlert(finding(host, 'disk_space_usage', 'warning'), policy)
      for (const v of [a, b, c]) expect(v.show && titles.has(v.rule)).toBe(true)
      // Tier a is Grafana's page, b and c its warnings: the incident keeps the severity the Netdata alert has.
      expect(titles.get((a as { rule: string }).rule)).toBe('page')
      expect(titles.get((b as { rule: string }).rule)).toBe('warn')
      expect(titles.get((c as { rule: string }).rule)).toBe('warn')
    }
  })
})

describe('small helpers', () => {
  it('reads an instance id as a mount point or a container', () => {
    expect(instanceDetail('disk_space./')).toBe('/')
    expect(instanceDetail('disk_space._')).toBe('/')
    expect(instanceDetail('disk_inodes./data/ssd1')).toBe('/data/ssd1')
    expect(instanceDetail('docker_local.container_apollo-ug-xyz-backend_health_status')).toBe('apollo-ug-xyz-backend')
    expect(instanceDetail('system.post_update_reboot_status')).toBe('')
  })
  it('writes alert names as words', () => {
    expect(friendlyAlert('disk_space_usage')).toBe('disk space')
    expect(friendlyAlert('clickhouse_replication_lag')).toBe('ClickHouse replication lag')
    expect(friendlyAlert('some_new_alert')).toBe('some new alert')
  })
  it('asks for both states of every name', () => {
    expect(groupSelectors(['disk_space_usage', 'clickhouse_*'])).toEqual(['disk_space_usage:WARNING', 'disk_space_usage:CRITICAL', 'clickhouse_*:WARNING', 'clickhouse_*:CRITICAL'])
  })
  it('never scopes a built-in group to every context', () => {
    for (const g of DEFAULT_GROUPS) {
      expect(g.contexts.length).toBeGreaterThan(0)
      expect(g.contexts).not.toContain('*')
    }
    expect(DEFAULT_GROUPS.length + 1).toBeLessThanOrEqual(8)
  })
})

// ---- reading the recorded responses -------------------------------------------------------------------------------

describe('parseData and locateAlerts on the recorded responses', () => {
  const never = async (): Promise<null> => {
    throw new Error('no refinement expected')
  }

  it('finds the one instance of the WARNING response: node-4, disk_space_usage, warning, with how full it is', async () => {
    const parsed = parseData(fixture('netdata-cloud-disk-space-warning.json'))
    expect(parsed.nodes.map((n) => [n.name, n.code])).toContainEqual(['node-4', 200])
    expect(parsed.instances).toHaveLength(45)
    expect(parsed.instances.filter((i) => i.selected).map((i) => [i.node, i.id, i.warnings, i.criticals])).toEqual([['node-4', 'disk_space./', 1, 0]])
    expect(parsed.agentNowSec).toBe(1792077356)
    const { found, values } = await locateAlerts(parsed, ['disk_space_usage', 'out_of_disk_space_time'], never)
    expect(found).toEqual([{ node: 'node-4', instance: 'disk_space./', alert: 'disk_space_usage', level: 'warning' }])
    expect(values.get('node-4\ndisk_space./')).toBe('89.5% used, 91.2 GiB free of 914.7 GiB')
  })

  it('finds the instance of the CRITICAL response: mac-a1.example.net, the Google Chrome image', async () => {
    const parsed = parseData(fixture('netdata-cloud-disk-space-critical.json'))
    const { found, values } = await locateAlerts(parsed, ['disk_space_usage', 'out_of_disk_space_time'], never)
    expect(found).toEqual([{ node: 'mac-a1.example.net', instance: 'disk_space./Volumes/Google Chrome', alert: 'disk_space_usage', level: 'critical' }])
    expect(values.get('mac-a1.example.net\ndisk_space./Volumes/Google Chrome')).toBe('100.0% used, 0.0 GiB free of 0.5 GiB')
  })

  it('finds nothing in an all-clear response, whatever the whole-scope counters say about ghosts', async () => {
    for (const name of ['netdata-cloud-disk-inodes-clear.json', 'netdata-cloud-disk-health-clear.json']) {
      const parsed = parseData(fixture(name))
      expect(parsed.instances.some((i) => i.selected)).toBe(false)
      expect((await locateAlerts(parsed, ['*'], never)).found).toEqual([])
    }
  })

  it('refuses a body that is not a data response', () => {
    expect(() => parseData({ foo: 1 })).toThrow('unexpected shape')
    expect(() => parseData([])).toThrow('unexpected shape')
  })
})

describe('locateAlerts when the counters cannot say which alert it is', () => {
  // Synthetic: the recorded responses have one non-clear name at a time, so the ambiguous shapes are built by hand.
  function data(selected: Array<{ node: string; id: string; wr?: number; cr?: number }>, counts: Record<string, { wr?: number; cr?: number }>): any {
    return {
      agents: [{ ai: 0, now: 1792077356, nm: 'x' }],
      summary: {
        nodes: [{ ni: 0, mg: 'g0', nm: 'node-1', st: { code: 200 } }, { ni: 1, mg: 'g1', nm: 'node-2', st: { code: 200 } }],
        instances: selected.map((s) => ({ id: s.id, ni: s.node === 'node-1' ? 0 : 1, ds: { sl: 3, qr: 3 }, al: { ...(s.wr ? { wr: s.wr } : {}), ...(s.cr ? { cr: s.cr } : {}) } })),
        alerts: Object.entries(counts).map(([nm, c]) => ({ nm, ...(c.wr ? { wr: c.wr } : {}), ...(c.cr ? { cr: c.cr } : {}) }))
      }
    }
  }

  it('asks one query per non-zero (name, status) and attributes each instance to the query that selects it', async () => {
    const first = parseData(
      data(
        [
          { node: 'node-1', id: 'disk_space./a', wr: 1 },
          { node: 'node-2', id: 'disk_space./b', cr: 1 }
        ],
        { disk_space_usage: { wr: 1 }, out_of_disk_space_time: { cr: 1 } }
      )
    )
    const asked: string[] = []
    const { found } = await locateAlerts(first, ['disk_space_usage', 'out_of_disk_space_time'], async (selector) => {
      asked.push(selector)
      if (selector === 'disk_space_usage:WARNING') return parseData(data([{ node: 'node-1', id: 'disk_space./a', wr: 1 }], {}))
      if (selector === 'out_of_disk_space_time:CRITICAL') return parseData(data([{ node: 'node-2', id: 'disk_space./b', cr: 1 }], {}))
      return parseData(data([], {}))
    })
    expect(asked.sort()).toEqual(['disk_space_usage:WARNING', 'out_of_disk_space_time:CRITICAL'])
    expect(found.sort((a, b) => a.node.localeCompare(b.node))).toEqual([
      { node: 'node-1', instance: 'disk_space./a', alert: 'disk_space_usage', level: 'warning' },
      { node: 'node-2', instance: 'disk_space./b', alert: 'out_of_disk_space_time', level: 'critical' }
    ])
  })

  it('asks too when one instance has both a warning and a critical counter, because they may be two alerts', async () => {
    const first = parseData(data([{ node: 'node-1', id: 'disk_space./a', wr: 1, cr: 1 }], { disk_space_usage: { wr: 1 }, out_of_disk_space_time: { cr: 1 } }))
    const { found } = await locateAlerts(first, ['disk_space_usage', 'out_of_disk_space_time'], async (selector) => {
      if (selector === 'disk_space_usage:WARNING' || selector === 'out_of_disk_space_time:CRITICAL') return parseData(data([{ node: 'node-1', id: 'disk_space./a', wr: 1, cr: 1 }], {}))
      return null
    })
    expect(found.map((f) => [f.alert, f.level]).sort()).toEqual([
      ['disk_space_usage', 'warning'],
      ['out_of_disk_space_time', 'critical']
    ])
  })

  it('falls back to the counters, marked approximate, when a refinement cannot be asked', async () => {
    const first = parseData(
      data(
        [
          { node: 'node-1', id: 'disk_space./a', wr: 1 },
          { node: 'node-2', id: 'disk_space./b', cr: 1 }
        ],
        { disk_space_usage: { wr: 1 }, out_of_disk_space_time: { cr: 1 } }
      )
    )
    const { found } = await locateAlerts(first, ['disk_space_usage', 'out_of_disk_space_time'], async () => null)
    expect(found).toHaveLength(2)
    expect(found.every((f) => f.approximate === true)).toBe(true)
    expect(found.map((f) => f.level).sort()).toEqual(['critical', 'warning'])
  })
})

// ---- a fake Cloud -------------------------------------------------------------------------------------------------

interface Call {
  method: string
  url: string
  headers: Record<string, string>
  body: any
  signal: AbortSignal | null | undefined
  redirect: RequestRedirect | undefined
}

interface FakeOpts {
  nodes?: unknown
  nodesStatus?: number
  /** Response per first context of the query; a function sees the request body. */
  data?: Record<string, unknown | ((body: any) => Response | unknown)>
  /** HTTP status per first context. */
  dataStatus?: Record<string, number>
  /** Throws instead of answering when it returns an Error. */
  fail?: (call: Call) => Error | Response | undefined
}

const clearData = (): any => fixture('netdata-cloud-disk-inodes-clear.json')

function fakeCloud(opts: FakeOpts = {}): { fetch: typeof fetch; calls: Call[]; maxInFlight: () => number } {
  const calls: Call[] = []
  let inFlight = 0
  let max = 0
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    inFlight += 1
    max = Math.max(max, inFlight)
    try {
      await Promise.resolve()
      const call: Call = {
        method: init?.method ?? 'GET',
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        signal: init?.signal,
        redirect: init?.redirect
      }
      calls.push(call)
      const failed = opts.fail?.(call)
      if (failed instanceof Error) throw failed
      if (failed instanceof Response) return failed
      if (call.method === 'GET') return new Response(JSON.stringify(opts.nodes ?? fixture('netdata-cloud-nodes.json')), { status: opts.nodesStatus ?? 200 })
      const context = call.body.scope.contexts[0] as string
      const status = opts.dataStatus?.[context] ?? 200
      const defaults: Record<string, unknown> = {
        'disk.space': fixture('netdata-cloud-disk-space-warning.json'),
        'disk.inodes': fixture('netdata-cloud-disk-inodes-clear.json'),
        'md.health': fixture('netdata-cloud-disk-health-clear.json'),
        'mem.available': fixture('netdata-cloud-host-reboot.json')
      }
      let body = opts.data?.[context] ?? defaults[context] ?? clearData()
      if (typeof body === 'function') body = (body as (b: unknown) => unknown)(call.body)
      if (body instanceof Response) return body
      return new Response(JSON.stringify(body), { status })
    } finally {
      inFlight -= 1
    }
  }
  return { fetch: impl as typeof fetch, calls, maxInFlight: () => max }
}

function deps(f: { fetch: typeof fetch }, extra: Partial<SourceDeps> = {}): SourceDeps {
  return { fetch: f.fetch, env: { NETDATA_CLOUD_TOKEN: FAKE_TOKEN }, nowIso: () => NOW, serviceMap, ...extra }
}

const byRule = (obs: Observation, rule: string): Alert | undefined => obs.firing.find((a) => a.rule === rule)
const cellNamed = (obs: Observation, part: string) => obs.rules?.find((c) => c.name.includes(part))

// ---- a poll over the recorded responses ---------------------------------------------------------------------------

describe('a poll over the recorded responses', () => {
  it('returns a complete Observation: the node-4 disk warning and the pending reboot on print, 7 cells', async () => {
    const f = fakeCloud()
    const obs = await createNetdataCloudSource(cfg, deps(f)).poll()
    expect(obs).toMatchObject({ source: 'netdata-cloud', kind: 'netdata-cloud', at: NOW, complete: true, resolved: [] })
    expect(obs.firing.map((a) => a.rule).sort()).toEqual(['Host disk space low (node-4)', 'Netdata: reboot pending after update (print)'])
    expect(obs.rules).toHaveLength(7)
  })

  it('writes the node-4 disk alert into the Grafana incident of the same tier: same service, same rule, labels like the Grafana rule', async () => {
    const obs = await createNetdataCloudSource(cfg, deps(fakeCloud())).poll()
    const a = byRule(obs, 'Host disk space low (node-4)')!
    expect(a).toMatchObject({
      origin: 'netdata-cloud',
      rule: 'Host disk space low (node-4)',
      service: 'Host disks',
      host: 'node-4',
      severity: 'warning',
      severityLabel: 'warning',
      value: '89.5% used, 91.2 GiB free of 914.7 GiB',
      resolvedAt: null,
      status: { state: 'active' }
    })
    expect(a.key).toMatch(/^netdata-cloud:[0-9a-f]{8}$/)
    expect(a.labels).toMatchObject({
      alertname: 'disk_space_usage',
      component: 'host-disk',
      host: 'node-4',
      instance: 'node-4',
      netdata_severity: 'warning',
      netdata_instance: 'disk_space./',
      mountpoint: '/',
      system: 'Netdata'
    })
    expect(a.annotations.summary).toBe('node-4 disk space (/) is at warning: 89.5% used, 91.2 GiB free of 914.7 GiB')
    expect(a.via).toEqual([{ source: 'netdata-cloud', kind: 'netdata-cloud', lastSeen: NOW, url: undefined }])
    // The same incident key as Grafana's own rule: service|rule.
    const grafana = makeAlert(
      {
        origin: 'grafana',
        rule: 'Host disk space low (node-4)',
        labels: { alertname: 'Host disk space low (node-4)', component: 'host-disk', host: 'node-4', severity: 'warn' },
        startsAt: NOW,
        via: { source: 'grafana', kind: 'grafana', lastSeen: NOW },
        raw: {}
      },
      serviceMap,
      NOW
    )
    expect(incidentKeyOf(a.service, a.rule)).toBe(incidentKeyOf(grafana.service, grafana.rule))
    expect(incidentKeyOf(a.service, a.rule)).toBe('Host disks|Host disk space low (node-4)')
  })

  it('shows a pending reboot on a watch-only node as a Netdata warning, not a disk alert', async () => {
    const obs = await createNetdataCloudSource(cfg, deps(fakeCloud())).poll()
    const a = byRule(obs, 'Netdata: reboot pending after update (print)')!
    expect(a).toMatchObject({ service: 'Netdata', severity: 'warning', host: 'print' })
    expect(a.labels).toMatchObject({ alertname: 'system_post_update_reboot_status', component: 'netdata', netdata_instance: 'system.post_update_reboot_status' })
    expect(a.labels.mountpoint).toBeUndefined()
  })

  it('fills the cells: the nodes cell, and one cell per group with the evaluation time of the agents', async () => {
    const obs = await createNetdataCloudSource(cfg, deps(fakeCloud())).poll()
    const cells = obs.rules!
    expect(cells.every((c) => c.service === 'Netdata' && c.source === 'netdata-cloud')).toBe(true)
    expect(new Set(cells.map((c) => c.id)).size).toBe(7)
    expect(cells[0]).toEqual({ id: 'netdata-cloud:nodes', source: 'netdata-cloud', name: 'Netdata nodes reachable (7/7)', service: 'Netdata', state: 'ok', evaluatedAt: NOW, intervalSec: 60, url: undefined })
    expect(Object.fromEntries(cells.map((c) => [c.id.replace('netdata-cloud:', ''), c.state]))).toEqual({
      nodes: 'ok',
      'disk-space': 'firing',
      'disk-inodes': 'ok',
      'disk-health': 'ok',
      clickhouse: 'ok',
      docker: 'ok',
      host: 'firing'
    })
    const space = cellNamed(obs, 'disk space')!
    expect(space.evaluatedAt).toBe(new Date(1792077356 * 1000).toISOString())
    expect(space.intervalSec).toBe(60)
    expect(cellNamed(obs, 'Docker')!.intervalSec).toBe(300)
  })

  it('makes one GET and six POSTs, one at a time, each scoped to named contexts and to the states WARNING and CRITICAL', async () => {
    const f = fakeCloud()
    await createNetdataCloudSource(cfg, deps(f)).poll()
    expect(f.calls.map((c) => `${c.method} ${c.url.replace(`https://app.netdata.cloud/api`, '')}`)).toEqual([
      `GET /v2/spaces/${SPACE}/rooms/${ROOM}/nodes`,
      ...Array.from({ length: 6 }, () => `POST /v3/spaces/${SPACE}/rooms/${ROOM}/data`)
    ])
    expect(f.maxInFlight()).toBe(1)
    for (const c of f.calls) {
      expect(c.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`)
      expect(c.signal).toBeInstanceOf(AbortSignal)
      // The token goes to the configured origin and a redirect is a failure, not a hop to somewhere else.
      expect(new URL(c.url).origin).toBe('https://app.netdata.cloud')
      expect(c.redirect).toBe('error')
    }
    const first = f.calls[1].body
    expect(first.scope.contexts).toEqual(['disk.space'])
    expect(first.selectors.alerts).toEqual(['disk_space_usage:WARNING', 'disk_space_usage:CRITICAL', 'out_of_disk_space_time:WARNING', 'out_of_disk_space_time:CRITICAL'])
    expect(first.window).toEqual({ after: -120, before: 0, points: 1 })
    expect(first.format).toBe('json2')
    expect(first.aggregations.metrics[0].group_by).toEqual(['node', 'instance', 'dimension'])
    for (const c of f.calls.slice(1)) {
      expect(c.body.scope.contexts).not.toContain('*')
      expect(c.body.selectors.contexts).not.toContain('*')
    }
  })

  it('reads the Docker group every 5 minutes, not every poll', async () => {
    const f = fakeCloud()
    let now = NOW
    const src = createNetdataCloudSource(cfg, deps(f, { nowIso: () => now }))
    await src.poll()
    expect(f.calls.filter((c) => c.body?.scope.contexts[0] === 'docker.container_health_status')).toHaveLength(1)
    now = '2026-10-15T15:17:00.000Z'
    const second = await src.poll()
    expect(f.calls.filter((c) => c.body?.scope.contexts[0] === 'docker.container_health_status')).toHaveLength(1)
    expect(f.calls).toHaveLength(7 + 6)
    expect(second.rules).toHaveLength(7)
    expect(cellNamed(second, 'Docker')!.state).toBe('ok')
    now = '2026-10-15T15:21:30.000Z'
    await src.poll()
    expect(f.calls.filter((c) => c.body?.scope.contexts[0] === 'docker.container_health_status')).toHaveLength(2)
  })

  it('gives the same alert the same key on the next poll, and a different key when the level moves it to another incident', async () => {
    const warning = fixture('netdata-cloud-disk-space-warning.json')
    const critical = JSON.parse(JSON.stringify(warning))
    critical.summary.instances.find((i: any) => i.ni === 1 && i.id === 'disk_space./').al = { cl: 1, cr: 1, ot: 1 }
    const keyOf = async (data: unknown): Promise<string> => {
      const obs = await createNetdataCloudSource(cfg, deps(fakeCloud({ data: { 'disk.space': data } }))).poll()
      return obs.firing.find((a) => a.host === 'node-4')!.key
    }
    const again = await keyOf(warning)
    expect(again).toBe(await keyOf(warning))
    expect(await keyOf(critical)).not.toBe(again)
  })

  it('pages for a CRITICAL disk_space_usage on node-4 under the Grafana "full imminent" title', async () => {
    const critical = fixture('netdata-cloud-disk-space-warning.json')
    critical.summary.instances.find((i: any) => i.ni === 1 && i.id === 'disk_space./').al = { cl: 1, cr: 1, ot: 1 }
    const obs = await createNetdataCloudSource(cfg, deps(fakeCloud({ data: { 'disk.space': critical } }))).poll()
    const a = byRule(obs, 'Host disk full imminent (node-4)')!
    expect(a).toMatchObject({ severity: 'page', severityLabel: 'critical', service: 'Host disks' })
    expect(a.labels.netdata_severity).toBe('critical')
    expect(incidentKeyOf(a.service, a.rule)).toBe('Host disks|Host disk full imminent (node-4)')
  })

  it('pages for a CRITICAL disk on node-3, which has no Grafana disk rule, under its own title', async () => {
    const critical = fixture('netdata-cloud-disk-space-critical.json')
    const node3 = critical.summary.nodes.find((n: any) => n.nm === 'node-3').ni
    Object.assign(critical.summary.instances.find((i: any) => i.id === 'disk_space./Volumes/Google Chrome'), { ni: node3, id: 'disk_space./var/lib/fleet-data' })
    const obs = await createNetdataCloudSource(cfg, deps(fakeCloud({ data: { 'disk.space': critical } }))).poll()
    expect(obs.firing.map((a) => [a.rule, a.severity, a.service])).toContainEqual(['Netdata: disk space (node-3)', 'page', 'Host disks'])
    expect(cellNamed(obs, 'disk space')!.state).toBe('firing')
  })
})

describe('the false positive that must never page: the Google Chrome installer image on mac-a1.example.net', () => {
  it('is evaluated, shows nothing, and leaves the disk space cell solid', async () => {
    const f = fakeCloud({ data: { 'disk.space': fixture('netdata-cloud-disk-space-critical.json') } })
    const obs = await createNetdataCloudSource(cfg, deps(f)).poll()
    expect(obs.firing.filter((a) => a.host === 'mac-a1.example.net')).toEqual([])
    expect(obs.firing.some((a) => a.severity === 'page')).toBe(false)
    expect(cellNamed(obs, 'disk space')).toMatchObject({ state: 'ok', evaluatedAt: new Date(1792077356 * 1000).toISOString() })
  })

  it('stays out even when mac-a1.example.net were a fleet node, because the instance is ignored on any node', async () => {
    const asFleet: NetdataCloudSourceConfig = { ...cfg, fleetNodes: [...cfg.fleetNodes, 'mac-a1.example.net'] }
    const f = fakeCloud({ data: { 'disk.space': fixture('netdata-cloud-disk-space-critical.json') } })
    const obs = await createNetdataCloudSource(asFleet, deps(f)).poll()
    expect(obs.firing.filter((a) => a.host === 'mac-a1.example.net')).toEqual([])
  })

  it('a real disk on the same watch-only node is a warning, never a page', async () => {
    const critical = fixture('netdata-cloud-disk-space-critical.json')
    critical.summary.instances.find((i: any) => i.id === 'disk_space./Volumes/Google Chrome').id = 'disk_space./System/Volumes/Data'
    const obs = await createNetdataCloudSource(cfg, deps(fakeCloud({ data: { 'disk.space': critical } }))).poll()
    const a = obs.firing.find((x) => x.host === 'mac-a1.example.net')!
    expect(a).toMatchObject({ rule: 'Netdata: disk space (mac-a1.example.net)', severity: 'warning', severityLabel: 'warning' })
    expect(a.labels.netdata_severity).toBe('critical')
    expect(a.annotations.description).toContain('only a full disk on a fleet node is a page')
    expect(a.annotations.description).toContain('not a fleet node')
  })
})

describe("the false positive that paged from node-14: one user's sandbox space volume under /run/box-space", () => {
  // The recorded CRITICAL response with its one critical instance moved to node-3 (a fleet node with no Grafana disk rule, as node-14 is) and renamed.
  const criticalOnS3 = (id: string): any => {
    const critical = fixture('netdata-cloud-disk-space-critical.json')
    const node3 = critical.summary.nodes.find((n: any) => n.nm === 'node-3').ni
    Object.assign(critical.summary.instances.find((i: any) => i.id === 'disk_space./Volumes/Google Chrome'), { ni: node3, id })
    return critical
  }

  it('is evaluated on a fleet node, shows nothing, and leaves the disk space cell solid', async () => {
    const volume = 'disk_space./run/box-space/box-prod/pvc-00000000-0000-4000-8000-000000000012_desk-usr-00000000-0000-4000-8000-000000000011-space'
    const obs = await createNetdataCloudSource(cfg, deps(fakeCloud({ data: { 'disk.space': criticalOnS3(volume) } }))).poll()
    expect(obs.firing.filter((a) => a.host === 'node-3')).toEqual([])
    expect(obs.firing.some((a) => a.severity === 'page')).toBe(false)
    expect(cellNamed(obs, 'disk space')!.state).toBe('ok')
  })

  it("the filesystem that holds the volume images is the node's own, and still pages", async () => {
    const obs = await createNetdataCloudSource(cfg, deps(fakeCloud({ data: { 'disk.space': criticalOnS3('disk_space./data/box-space') } }))).poll()
    expect(obs.firing.map((a) => [a.rule, a.severity, a.service])).toContainEqual(['Netdata: disk space (node-3)', 'page', 'Host disks'])
    expect(cellNamed(obs, 'disk space')!.state).toBe('firing')
  })
})

describe('quiet alerts', () => {
  it('a group that returns a quiet alert drops it, and its cell stays solid', async () => {
    const data = fixture('netdata-cloud-disk-space-warning.json')
    data.summary.alerts = [{ nm: '10min_disk_backlog', cl: 3, wr: 1 }]
    const quiet: NetdataCloudSourceConfig = {
      ...cfg,
      groups: [{ id: 'disk-latency', name: 'Netdata disk latency alerts', contexts: ['disk.space'], alerts: ['10min_disk_backlog'] }]
    }
    const obs = await createNetdataCloudSource(quiet, deps(fakeCloud({ data: { 'disk.space': data } }))).poll()
    expect(obs.firing).toEqual([])
    expect(cellNamed(obs, 'disk latency')!.state).toBe('ok')
    const loud = await createNetdataCloudSource({ ...quiet, quietAlerts: [] }, deps(fakeCloud({ data: { 'disk.space': data } }))).poll()
    expect(loud.firing.map((a) => a.rule)).toEqual(['Netdata: 10min disk backlog (node-4)'])
  })
})

// ---- the disk warning floor ---------------------------------------------------------------------------------------

// No disk warning under 80 % used: a disk-capacity WARNING under 80 % used is not raised; the CRITICAL tier (full in
// under 2 hours) is, at any fill; at 80 % or more nothing changes.
describe('the disk warning floor: no disk warning under 80 % used', () => {
  /** The recorded node-4 root-disk response, set to `alert` at `level` with the disk `usedPct` full (used + avail = 100 GiB, so the percent is exact). */
  function diskAt(alert: string, level: 'warning' | 'critical', usedPct: number, family: 'space' | 'inodes' = 'space'): any {
    const f = fixture('netdata-cloud-disk-space-warning.json')
    const other = alert === 'disk_space_usage' ? 'out_of_disk_space_time' : 'disk_space_usage'
    f.summary.instances.find((i: any) => i.ni === 1 && i.id === 'disk_space./').al = level === 'critical' ? { cl: 1, cr: 1 } : { cl: 1, wr: 1 }
    f.summary.alerts = [{ nm: alert, cl: 44, ...(level === 'critical' ? { cr: 1 } : { wr: 1 }) }, { nm: other, cl: 45 }]
    const row = f.result.data[0]
    row[1] = [usedPct, 0, 0]
    row[2] = [100 - usedPct, 0, 0]
    row[3] = [0, 0, 0]
    return family === 'space' ? f : JSON.parse(JSON.stringify(f).replaceAll('disk_space./', 'disk_inodes./'))
  }
  const diskAlerts = (obs: Observation): Alert[] => obs.firing.filter((a) => a.service === 'Host disks')
  const pollWith = (data: unknown, context = 'disk.space', config: NetdataCloudSourceConfig = cfg): Promise<Observation> =>
    // The other disk group answers all-clear, so only the group under test can raise a disk alert.
    createNetdataCloudSource(config, deps(fakeCloud({ data: { 'disk.space': clearData(), 'disk.inodes': clearData(), [context]: data } }))).poll()

  describe('classifyNetdataAlert', () => {
    const warn = (alert: string, usedPct: number | undefined, node = 'node-4', instance = 'disk_space./'): NetdataFinding => ({ node, alert, instance, level: 'warning', usedPct })

    it('drops the four disk-capacity warnings on a mount under 80 % used, whatever the node, and says why', () => {
      for (const node of ['node-4', 'node-3', 'node-13', 'print']) {
        for (const alert of ['disk_space_usage', 'out_of_disk_space_time']) {
          expect(classifyNetdataAlert(warn(alert, 62.9, node), policy)).toEqual({ show: false, reason: 'below-floor' })
        }
        for (const alert of ['disk_inode_usage', 'out_of_disk_inodes_time']) {
          expect(classifyNetdataAlert(warn(alert, 12.3, node, 'disk_inodes./'), policy)).toEqual({ show: false, reason: 'below-floor' })
        }
      }
    })

    it('keeps a warning at 80 % and over exactly as before: the line is "under 80", so 79.9 drops and 80.0 shows', () => {
      expect(classifyNetdataAlert(warn('out_of_disk_space_time', 79.9), policy)).toEqual({ show: false, reason: 'below-floor' })
      expect(classifyNetdataAlert(warn('out_of_disk_space_time', 80), policy)).toMatchObject({ show: true, rule: 'Host disk filling up (node-4)', severity: 'warning', tier: 'filling' })
      expect(classifyNetdataAlert(warn('out_of_disk_space_time', 86), policy)).toMatchObject({ show: true, rule: 'Host disk filling up (node-4)', severity: 'warning' })
      expect(classifyNetdataAlert(warn('disk_space_usage', 89.5), policy)).toMatchObject({ show: true, rule: 'Host disk space low (node-4)', severity: 'warning' })
      expect(classifyNetdataAlert(warn('out_of_disk_space_time', 99, 'node-13'), policy)).toMatchObject({ show: true, rule: 'Netdata: disk space (node-13)', severity: 'warning', watchOnly: true })
    })

    it('never drops a critical: full in under 2 hours pages on a fleet node at any fill, and is a watch-only warning elsewhere', () => {
      const crit = (alert: string, usedPct: number, node = 'node-4'): NetdataFinding => ({ node, alert, instance: 'disk_space./', level: 'critical', usedPct })
      expect(classifyNetdataAlert(crit('out_of_disk_space_time', 62.9), policy)).toMatchObject({ show: true, rule: 'Host disk full imminent (node-4)', severity: 'page', tier: 'imminent' })
      expect(classifyNetdataAlert(crit('out_of_disk_space_time', 1), policy)).toMatchObject({ show: true, severity: 'page' })
      expect(classifyNetdataAlert(crit('out_of_disk_space_time', 62.9, 'node-3'), policy)).toMatchObject({ show: true, rule: 'Netdata: disk space (node-3)', severity: 'page' })
      expect(classifyNetdataAlert(crit('out_of_disk_inodes_time', 30, 'node-3'), policy)).toMatchObject({ show: true, severity: 'page' })
      expect(classifyNetdataAlert(crit('out_of_disk_space_time', 62.9, 'print'), policy)).toMatchObject({ show: true, severity: 'warning', demoted: true, watchOnly: true })
    })

    it('raises a warning whose fill is unknown (the response carried no usage columns), because the floor cannot judge it', () => {
      expect(classifyNetdataAlert(warn('out_of_disk_space_time', undefined), policy)).toMatchObject({ show: true, severity: 'warning' })
    })

    it('leaves every non-capacity alert alone: RAID, NVMe, RAM and containers have no used percent', () => {
      for (const [alert, instance] of [['mdstat_disks', 'md.health'], ['nvme_device_critical_warnings_state', 'nvme.x'], ['ram_available', 'mem.available'], ['docker_container_unhealthy', 'docker_local.container_x_health_status']] as const) {
        expect(classifyNetdataAlert({ node: 'node-4', alert, instance, level: 'warning', usedPct: 5 }, policy)).toMatchObject({ show: true })
      }
    })

    it('takes the floor from the config, and 0 turns it off', () => {
      const strict = netdataPolicyOf({ ...cfg, diskWarningFloor: { usedPct: 90, note: 'test' } })
      expect(classifyNetdataAlert(warn('out_of_disk_space_time', 86), strict)).toEqual({ show: false, reason: 'below-floor' })
      expect(classifyNetdataAlert(warn('out_of_disk_space_time', 90), strict)).toMatchObject({ show: true })
      const off = netdataPolicyOf({ ...cfg, diskWarningFloor: { usedPct: 0, note: 'test' } })
      expect(classifyNetdataAlert(warn('out_of_disk_space_time', 1), off)).toMatchObject({ show: true })
    })
  })

  describe('a poll over a disk response', () => {
    it('does not raise out_of_disk_space_time at warning on node-4 at 62.9 % used (the live node-13 case), and the disk space cell stays solid', async () => {
      const obs = await pollWith(diskAt('out_of_disk_space_time', 'warning', 62.9))
      expect(diskAlerts(obs)).toEqual([])
      expect(cellNamed(obs, 'disk space')!.state).toBe('ok')
    })

    it('raises it at warning on node-4 at 86.0 % used, the live node-4 case: the Grafana "filling up" incident, text and all', async () => {
      const obs = await pollWith(diskAt('out_of_disk_space_time', 'warning', 86))
      const a = byRule(obs, 'Host disk filling up (node-4)')!
      expect(a).toMatchObject({ severity: 'warning', service: 'Host disks', value: '86.0% used, 14.0 GiB free of 100.0 GiB' })
      expect(a.annotations.summary).toContain('86.0% used')
      expect(diskAlerts(obs)).toHaveLength(1)
      expect(cellNamed(obs, 'disk space')!.state).toBe('firing')
    })

    it('raises the critical tier at 62.9 % used: a page, under the "full imminent" title', async () => {
      const obs = await pollWith(diskAt('out_of_disk_space_time', 'critical', 62.9))
      const a = byRule(obs, 'Host disk full imminent (node-4)')!
      expect(a).toMatchObject({ severity: 'page', severityLabel: 'critical', service: 'Host disks' })
      expect(a.annotations.summary).toContain('62.9% used')
      expect(a.labels.netdata_severity).toBe('critical')
    })

    it('drops disk_space_usage at warning under 80 % and keeps it above, so the recorded 89.5 % node-4 warning is still raised', async () => {
      expect(diskAlerts(await pollWith(diskAt('disk_space_usage', 'warning', 70)))).toEqual([])
      expect(diskAlerts(await pollWith(diskAt('disk_space_usage', 'warning', 89.5))).map((a) => a.rule)).toEqual(['Host disk space low (node-4)'])
      expect(diskAlerts(await pollWith(fixture('netdata-cloud-disk-space-warning.json'))).map((a) => a.rule)).toEqual(['Host disk space low (node-4)'])
    })

    it('applies the same line to inodes: a warning under 80 % of inodes used is dropped, the critical is raised', async () => {
      expect(diskAlerts(await pollWith(diskAt('out_of_disk_inodes_time', 'warning', 40, 'inodes'), 'disk.inodes'))).toEqual([])
      expect(diskAlerts(await pollWith(diskAt('out_of_disk_inodes_time', 'warning', 85, 'inodes'), 'disk.inodes')).map((a) => a.rule)).toEqual(['Netdata: disk inodes (node-4)'])
      const crit = await pollWith(diskAt('out_of_disk_inodes_time', 'critical', 40, 'inodes'), 'disk.inodes')
      expect(diskAlerts(crit).map((a) => [a.rule, a.severity])).toEqual([['Netdata: disk inodes (node-4)', 'page']])
    })

    it('a floor of 0 in the config brings back every warning', async () => {
      const off: NetdataCloudSourceConfig = { ...cfg, diskWarningFloor: { usedPct: 0, note: 'test' } }
      expect(diskAlerts(await pollWith(diskAt('out_of_disk_space_time', 'warning', 62.9), 'disk.space', off)).map((a) => a.rule)).toEqual(['Host disk filling up (node-4)'])
    })
  })

  describe('config', () => {
    const real = JSON.parse(readFileSync(new URL('./fixtures/watch.config.json', import.meta.url), 'utf8')) as WatchConfig
    const source = real.sources.find((s) => s.type === 'netdata-cloud') as NetdataCloudSourceConfig

    it('config/watch.example.json sets the floor at 80 with a one-line reason, and the policy reads it', () => {
      expect(source.diskWarningFloor?.usedPct).toBe(80)
      expect(source.diskWarningFloor?.note).toMatch(/^[^\n]+$/)
      expect(netdataPolicyOf(source).diskWarningFloorPct).toBe(80)
    })

    it('rejects a floor that is not a percent or has no one-line reason, naming the field', () => {
      const dir = mkdtempSync(join(tmpdir(), 'watch-floor-'))
      const write = (diskWarningFloor: unknown): string => {
        const copy = JSON.parse(JSON.stringify(real)) as WatchConfig
        Object.assign(copy.sources.find((s) => s.type === 'netdata-cloud')!, { diskWarningFloor })
        const path = join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`)
        writeFileSync(path, JSON.stringify(copy))
        return path
      }
      expect(() => loadConfig(write({ usedPct: 80, note: 'Owner rule.' }))).not.toThrow()
      expect(() => loadConfig(write({ usedPct: 0, note: 'Off.' }))).not.toThrow()
      expect(() => loadConfig(write({ usedPct: 101, note: 'x' }))).toThrow('diskWarningFloor.usedPct')
      expect(() => loadConfig(write({ usedPct: -1, note: 'x' }))).toThrow('diskWarningFloor.usedPct')
      expect(() => loadConfig(write({ usedPct: '80', note: 'x' }))).toThrow('diskWarningFloor.usedPct')
      expect(() => loadConfig(write({ usedPct: 80 }))).toThrow('diskWarningFloor.note')
      expect(() => loadConfig(write({ usedPct: 80, note: 'two\nlines' }))).toThrow('diskWarningFloor.note')
      expect(() => loadConfig(write(80))).toThrow('diskWarningFloor must be an object')
    })
  })
})

// ---- reachability -------------------------------------------------------------------------------------------------

describe('node reachability', () => {
  const withState = (name: string, state: string): any => fixture('netdata-cloud-nodes.json').map((n: any) => (n.name === name ? { ...n, state } : n))

  it('counts the reachable nodes of the room in the cell name', async () => {
    const obs = await createNetdataCloudSource(cfg, deps(fakeCloud())).poll()
    expect(obs.rules![0]).toMatchObject({ name: 'Netdata nodes reachable (7/7)', state: 'ok' })
  })

  it('needs two polls in a row before an unreachable fleet node is a page; the first poll only shows the cell half solid', async () => {
    const f = fakeCloud({ nodes: withState('node-3', 'unreachable') })
    const src = createNetdataCloudSource(cfg, deps(f))
    const first = await src.poll()
    expect(first.rules![0]).toMatchObject({ name: 'Netdata nodes reachable (6/7)', state: 'pending' })
    expect(first.firing.some((a) => a.rule.includes('unreachable'))).toBe(false)
    const second = await src.poll()
    expect(second.rules![0]).toMatchObject({ name: 'Netdata nodes reachable (6/7)', state: 'firing' })
    const a = second.firing.find((x) => x.rule === 'Netdata: node unreachable (node-3)')!
    expect(a).toMatchObject({ service: 'Netdata', severity: 'page', host: 'node-3', severityLabel: 'critical' })
    expect(a.labels.netdata_node_state).toBe('unreachable')
    expect(a.annotations.summary).toContain('node-3 is unreachable')
  })

  it('a blip of one poll leaves no alert, and the streak starts over', async () => {
    let state = 'unreachable'
    const f = fakeCloud({ nodes: withState('node-3', 'unreachable') })
    const inner = f.fetch
    const src = createNetdataCloudSource(cfg, deps({ fetch: ((u: string, i: RequestInit) => (String(u).endsWith('/nodes') && state === 'reachable' ? Promise.resolve(new Response(JSON.stringify(fixture('netdata-cloud-nodes.json')))) : inner(u, i))) as typeof fetch }))
    await src.poll()
    state = 'reachable'
    expect((await src.poll()).firing.some((a) => a.rule.includes('unreachable'))).toBe(false)
    state = 'unreachable'
    const again = await src.poll()
    expect(again.firing.some((a) => a.rule.includes('unreachable'))).toBe(false)
    expect(again.rules![0].state).toBe('pending')
  })

  it('an unreachable watch-only node is a warning after two polls', async () => {
    const src = createNetdataCloudSource(cfg, deps(fakeCloud({ nodes: withState('print', 'unreachable') })))
    await src.poll()
    const second = await src.poll()
    expect(second.firing.find((a) => a.rule === 'Netdata: node unreachable (print)')).toMatchObject({ severity: 'warning', severityLabel: 'warning' })
  })

  it('a configured node that is missing from the room counts as unreachable, and a node nobody configured is shown but never pages', async () => {
    const nodes = fixture('netdata-cloud-nodes.json').filter((n: any) => n.name !== 'node-2')
    nodes.push({ id: 'x', name: 'newbox', state: 'unreachable', version: 'v2.12.1', isDeleted: false })
    const src = createNetdataCloudSource(cfg, deps(fakeCloud({ nodes })))
    await src.poll()
    const obs = await src.poll()
    expect(obs.rules![0].name).toBe('Netdata nodes reachable (6/8)')
    expect(obs.firing.find((a) => a.rule === 'Netdata: node unreachable (node-2)')).toMatchObject({ severity: 'page' })
    expect(obs.firing.find((a) => a.rule === 'Netdata: node unreachable (newbox)')).toMatchObject({ severity: 'warning' })
    expect(obs.firing.find((a) => a.rule === 'Netdata: node unreachable (node-2)')!.annotations.summary).toContain('missing from the Netdata room')
  })

  describe('an ignoreNodes node (print: print spooler, not monitored)', () => {
    const ignoring: NetdataCloudSourceConfig = { ...cfg, watchOnlyNodes: ['mac-a1.example.net'], ignoreNodes: { print: 'print spooler, not monitored' } }

    it('raises nothing on a poll that used to raise the pending reboot, and the nodes cell no longer counts it (6/6, not 7/7)', async () => {
      const obs = await createNetdataCloudSource(ignoring, deps(fakeCloud())).poll()
      expect(obs.firing.map((a) => a.rule)).toEqual(['Host disk space low (node-4)'])
      expect(obs.firing.some((a) => a.host === 'print')).toBe(false)
      expect(obs.rules![0]).toMatchObject({ name: 'Netdata nodes reachable (6/6)', state: 'ok' })
      expect(obs.rules).toHaveLength(7)
      // the same room with print in the watch-only list is the old behaviour: 7/7 and the reboot alert
      const before = await createNetdataCloudSource(cfg, deps(fakeCloud())).poll()
      expect(before.rules![0].name).toBe('Netdata nodes reachable (7/7)')
      expect(before.firing.some((a) => a.host === 'print')).toBe(true)
    })

    it('is not expected for reachability: unreachable for ever, it is never an alert, a pending streak or a count', async () => {
      const src = createNetdataCloudSource(ignoring, deps(fakeCloud({ nodes: withState('print', 'unreachable') })))
      const first = await src.poll()
      expect(first.rules![0]).toMatchObject({ name: 'Netdata nodes reachable (6/6)', state: 'ok' })
      const second = await src.poll()
      expect(second.rules![0]).toMatchObject({ name: 'Netdata nodes reachable (6/6)', state: 'ok' })
      expect(second.firing.some((a) => a.rule.includes('unreachable') || a.host === 'print')).toBe(false)
    })

    it('missing from the room is not a finding either (configured in no list, so nothing expects it)', async () => {
      const nodes = fixture('netdata-cloud-nodes.json').filter((n: any) => n.name !== 'print')
      const src = createNetdataCloudSource(ignoring, deps(fakeCloud({ nodes })))
      await src.poll()
      const obs = await src.poll()
      expect(obs.rules![0]).toMatchObject({ name: 'Netdata nodes reachable (6/6)', state: 'ok' })
      expect(obs.firing.some((a) => a.rule.includes('print'))).toBe(false)
    })

    it('a node nobody listed and nobody ignored behaves as before: counted, and a warning once unreachable', async () => {
      const nodes = withState('print', 'unreachable')
      nodes.push({ id: 'x', name: 'newbox', state: 'unreachable', version: 'v2.12.1', isDeleted: false })
      const src = createNetdataCloudSource(ignoring, deps(fakeCloud({ nodes })))
      await src.poll()
      const obs = await src.poll()
      expect(obs.rules![0]).toMatchObject({ name: 'Netdata nodes reachable (6/7)', state: 'firing' })
      expect(obs.firing.filter((a) => a.rule.includes('unreachable')).map((a) => [a.rule, a.severity])).toEqual([['Netdata: node unreachable (newbox)', 'warning']])
    })

    it('an alert on print in a group response is dropped and print does not keep the group cell solid on its own', async () => {
      // the recorded disk warning, moved from node-4 onto print, with print as the only node that answered
      const data = fixture('netdata-cloud-disk-space-warning.json')
      const printNode = data.summary.nodes.find((n: any) => n.nm === 'print')
      data.summary.nodes = [printNode]
      data.summary.instances = data.summary.instances.map((i: any) => (i.ds?.sl > 0 ? { ...i, ni: printNode.ni } : i)).filter((i: any) => i.ni === printNode.ni)
      const poll = (config: NetdataCloudSourceConfig) => createNetdataCloudSource(config, deps(fakeCloud({ data: { 'disk.space': structuredClone(data) } }))).poll()
      // the control: watched as a watch-only node, the same response raises the disk warning on print
      expect((await poll(cfg)).firing.some((a) => a.host === 'print' && a.rule.includes('disk space'))).toBe(true)
      const obs = await poll(ignoring)
      expect(obs.firing.some((a) => a.host === 'print')).toBe(false)
      expect(obs.rules!.find((c) => c.name === 'Netdata disk space alerts')).toMatchObject({ state: 'nodata' })
    })
  })

  it('ignores a deleted node', async () => {
    const nodes = fixture('netdata-cloud-nodes.json').map((n: any) => (n.name === 'print' ? { ...n, state: 'unreachable', isDeleted: true } : n))
    const src = createNetdataCloudSource({ ...cfg, watchOnlyNodes: ['mac-a1.example.net'] }, deps(fakeCloud({ nodes })))
    await src.poll()
    const obs = await src.poll()
    expect(obs.firing.some((a) => a.host === 'print' && a.rule.includes('unreachable'))).toBe(false)
  })
})

// ---- failures -----------------------------------------------------------------------------------------------------

async function failure(f: { fetch: typeof fetch }, extra: Partial<SourceDeps> = {}, config = cfg): Promise<string> {
  try {
    await createNetdataCloudSource(config, deps(f, extra)).poll()
  } catch (err) {
    return (err as Error).message
  }
  throw new Error('the poll did not fail')
}

describe('source-level failures', () => {
  it('a missing token env is a clear error and no request at all', async () => {
    const f = fakeCloud()
    const message = await failure(f, { env: {} })
    expect(message).toContain('NETDATA_CLOUD_TOKEN')
    expect(message).toContain('not set or is empty')
    expect(f.calls).toHaveLength(0)
  })

  it('an empty or blank token is the same error', async () => {
    for (const value of ['', '   ']) {
      const f = fakeCloud()
      expect(await failure(f, { env: { NETDATA_CLOUD_TOKEN: value } })).toContain('NETDATA_CLOUD_TOKEN')
      expect(f.calls).toHaveLength(0)
    }
  })

  it('401 on the first request fails the poll after one request, naming the status and never the token or the body', async () => {
    const f = fakeCloud({ nodesStatus: 401, nodes: fixture('netdata-cloud-401.json') })
    const message = await failure(f)
    expect(message).toContain('HTTP 401')
    expect(message).toContain('rejects the API token')
    expect(message).not.toContain(FAKE_TOKEN)
    expect(message).not.toContain('malformed API token')
    expect(f.calls).toHaveLength(1)
  })

  it('403 on a data query ends the poll too', async () => {
    const f = fakeCloud({ dataStatus: { 'disk.space': 403 } })
    expect(await failure(f)).toContain('HTTP 403')
    expect(f.calls).toHaveLength(2)
  })

  it('a timeout on the nodes request is a source failure that says so', async () => {
    const f = fakeCloud({ fail: () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) })
    const message = await failure(f)
    expect(message).toBe('Netdata Cloud nodes request failed: timed out after 10 s')
  })

  it('a refused connection names the error code only', async () => {
    const f = fakeCloud({ fail: () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) })
    expect(await failure(f)).toBe('Netdata Cloud nodes request failed: ECONNREFUSED')
  })

  it('a body that is not JSON fails the poll', async () => {
    const f = fakeCloud({ fail: () => new Response('<html>bad gateway</html>', { status: 200 }) })
    expect(await failure(f)).toBe('Netdata Cloud nodes returned a body that is not JSON')
  })

  it('a nodes body that is not a list fails the poll', async () => {
    expect(await failure(fakeCloud({ nodes: { error: 'x' } }))).toBe('Netdata Cloud nodes response is not a list')
  })

  it('HTTP 503 on the nodes request fails the poll', async () => {
    expect(await failure(fakeCloud({ nodesStatus: 503, nodes: {} }))).toBe('Netdata Cloud nodes returned HTTP 503')
  })

  it('a response past the size limit is refused before it is read, with the way out in the message', async () => {
    const huge = new Response('{}', { status: 200, headers: { 'content-length': String(90 * 1024 * 1024) } })
    const f = fakeCloud({ data: { 'disk.space': huge } })
    const src = createNetdataCloudSource(cfg, deps(f))
    const obs = await src.poll()
    expect(cellNamed(obs, 'disk space')!.state).toBe('error')
    expect(obs.rules!.filter((c) => c.state === 'error')).toHaveLength(1)
    // The same failure as a source-level one when it is the only thing asked.
    const only: NetdataCloudSourceConfig = { ...cfg, groups: [cfg.groups?.[0] ?? DEFAULT_GROUPS[0]] }
    const message = await failure(fakeCloud({ data: { 'disk.space': new Response('{}', { status: 200, headers: { 'content-length': String(90 * 1024 * 1024) } }) } }), {}, only)
    expect(message).toContain('over the 6 MB limit')
    expect(message).toContain("narrow the group's contexts")
  })

  it('never puts the token or the URL into an Observation', async () => {
    const obs = await createNetdataCloudSource(cfg, deps(fakeCloud())).poll()
    const text = JSON.stringify(obs)
    expect(text).not.toContain(FAKE_TOKEN)
    expect(text).not.toContain('Bearer')
    expect(text).not.toContain('app.netdata.cloud')
  })

  it('backs off after repeated failures instead of asking again at once, and recovers on the first success', async () => {
    let status = 503
    let now = Date.parse(NOW)
    const f = fakeCloud({ fail: () => (status === 503 ? new Response('{}', { status: 503 }) : undefined) })
    const src = createNetdataCloudSource(cfg, deps(f, { nowIso: () => new Date(now).toISOString() }))
    const attempt = async (): Promise<string> => {
      try {
        await src.poll()
        return 'ok'
      } catch (err) {
        return (err as Error).message
      }
    }
    expect(await attempt()).toBe('Netdata Cloud nodes returned HTTP 503')
    expect(f.calls).toHaveLength(1)
    now += 60_000
    expect(await attempt()).toBe('Netdata Cloud nodes returned HTTP 503')
    expect(f.calls).toHaveLength(2)
    now += 60_000
    // The second failure doubled the wait to 2 polls: this poll is skipped without a request.
    expect(await attempt()).toMatch(/^backing off after: Netdata Cloud nodes returned HTTP 503 \(next request in \d+ s\)$/)
    expect(f.calls).toHaveLength(2)
    now += 60_000
    status = 200
    expect(await attempt()).toBe('ok')
    expect(f.calls.length).toBeGreaterThan(2)
    now += 60_000
    expect(await attempt()).toBe('ok')
  })

  it('honours Retry-After on a 429 and stops asking within the poll', async () => {
    let now = Date.parse(NOW)
    const f = fakeCloud({ dataStatus: { 'disk.inodes': 429 }, data: { 'disk.inodes': new Response('{}', { status: 429, headers: { 'retry-after': '240' } }) } })
    const src = createNetdataCloudSource(cfg, deps(f, { nowIso: () => new Date(now).toISOString() }))
    await expect(src.poll()).rejects.toThrow('HTTP 429')
    const made = f.calls.length
    expect(made).toBe(3)
    now += 60_000
    await expect(src.poll()).rejects.toThrow(/backing off after: .*429.* \(next request in (1[5-9]\d|2[0-3]\d) s\)/)
    expect(f.calls).toHaveLength(made)
    now += 240_000
    await expect(src.poll()).rejects.toThrow('HTTP 429')
    expect(f.calls.length).toBe(made + 3)
  })
})

describe('a group that fails does not take the others with it', () => {
  it('shows its cell as error and carries its alerts over, so a failing query never resolves what it last saw', async () => {
    let failSpace = false
    const f = fakeCloud({ fail: (c) => (failSpace && c.method === 'POST' && c.body.scope.contexts[0] === 'disk.space' ? new Response('{}', { status: 500 }) : undefined) })
    const src = createNetdataCloudSource(cfg, deps(f))
    const first = await src.poll()
    expect(byRule(first, 'Host disk space low (node-4)')).toBeDefined()
    failSpace = true
    const second = await src.poll()
    expect(second.complete).toBe(true)
    expect(cellNamed(second, 'disk space')).toMatchObject({ state: 'error', evaluatedAt: undefined })
    expect(cellNamed(second, 'disk inode')!.state).toBe('ok')
    expect(byRule(second, 'Host disk space low (node-4)')!.key).toBe(byRule(first, 'Host disk space low (node-4)')!.key)
    // And it clears the moment the query answers with nothing selected.
    failSpace = false
    const cleared: Record<string, unknown> = { 'disk.space': clearData() }
    const third = await createNetdataCloudSource(cfg, deps(fakeCloud({ data: cleared }))).poll()
    expect(byRule(third, 'Host disk space low (node-4)')).toBeUndefined()
    expect(cellNamed(third, 'disk space')!.state).toBe('ok')
  })

  it('a group whose answer is HTTP 400 gets an error cell and names Netdata\'s error key', async () => {
    const f = fakeCloud({ dataStatus: { 'clickhouse.*': 400 }, data: { 'clickhouse.*': fixture('netdata-cloud-400.json') } })
    const obs = await createNetdataCloudSource(cfg, deps(f)).poll()
    expect(cellNamed(obs, 'ClickHouse')!.state).toBe('error')
    expect(cellNamed(obs, 'disk space')!.state).toBe('firing')
  })

  it('logs why a group failed once, and again only when it recovers and fails anew', async () => {
    const lines: string[] = []
    let fail = true
    const f = fakeCloud({ fail: (c) => (fail && c.method === 'POST' && c.body.scope.contexts[0] === 'clickhouse.*' ? new Response('{}', { status: 400 }) : undefined) })
    const src = createNetdataCloudSource(cfg, deps(f, { log: (l) => lines.push(l) }))
    await src.poll()
    await src.poll()
    expect(lines).toEqual(['netdata-cloud group clickhouse failed: Netdata Cloud clickhouse query returned HTTP 400'])
    fail = false
    await src.poll()
    fail = true
    await src.poll()
    expect(lines).toHaveLength(2)
    expect(lines.join('\n')).not.toContain(FAKE_TOKEN)
  })

  it('stops asking after two failures in a row and marks the rest not answering', async () => {
    const f = fakeCloud({ dataStatus: { 'disk.inodes': 500, 'md.health': 500 }, data: { 'disk.inodes': {}, 'md.health': {} } })
    const obs = await createNetdataCloudSource(cfg, deps(f)).poll()
    expect(f.calls).toHaveLength(4)
    expect(obs.rules!.map((c) => [c.id.replace('netdata-cloud:', ''), c.state])).toEqual([
      ['nodes', 'ok'],
      ['disk-space', 'firing'],
      ['disk-inodes', 'error'],
      ['disk-health', 'error'],
      ['clickhouse', 'error'],
      ['docker', 'error'],
      ['host', 'error']
    ])
  })

  it('when every group fails the poll fails, so the source goes stale instead of looking alive', async () => {
    const f = fakeCloud({ fail: (c) => (c.method === 'POST' ? new Response('{}', { status: 502 }) : undefined) })
    const message = await failure(f)
    expect(message).toBe('Netdata Cloud disk-space query returned HTTP 502')
  })

  it('keeps what an agent last said when its node did not answer this time', async () => {
    let silent = false
    const f = fakeCloud({
      data: {
        'disk.space': (): unknown => {
          const d = fixture('netdata-cloud-disk-space-warning.json')
          if (silent) {
            d.summary.nodes.find((n: any) => n.nm === 'node-4').st = { ai: 1, code: 504 }
            d.summary.instances.find((i: any) => i.ni === 1 && i.id === 'disk_space./').ds = { ex: 3 }
          }
          return d
        }
      }
    })
    const src = createNetdataCloudSource(cfg, deps(f))
    expect(byRule(await src.poll(), 'Host disk space low (node-4)')).toBeDefined()
    silent = true
    const second = await src.poll()
    expect(byRule(second, 'Host disk space low (node-4)')).toBeDefined()
    expect(cellNamed(second, 'disk space')!.state).toBe('firing')
  })

  it('reads a group as no data when no agent answered', async () => {
    const d = fixture('netdata-cloud-disk-inodes-clear.json')
    for (const n of d.summary.nodes) n.st = { code: 504 }
    const obs = await createNetdataCloudSource(cfg, deps(fakeCloud({ data: { 'disk.inodes': d } }))).poll()
    expect(cellNamed(obs, 'inode')).toMatchObject({ state: 'nodata', evaluatedAt: undefined })
  })

  it('uses the poll time when an agent clock is far from ours', async () => {
    const d = fixture('netdata-cloud-disk-inodes-clear.json')
    for (const a of d.agents) a.now = 1700000000
    const obs = await createNetdataCloudSource(cfg, deps(fakeCloud({ data: { 'disk.inodes': d } }))).poll()
    expect(cellNamed(obs, 'inode')!.evaluatedAt).toBe(NOW)
  })
})

// ---- ambiguity inside a poll --------------------------------------------------------------------------------------

describe('a poll that has to tell two alerts of one group apart', () => {
  it('asks per name and status, within the budget, and writes each alert under its own title', async () => {
    const both = fixture('netdata-cloud-disk-space-warning.json')
    const node1 = both.summary.nodes.find((n: any) => n.nm === 'node-1').ni
    both.summary.alerts = [{ nm: 'disk_space_usage', cl: 36, wr: 1 }, { nm: 'out_of_disk_space_time', cl: 44, cr: 1 }]
    both.summary.instances.find((i: any) => i.ni === node1 && i.id === 'disk_space./').ds = { sl: 3, qr: 3 }
    both.summary.instances.find((i: any) => i.ni === node1 && i.id === 'disk_space./').al = { cl: 1, cr: 1, ot: 1 }
    const f = fakeCloud({
      data: {
        'disk.space': (body: any): unknown => {
          const sel: string[] = body.selectors.alerts
          if (sel.length > 1) return both
          const d = JSON.parse(JSON.stringify(both))
          const keep = sel[0] === 'disk_space_usage:WARNING' ? [1] : sel[0] === 'out_of_disk_space_time:CRITICAL' ? [node1] : []
          for (const i of d.summary.instances) if (!keep.includes(i.ni) || i.id !== 'disk_space./') i.ds = { ex: 3 }
          return d
        }
      }
    })
    const obs = await createNetdataCloudSource(cfg, deps(f)).poll()
    expect(f.calls.filter((c) => c.body?.scope.contexts[0] === 'disk.space').map((c) => c.body.selectors.alerts.join(' '))).toEqual([
      'disk_space_usage:WARNING disk_space_usage:CRITICAL out_of_disk_space_time:WARNING out_of_disk_space_time:CRITICAL',
      'disk_space_usage:WARNING',
      'out_of_disk_space_time:CRITICAL'
    ])
    expect(obs.firing.map((a) => [a.host, a.rule, a.severity]).sort()).toContainEqual(['node-1', 'Host disk full imminent (node-1)', 'page'])
    expect(obs.firing.map((a) => [a.host, a.rule, a.severity]).sort()).toContainEqual(['node-4', 'Host disk space low (node-4)', 'warning'])
  })
})

// ---- the engine, the wall and the stale mechanism -----------------------------------------------------------------

const wallCfg: WatchConfig = {
  baseUrl: 'https://watch.test',
  port: 0,
  host: '127.0.0.1',
  dataDir: ':memory:',
  historyHours: 24,
  staleAfterMisses: 3,
  sources: [{ id: 'grafana', type: 'grafana', url: 'http://g', tokenEnv: 'X', pollSec: 10 }, cfg],
  serviceMap,
  channels: [],
  routes: [
    { id: 'page', match: { severity: ['page'] }, receivers: ['phone'], mode: 'all', groupWaitSec: 0, groupIntervalSec: 60, repeatIntervalSec: 600 },
    { id: 'warning', match: { severity: ['warning'] }, receivers: [], mode: 'all', groupWaitSec: 0, groupIntervalSec: 300, repeatIntervalSec: 86400 }
  ],
  quietHours: null
}

describe('on the wall', () => {
  const T0 = Date.parse(NOW)
  const grafanaDisk = (host: string, title: string, severity: string): Alert =>
    makeAlert(
      {
        origin: 'grafana',
        fingerprint: 'a1b2c3d4e5f60718',
        rule: title,
        labels: { alertname: title, component: 'host-disk', host, severity },
        annotations: { summary: `${host} disk under 98 GB free` },
        startsAt: NOW,
        via: { source: 'grafana', kind: 'grafana', lastSeen: NOW },
        raw: {}
      },
      serviceMap,
      NOW
    )

  it('joins the Grafana alert in ONE incident: one tile for the node-4 disk, reach 2, still a warning and still wall-only', async () => {
    const engine = new Engine(openDb(':memory:'), wallCfg, () => T0)
    engine.ingest({ source: 'grafana', kind: 'grafana', at: NOW, firing: [grafanaDisk('node-4', 'Host disk space low (node-4)', 'warn')], resolved: [], complete: true })
    engine.ingest(await createNetdataCloudSource(cfg, deps(fakeCloud())).poll())
    const wall = engine.wall()
    const tile = wall.incidents.find((i) => i.key === 'Host disks|Host disk space low (node-4)')!
    expect(tile.alerts.map((a) => a.origin).sort()).toEqual(['grafana', 'netdata-cloud'])
    expect(tile.severity).toBe('warning')
    expect(tile.wallOnly).toBe(true)
    expect(tile.state.instances).toBe(2)
    expect(wall.incidents.filter((i) => i.service === 'Host disks')).toHaveLength(1)
    // The pending reboot is its own wall-only warning on the Netdata service.
    expect(wall.incidents.find((i) => i.key === 'Netdata|Netdata: reboot pending after update (print)')).toMatchObject({ severity: 'warning', wallOnly: true })
  })

  it('a critical disk on node-4 joins "Host disk full imminent (node-4)", which is a page that reaches the phone route', async () => {
    const engine = new Engine(openDb(':memory:'), wallCfg, () => T0)
    const critical = fixture('netdata-cloud-disk-space-warning.json')
    critical.summary.instances.find((i: any) => i.ni === 1 && i.id === 'disk_space./').al = { cl: 1, cr: 1, ot: 1 }
    engine.ingest({ source: 'grafana', kind: 'grafana', at: NOW, firing: [grafanaDisk('node-4', 'Host disk full imminent (node-4)', 'page')], resolved: [], complete: true })
    engine.ingest(await createNetdataCloudSource(cfg, deps(fakeCloud({ data: { 'disk.space': critical } }))).poll())
    const tile = engine.wall().incidents.find((i) => i.key === 'Host disks|Host disk full imminent (node-4)')!
    expect(tile.alerts).toHaveLength(2)
    expect(tile.severity).toBe('page')
    expect(tile.wallOnly).toBe(false)
  })

  it('resolves an alert the next complete poll no longer reports, and the cell goes solid', async () => {
    const engine = new Engine(openDb(':memory:'), wallCfg, () => T0)
    engine.ingest(await createNetdataCloudSource(cfg, deps(fakeCloud())).poll())
    expect(engine.wall().incidents.some((i) => i.key === 'Host disks|Host disk space low (node-4)')).toBe(true)
    engine.ingest(await createNetdataCloudSource(cfg, deps(fakeCloud({ data: { 'disk.space': clearData() } }))).poll())
    expect(engine.wall().incidents.some((i) => i.key === 'Host disks|Host disk space low (node-4)')).toBe(false)
  })

  it('shows the Netdata tile with real cells and dashes them through the source-stale mechanism after three missed polls', async () => {
    let clock = T0
    const engine = new Engine(openDb(':memory:'), wallCfg, () => clock)
    engine.ingest(await createNetdataCloudSource(cfg, deps(fakeCloud({ data: { 'disk.space': clearData(), 'mem.available': clearData() } }))).poll())
    engine.recordSource('netdata-cloud', true, null)
    const tile = () => engine.wall().health.find((h) => h.service === 'Netdata')!
    expect(tile().cells.map((c) => c.state)).toEqual(Array(7).fill('ok'))
    expect(engine.wall().sources.find((s) => s.id === 'netdata-cloud')).toMatchObject({ kind: 'netdata-cloud', state: 'ok', rules: 7, misses: 0 })
    for (let i = 1; i <= 3; i += 1) {
      clock += 60_000
      engine.recordSource('netdata-cloud', false, 'Netdata Cloud nodes request failed: timed out after 10 s')
      const state = engine.wall().sources.find((s) => s.id === 'netdata-cloud')!.state
      expect(state).toBe(i < 3 ? 'error' : 'stale')
    }
    expect(tile().cells.map((c) => c.state)).toEqual(Array(7).fill('stale'))
    expect(engine.wall().header.stale).toBe(true)
    const stale = engine.staleAlerts((id) => makeAlert({ origin: 'self', fingerprint: `source-stale:${id}`, rule: `${id} is not answering`, labels: { severity: 'warning' }, startsAt: NOW, via: { source: 'self', kind: 'self', lastSeen: NOW }, raw: {} }, [], NOW))
    expect(stale.map((a) => a.rule)).toContain('netdata-cloud is not answering')
  })
})

// ---- which machine an alert means ---------------------------------------------------------------------------------

describe('which machine an alert means', () => {
  const CLOUD_URL = 'https://app.netdata.cloud/spaces/example-space/rooms/all-nodes'
  const PRINT_ID = '00000000-0000-4000-8000-000000000007'
  const S4_ID = '00000000-0000-4000-8000-000000000009'
  const note = { dns: 'print.example.com', note: 'A DigitalOcean droplet. nginx on it serves print.example.com, example.com, n.example.com and gamejam.example.com.' }
  const named: NetdataCloudSourceConfig = { ...cfg, cloudUrl: CLOUD_URL, nodes: { print: note } }
  const printNode = fixture('netdata-cloud-nodes.json').find((n: any) => n.name === 'print')

  describe('nodeUrl: the node page in Netdata Cloud', () => {
    it('is the room page and /nodes/<id>', () => {
      expect(nodeUrl(CLOUD_URL, PRINT_ID)).toBe(`${CLOUD_URL}/nodes/${PRINT_ID}`)
    })

    it('keeps only the space and room of whatever page the config names (a trailing slash, /overview, a query or a fragment)', () => {
      for (const url of [`${CLOUD_URL}/`, `${CLOUD_URL}/overview`, `${CLOUD_URL}?x=1`, `${CLOUD_URL}#metrics_correlation=false`]) {
        expect(nodeUrl(url, PRINT_ID)).toBe(`${CLOUD_URL}/nodes/${PRINT_ID}`)
      }
    })

    it('is nothing when the URL is not a room page, the id is blank or the URL is not http(s)', () => {
      expect(nodeUrl(undefined, PRINT_ID)).toBeUndefined()
      expect(nodeUrl(CLOUD_URL, '')).toBeUndefined()
      expect(nodeUrl('https://app.netdata.cloud/', PRINT_ID)).toBeUndefined()
      expect(nodeUrl('https://app.netdata.cloud/spaces/example-space', PRINT_ID)).toBeUndefined()
      expect(nodeUrl('javascript:alert(1)//spaces/a/rooms/b', PRINT_ID)).toBeUndefined()
    })

    it('encodes an id so it cannot add a path or a query', () => {
      expect(nodeUrl(CLOUD_URL, 'a/b?c')).toBe(`${CLOUD_URL}/nodes/a%2Fb%3Fc`)
    })
  })

  describe('nodeIdentity: the words that name a machine', () => {
    const node = (extra: Record<string, unknown> = {}, labels: Record<string, string> = {}): any => ({
      id: PRINT_ID,
      name: 'print',
      state: 'reachable',
      version: 'v2.12.1',
      osName: 'Ubuntu',
      osVersion: '24.04.3 LTS (Noble Numbat)',
      kernelVersion: '6.8.0-71-generic',
      hostLabels: { _net_default_iface_ip: '203.0.113.10', _hw_product_name: 'DigitalOcean_Droplet', _hw_sys_vendor: 'DigitalOcean', ...labels },
      ...extra
    })
    const identity = (n: any, dns?: string) => nodeIdentity('print', n ? readCloudNodes([n])[0] : undefined, dns ? { dns } : undefined, CLOUD_URL)

    it('is name, then the public name and the address in brackets', () => {
      expect(identity(node(), 'print.example.com').label).toBe('print (print.example.com, 203.0.113.10)')
    })

    it('drops what it does not know: the address alone, the public name alone, or just the name', () => {
      expect(identity(node()).label).toBe('print (203.0.113.10)')
      expect(identity(node({}, { _net_default_iface_ip: 'unknown' }), 'print.example.com').label).toBe('print (print.example.com)')
      expect(identity(node({}, { _net_default_iface_ip: 'unknown' })).label).toBe('print')
      expect(identity(undefined).label).toBe('print')
    })

    it('does not trust an address that is not one', () => {
      expect(identity(node({}, { _net_default_iface_ip: 'x; rm -rf /' })).label).toBe('print')
      expect(identity(node({}, { _net_default_iface_ip: '' })).label).toBe('print')
    })

    it('reads the platform from what the agent reports: vendor and product, system, running kernel', () => {
      const id = identity(node(), 'print.example.com')
      expect(id.platform).toBe('DigitalOcean Droplet, Ubuntu 24.04.3 LTS, kernel 6.8.0-71-generic')
      expect(id.kernel).toBe('6.8.0-71-generic')
      expect(id.ip).toBe('203.0.113.10')
      expect(id.url).toBe(`${CLOUD_URL}/nodes/${PRINT_ID}`)
    })

    it('says nothing about a platform the agent did not describe', () => {
      expect(identity(undefined).platform).toBe('')
      expect(identity(node({ osName: undefined, osVersion: undefined, kernelVersion: undefined }, { _hw_product_name: 'None', _hw_sys_vendor: 'None' })).platform).toBe('')
    })
  })

  describe('a poll over the room', () => {
    it('the pending reboot on print says which machine, what is pending and where to open it', async () => {
      const obs = await createNetdataCloudSource(named, deps(fakeCloud())).poll()
      const a = byRule(obs, 'Netdata: reboot pending after update (print)')!
      expect(a.annotations.summary).toBe('print (print.example.com, 203.0.113.10) needs a reboot to finish installing updates')
      expect(a.annotations.description).toContain('kernel 6.8.0-71-generic')
      expect(a.annotations.description).toContain('Nothing pages for this')
      expect(a.annotations.description).toContain('print is not a fleet node')
      expect(a.annotations.where).toContain('print (print.example.com, 203.0.113.10)')
      expect(a.annotations.where).toContain('DigitalOcean Droplet, Ubuntu 24.04.3 LTS, kernel 6.8.0-71-generic')
      expect(a.annotations.where).toContain('nginx on it serves print.example.com')
      expect(a.annotations.where).toContain('system.post_update_reboot_status')
    })

    it('keeps the incident title and key: saved links already point at it', async () => {
      const obs = await createNetdataCloudSource(named, deps(fakeCloud())).poll()
      const a = byRule(obs, 'Netdata: reboot pending after update (print)')!
      expect(incidentKeyOf(a.service, a.rule)).toBe('Netdata|Netdata: reboot pending after update (print)')
      expect(a.host).toBe('print')
    })

    it('stays a warning that reaches the wall only: the node is watch-only', async () => {
      const obs = await createNetdataCloudSource(named, deps(fakeCloud())).poll()
      const a = byRule(obs, 'Netdata: reboot pending after update (print)')!
      expect(a).toMatchObject({ severity: 'warning', severityLabel: 'warning' })
      expect(a.labels).toMatchObject({ severity: 'warning', netdata_severity: 'warning' })
    })

    it('labels the machine: its node id, its address and its public name', async () => {
      const obs = await createNetdataCloudSource(named, deps(fakeCloud())).poll()
      const a = byRule(obs, 'Netdata: reboot pending after update (print)')!
      expect(a.labels).toMatchObject({ host: 'print', instance: 'print', netdata_node_id: PRINT_ID, host_ip: '203.0.113.10', host_dns: 'print.example.com' })
    })

    it('opens the node page in Netdata Cloud, not the room', async () => {
      const obs = await createNetdataCloudSource(named, deps(fakeCloud())).poll()
      const a = byRule(obs, 'Netdata: reboot pending after update (print)')!
      const url = `${CLOUD_URL}/nodes/${PRINT_ID}`
      expect(a.generatorURL).toBe(url)
      expect(a.links).toEqual({ generator: url })
      expect(a.via).toEqual([{ source: 'netdata-cloud', kind: 'netdata-cloud', lastSeen: NOW, url }])
      // the cells still open the room
      expect(obs.rules!.every((c) => c.url === CLOUD_URL)).toBe(true)
    })

    it('without a cloudUrl there is no link, as before', async () => {
      const obs = await createNetdataCloudSource({ ...named, cloudUrl: undefined }, deps(fakeCloud())).poll()
      const a = byRule(obs, 'Netdata: reboot pending after update (print)')!
      expect(a.generatorURL).toBeUndefined()
      expect(a.links).toEqual({})
      expect(a.annotations.summary).toBe('print (print.example.com, 203.0.113.10) needs a reboot to finish installing updates')
    })

    it('without a note it still names the address Cloud reports', async () => {
      const obs = await createNetdataCloudSource({ ...named, nodes: undefined }, deps(fakeCloud())).poll()
      const a = byRule(obs, 'Netdata: reboot pending after update (print)')!
      expect(a.annotations.summary).toBe('print (203.0.113.10) needs a reboot to finish installing updates')
      expect(a.labels.host_dns).toBeUndefined()
    })

    it('a node whose address Cloud does not know is named as before, and still links to its own page', async () => {
      const obs = await createNetdataCloudSource(named, deps(fakeCloud())).poll()
      const a = byRule(obs, 'Host disk space low (node-4)')!
      expect(a.annotations.summary).toBe('node-4 disk space (/) is at warning: 89.5% used, 91.2 GiB free of 914.7 GiB')
      expect(a.generatorURL).toBe(`${CLOUD_URL}/nodes/${S4_ID}`)
      expect(a.labels.host_ip).toBeUndefined()
      expect(a.labels.netdata_node_id).toBe(S4_ID)
    })

    it('every alert kind names its machine: a disk alert on print says so in its headline', async () => {
      const data = fixture('netdata-cloud-disk-space-warning.json')
      data.summary.nodes.find((n: any) => n.nm === 'node-4').nm = 'print'
      const src = createNetdataCloudSource(named, deps(fakeCloud({ data: { 'disk.space': data } })))
      const a = (await src.poll()).firing.find((x) => x.rule === 'Netdata: disk space (print)')!
      expect(a.annotations.summary).toBe('print (print.example.com, 203.0.113.10) disk space (/) is at warning: 89.5% used, 91.2 GiB free of 914.7 GiB')
    })

    it('an unreachable node names its machine and links to its page', async () => {
      const nodes = fixture('netdata-cloud-nodes.json').map((n: any) => (n.name === 'print' ? { ...n, state: 'unreachable' } : n))
      const src = createNetdataCloudSource(named, deps(fakeCloud({ nodes })))
      await src.poll()
      const a = (await src.poll()).firing.find((x) => x.rule === 'Netdata: node unreachable (print)')!
      expect(a.annotations.summary).toBe('print (print.example.com, 203.0.113.10) is unreachable: Netdata Cloud cannot reach its agent')
      expect(a.generatorURL).toBe(`${CLOUD_URL}/nodes/${PRINT_ID}`)
      expect(a.labels.netdata_node_id).toBe(PRINT_ID)
    })

    it('a node missing from the room is named by its note, and links to the room because it has no page', async () => {
      const nodes = fixture('netdata-cloud-nodes.json').filter((n: any) => n.name !== 'print')
      const src = createNetdataCloudSource(named, deps(fakeCloud({ nodes })))
      await src.poll()
      const a = (await src.poll()).firing.find((x) => x.rule === 'Netdata: node unreachable (print)')!
      expect(a.annotations.summary).toBe('print (print.example.com) is missing from the Netdata room: Netdata Cloud cannot reach its agent')
      expect(a.generatorURL).toBe(CLOUD_URL)
    })

    it('an alert already open from the release before gets the node page and the new words on its next poll, and keeps its start', async () => {
      const engine = new Engine(openDb(':memory:'), wallCfg, () => Date.parse(NOW))
      const before = await createNetdataCloudSource(named, deps(fakeCloud(), { nowIso: () => '2026-10-15T15:00:20.130Z' })).poll()
      // what that release left in the database: the room's page as the link and the bare headline
      for (const a of before.firing) {
        a.generatorURL = CLOUD_URL
        a.links = { generator: CLOUD_URL }
        a.via = a.via.map((v) => ({ ...v, url: CLOUD_URL }))
        a.annotations.summary = 'print reboot pending after update is at warning'
      }
      engine.ingest(before)
      engine.ingest(await createNetdataCloudSource(named, deps(fakeCloud())).poll())
      const tile = engine.wall().incidents.find((i) => i.key === 'Netdata|Netdata: reboot pending after update (print)')!
      expect(tile.alerts).toHaveLength(1)
      const url = `${CLOUD_URL}/nodes/${PRINT_ID}`
      expect(tile.alerts[0]).toMatchObject({
        generatorURL: url,
        links: { generator: url },
        startsAt: '2026-10-15T15:00:20.130Z',
        annotations: { summary: 'print (print.example.com, 203.0.113.10) needs a reboot to finish installing updates' }
      })
      expect(tile.startsAt).toBe('2026-10-15T15:00:20.130Z')
    })

    it('the fixture is the live record of print', () => {
      expect(printNode).toMatchObject({ id: PRINT_ID, osName: 'Ubuntu', kernelVersion: '6.8.0-71-generic', hostLabels: { _net_default_iface_ip: '203.0.113.10' } })
    })
  })
})

// ---- the config ---------------------------------------------------------------------------------------------------

describe('config/watch.example.json', () => {
  const real = JSON.parse(readFileSync(new URL('./fixtures/watch.config.json', import.meta.url), 'utf8')) as WatchConfig
  const source = real.sources.find((s) => s.type === 'netdata-cloud') as NetdataCloudSourceConfig | undefined

  it('has the Netdata Cloud pull source, polling every 60 s with the token named by env var', () => {
    expect(source).toMatchObject({
      id: 'netdata-cloud',
      url: 'https://app.netdata.cloud',
      tokenEnv: 'NETDATA_CLOUD_TOKEN',
      spaceId: SPACE,
      roomId: ROOM,
      pollSec: 60,
      fleetNodes: ['node-1', 'node-2', 'node-3', 'node-4', 'node-5', 'node-6', 'node-7', 'node-8', 'node-13', 'node-14', 'node-15'],
      watchOnlyNodes: ['mac-a1.example.net']
    })
    expect(JSON.stringify(source)).not.toMatch(/Bearer|eyJ/)
  })

  // The incident that started this (2026-10-16, "Netdata: OOM kills (node-15)" said "node-15 is not a fleet node, so nothing it reports pages"): node-15 joined the
  // example-app cluster on 2026-10-11 and this list still stopped at node-5, while the netdata-fleet source's own list had been extended to all eleven.
  // Two lists of one roster drift; this pins them together, and pins what a cluster node is judged as.
  describe('the fleet roster', () => {
    const fleetSource = real.sources.find((s) => s.type === 'netdata-fleet') as NetdataFleetSourceConfig
    const CLUSTER_NODES = ['node-8', 'node-13', 'node-14', 'node-15']

    it('is the netdata-fleet source\'s list, node for node: a server one of them watches is a server both judge', () => {
      expect([...(source?.fleetNodes ?? [])].sort()).toEqual([...fleetSource.fleetNodes].sort())
      expect(source?.watchOnlyNodes).toEqual(fleetSource.watchOnlyNodes)
    })

    it('holds every Kubernetes node of example-app (they run the prod and dev workloads) and not the cluster-state collector, which is no host', () => {
      for (const n of CLUSTER_NODES) expect(source?.fleetNodes, n).toContain(n)
      expect(source?.fleetNodes).not.toContain('netdata-k8s-state')
      expect(fleetSource.k8sNodes).toContain('netdata-k8s-state')
    })

    it('judges a cluster node\'s alerts as fleet alerts: not watch-only (so no "not a fleet node" line on the incident) and a full disk pages', () => {
      const real_ = netdataPolicyOf(source!, fleetSource.fleetNodes)
      for (const node of CLUSTER_NODES) {
        expect(classifyNetdataAlert(finding(node, 'oom_kill', 'warning', 'mem.oom_kill'), real_), node).toMatchObject({ show: true, rule: `Netdata: OOM kills (${node})`, severity: 'warning', watchOnly: false })
        expect(classifyNetdataAlert({ ...finding(node, 'out_of_disk_space_time', 'critical'), usedPct: 62.9 }, real_), node).toMatchObject({ show: true, severity: 'page', watchOnly: false })
      }
      // and a node nobody listed is still the watch-only one it was
      expect(classifyNetdataAlert(finding('s99', 'oom_kill', 'warning', 'mem.oom_kill'), real_)).toMatchObject({ show: true, watchOnly: true })
    })

    it('an node-15 agent that stays unreachable is a critical page, as on any fleet node', async () => {
      const nodes = fixture('netdata-cloud-nodes.json')
      const node3 = nodes.find((n: any) => n.name === 'node-3')
      const node15 = { ...node3, id: '00000000-0000-4000-8000-000000000014', name: 'node-15', state: 'unreachable' }
      const src = createNetdataCloudSource(source!, deps(fakeCloud({ nodes: [...nodes.filter((n: any) => n.name !== 'node-3'), node15] })), fleetSource.fleetNodes)
      await src.poll()
      await src.poll()
      const obs = await src.poll()
      const a = obs.firing.find((x) => x.rule === 'Netdata: node unreachable (node-15)')
      expect(a?.severity).toBe('page')
      expect(a?.labels.severity).toBe('critical')
    })
  })

  // 2026-10-17, "Netdata: swap used (node-5)": node-5 has 8 GB of swap on a 190 GB box. A two-and-a-half hour ClickHouse scan pushed idle primary-pg pages into it (swap 94.5 %
  // used) while MemAvailable stayed above 83 % and memory PSI under 3 %, and the share never goes down because nothing touches those pages. The share of swap used
  // is no pressure signal there, so that one alarm on that one node is not raised; low MemAvailable still is, and so is every node's other swap alarm.
  describe('node-5 swap share: ignored there, low MemAvailable still raises', () => {
    const fleetSource = real.sources.find((s) => s.type === 'netdata-fleet') as NetdataFleetSourceConfig
    const real_ = netdataPolicyOf(source!, fleetSource.fleetNodes)
    const swap = (node: string, level: 'warning' | 'critical' = 'warning') => finding(node, 'used_swap', level, 'mem.swap')

    it('drops used_swap on node-5 at either level, as an ignored instance (its group cell stays solid)', () => {
      expect(classifyNetdataAlert(swap('node-5'), real_)).toEqual({ show: false, reason: 'ignored' })
      expect(classifyNetdataAlert(swap('node-5', 'critical'), real_)).toEqual({ show: false, reason: 'ignored' })
      expect(classifyNetdataAlert(swap('node-5'), real_)).toEqual({ show: false, reason: 'ignored' })
    })

    it('keeps used_swap on every other node, and a swap alarm on another node-5 instance', () => {
      for (const node of ['node-1', 'node-2', 'node-3', 'node-4', 'node-6', 'node-7', 'node-8', 'node-13', 'node-14', 'node-15', 'mac-a1.example.net']) {
        expect(classifyNetdataAlert(swap(node), real_), node).toMatchObject({ show: true, rule: `Netdata: swap used (${node})`, severity: 'warning' })
      }
      expect(classifyNetdataAlert(finding('node-5', 'used_swap', 'warning', 'mem.swap2'), real_)).toMatchObject({ show: true })
    })

    it('still raises node-5 on low MemAvailable and OOM kills: ram_available and ram_in_use join Host memory hot, oom_kill stands alone', () => {
      expect(classifyNetdataAlert(finding('node-5', 'ram_available', 'warning', 'mem.available'), real_)).toMatchObject({ show: true, rule: 'Host memory hot (node-5)', fleetRule: 'memory-hot' })
      expect(classifyNetdataAlert(finding('node-5', 'ram_in_use', 'critical', 'system.ram'), real_)).toMatchObject({ show: true, rule: 'Host memory hot (node-5)', fleetRule: 'memory-hot' })
      expect(classifyNetdataAlert(finding('node-5', 'oom_kill', 'warning', 'mem.oom_kill'), real_)).toMatchObject({ show: true, rule: 'Netdata: OOM kills (node-5)' })
    })

    it('says why in the config, and watches the mem.swap context still (the group is unchanged, so another node\'s swap alarm and the cell stay live)', () => {
      const rule = (source?.ignoreInstances ?? []).find((r) => r.node === '^node-5$')
      expect(rule?.instance).toBe('^mem\\.swap$')
      expect(rule?.note).toMatch(/MemAvailable/)
      expect(DEFAULT_GROUPS.find((g) => g.id === 'host')?.contexts).toContain('mem.swap')
    })
  })

  it('does not watch print (print spooler, not monitored): it is ignored, in no list, and has no node entry', () => {
    expect(source?.ignoreNodes).toEqual({ print: 'print spooler, not monitored' })
    expect(source?.watchOnlyNodes).not.toContain('print')
    expect(source?.fleetNodes).not.toContain('print')
    expect(source?.nodes?.print).toBeUndefined()
    const policy = netdataPolicyOf(source!)
    expect(classifyNetdataAlert(finding('print', 'system_post_update_reboot_status', 'warning', 'system.post_update_reboot_status'), policy)).toEqual({ show: false, reason: 'ignored-node' })
    expect(classifyNetdataAlert(finding('mac-a1.example.net', 'disk_space_usage', 'critical', 'disk_space./data'), policy)).toMatchObject({ show: true, watchOnly: true })
  })

  it('links nodes to the Cloud page of the room', () => {
    expect(source?.cloudUrl).toBe('https://app.netdata.cloud/spaces/example-space/rooms/all-nodes')
    expect(nodeUrl(source?.cloudUrl, '00000000-0000-4000-8000-000000000007')).toBe('https://app.netdata.cloud/spaces/example-space/rooms/all-nodes/nodes/00000000-0000-4000-8000-000000000007')
  })

  it('maps the host-disk component to the Host disks tile the Grafana rules sit on, so a Netdata disk alert shares their incident', () => {
    const rule = real.serviceMap.find((r) => r.match.labels?.component === '^host-disk')
    expect(rule?.service).toBe('Host disks')
  })

  it('posts its warnings to Chat #notifications and never to a phone, and a page from it uses the page route', () => {
    const warning = real.routes.find((r) => r.match.severity?.includes('warning') && !r.match.origin)
    expect(warning?.receivers).toEqual(['hook'])
    const page = real.routes.find((r) => r.match.severity?.includes('page') && !r.match.origin)
    expect(page?.receivers.length).toBeGreaterThan(0)
  })

  it('routes what this source raises: a full disk pages at once, a dead node pages after the 3 minute hold, everything else posts to Chat #notifications', async () => {
    const critical = fixture('netdata-cloud-disk-space-warning.json')
    critical.summary.instances.find((i: any) => i.ni === 1 && i.id === 'disk_space./').al = { cl: 1, cr: 1, ot: 1 }
    const nodes = fixture('netdata-cloud-nodes.json').map((n: any) => (n.name === 'node-3' ? { ...n, state: 'unreachable' } : n))
    const src = createNetdataCloudSource(cfg, deps(fakeCloud({ nodes, data: { 'disk.space': critical } })))
    await src.poll()
    const obs = await src.poll()
    const route = (rule: string) => {
      const a = obs.firing.find((x) => x.rule === rule)!
      return matchedRoutes(real.routes, { severity: a.severity, origin: a.origin, labels: a.labels }).map((r) => [r.id, r.groupWaitSec, r.receivers.length > 0])
    }
    expect(route('Host disk full imminent (node-4)')).toEqual([['page', 0, true]])
    expect(route('Netdata: node unreachable (node-3)')).toEqual([['netdata-unreachable', 180, true]])
    expect(route('Netdata: reboot pending after update (print)')).toEqual([['warning', 60, true]])
  })

  it('loads with the validations, and rejects a bad one with a message that names the field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'watch-cfg-'))
    const write = (patch: Record<string, unknown>): string => {
      const copy = JSON.parse(JSON.stringify(real)) as WatchConfig
      Object.assign(copy.sources.find((s) => s.type === 'netdata-cloud')!, patch)
      const path = join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`)
      writeFileSync(path, JSON.stringify(copy))
      return path
    }
    expect(() => loadConfig(write({}))).not.toThrow()
    expect(() => loadConfig(write({ url: 'http://app.netdata.cloud' }))).toThrow('needs an https url')
    expect(() => loadConfig(write({ pollSec: 0 }))).toThrow('needs a pollSec above 0')
    expect(() => loadConfig(write({ spaceId: '' }))).toThrow('spaceId and a roomId')
    expect(() => loadConfig(write({ ignoreInstances: [{ instance: '(' }] }))).toThrow('bad regular expression')
    expect(() => loadConfig(write({ nodes: { 'mac-a1.example.net': { dns: 'mini ug xyz' } } }))).toThrow('nodes.mac-a1.example.net.dns')
    expect(() => loadConfig(write({ nodes: { 'mac-a1.example.net': { dns: 7 } } }))).toThrow('nodes.mac-a1.example.net.dns')
    expect(() => loadConfig(write({ nodes: { 'mac-a1.example.net': { note: 7 } } }))).toThrow('nodes.mac-a1.example.net.note')
    expect(() => loadConfig(write({ nodes: { '': { dns: 'a.example' } } }))).toThrow('names a node')
    expect(() => loadConfig(write({ nodes: { 'mac-a1.example.net': { dns: 'mini.example.test', note: 'A Mac mini.' } } }))).not.toThrow()
    expect(() => loadConfig(write({ ignoreNodes: { print: 'print spooler, not monitored', box2: 'decommissioned' } }))).not.toThrow()
    expect(() => loadConfig(write({ ignoreNodes: ['print'] }))).toThrow('ignoreNodes must be an object')
    expect(() => loadConfig(write({ ignoreNodes: { '': 'why' } }))).toThrow('ignoreNodes has an entry that names a node')
    expect(() => loadConfig(write({ ignoreNodes: { print: '' } }))).toThrow('ignoreNodes.print must be one line')
    expect(() => loadConfig(write({ ignoreNodes: { print: 7 } }))).toThrow('ignoreNodes.print must be one line')
    expect(() => loadConfig(write({ ignoreNodes: { print: 'two\nlines' } }))).toThrow('ignoreNodes.print must be one line')
    expect(() => loadConfig(write({ ignoreNodes: { 'node-3': 'why' } }))).toThrow('node-3 is in ignoreNodes and in fleetNodes')
    expect(() => loadConfig(write({ ignoreNodes: { 'MAC-A1.example.net': 'why' } }))).toThrow('MAC-A1.example.net is in ignoreNodes and in watchOnlyNodes')
    expect(() => loadConfig(write({ nodes: { print: { dns: 'print.example.com' } } }))).toThrow('print is in ignoreNodes and has an entry in nodes')
    expect(() => loadConfig(write({ watchOnlyNodes: 'mac-a1.example.net' }))).toThrow('watchOnlyNodes must be a list')
    expect(() => loadConfig(write({ groups: [{ id: 'all', name: 'Everything', contexts: ['*'], alerts: ['*'] }] }))).toThrow('never "*"')
    expect(() => loadConfig(write({ groups: [{ id: 'a', name: 'A', contexts: ['disk.space'], alerts: ['x'] }, { id: 'a', name: 'B', contexts: ['disk.space'], alerts: ['x'] }] }))).toThrow('unique ids')
  })
})
