// Netdata Cloud webhook adapter. Netdata Cloud POSTs one JSON object per notification to the URL of a webhook
// integration. Three shapes arrive, told apart by their fields (integrations/cloud-notifications/integrations/webhook.md,
// retrieved 2026-10-15; no sample body is published, so the fixtures under test/fixtures/netdata-*.json are CONSTRUCTED
// from the field table, not captured):
//  - alert: message, alert, info, chart, context, space, Rooms, family, class, severity (warning | critical | clear),
//    date (ISO 8601), duration, additional_active_critical_alerts, additional_active_warning_alerts, alert_url.
//    There is no host field in the table, so the node is read defensively (hostOf).
//  - reachability: message, url, host, severity (info when reachable, critical when not), status{reachable, text}.
//  - verification: the Test button sends a body with a `token` the operator pastes back into Netdata Cloud.
//
// What Watch does with them:
//  - critical pages ONLY for a disk-full class (the four capacity alerts below) and for an unreachable node. Every other
//    critical is a warning, and a warning is wall-only (config routes), so a CPU or RAM critical never wakes anyone.
//  - a disk-capacity alert joins the incident of the Grafana host-disk rule of the same tier on the same host, so one fault is
//    one tile; on a host Grafana has no disk rule for (node-3) it stands as its own incident (diskRule).
//  - identity is (host, alert, chart, incident rule), so a severity change that moves the alert to another incident is a
//    resolve of the old one and a fire of the new one, with the events both incidents need.
//  - clear, and a reachable node, resolve.
//  - a chart DEFAULT_IGNORE_INSTANCES names (netdata-cloud.ts: /Volumes, /snap/, /run/box-space/ ...) is never a host disk, at any level: it
//    fires nothing and resolves whatever it may have raised before the rule existed (ignoredBy), the same list the poll source drops.

import { createHash } from 'node:crypto'
import type { Alert, AlertLinks, Observation } from '../../shared/types.ts'
import { makeAlert } from '../derive.ts'
import type { SourceDeps } from './types.ts'
import { DEFAULT_IGNORE_INSTANCES } from './netdata-cloud.ts'
import { clip, isoOrNull, isRecord, markResolved, safeUrl } from './shared.ts'

export interface NetdataContext {
  /** The webhook source id from config; also the origin of every alert (a header can not rename a Netdata sender). */
  source: string
  deps: SourceDeps
  /** The source's `netdata.grafanaDiskHosts`: hosts whose disk alerts join a Grafana rule of the same tier. */
  grafanaDiskHosts?: string[]
  /** The source's `netdata.netdataHosts`: the operators' own hosts, whose domain is dropped from the name. */
  netdataHosts?: string[]
}

export type NetdataPayloadKind = 'alert' | 'reachability' | 'verification'
export type NetdataLevel = 'warning' | 'critical'

// ---- the disk-capacity classes and their Grafana twins ------------------------------------------------

/** The Grafana host-disk rule tiers (test/fixtures/api-alert-rules.json holds a provisioned set with all three). */
export type GrafanaTier = 'imminent' | 'filling' | 'low'

/**
 * Which hosts have a Grafana host-disk rule in each tier is config, not a constant: the netdata webhook source names them in
 * `netdata.grafanaDiskHosts` and the netdata-cloud source in `grafanaDiskHosts` (src/server/config.ts). A host on neither list passes
 * through as its own incident (diskRule).
 */

const GRAFANA_TITLE: Record<GrafanaTier, (host: string) => string> = {
  imminent: (h) => `Host disk full imminent (${h})`,
  filling: (h) => `Host disk filling up (${h})`,
  low: (h) => `Host disk space low (${h})`
}

/**
 * Netdata alert (stock health.d/disks.conf) to the Grafana tier of the same meaning, per level.
 *  - disk_space_usage: warn above 90 % used (Grafana "space low" is under 10 % free), crit above 98 % used with under 5 GiB left
 *    (Grafana "full imminent" is under 5 % free).
 *  - out_of_disk_space_time: warn under 8 h to full (Grafana "filling up" is a 24 h trend that reaches zero), crit under 2 h
 *    (Grafana "full imminent" is a fill within 4 h).
 */
const SPACE_TIERS: Record<string, Record<NetdataLevel, GrafanaTier>> = {
  disk_space_usage: { critical: 'imminent', warning: 'low' },
  out_of_disk_space_time: { critical: 'imminent', warning: 'filling' }
}
/** Inode exhaustion has no Grafana rule, so it never joins one. */
const INODE_ALERTS = new Set(['disk_inode_usage', 'out_of_disk_inodes_time'])

export interface DiskRule {
  /** The incident's rule title: a Grafana rule's own title when it joins one, else "Netdata: disk space (host)". */
  rule: string
  /** The Grafana tier joined, or null when the alert stands alone. */
  tier: GrafanaTier | null
  family: 'space' | 'inodes'
}

/** True for the four alerts that mean a disk is full or about to be: the only critical alerts that page. */
export function isDiskCapacity(alert: string): boolean {
  const a = alert.toLowerCase()
  return a in SPACE_TIERS || INODE_ALERTS.has(a)
}

/**
 * The incident a disk-capacity alert belongs to, or null when the alert is not one. The join is by identity of tier and host,
 * not by whether Grafana is firing right now: the Grafana rules are slower (a 15 min to 1 h `for`) and, until they evaluate,
 * show no data, so Netdata fires first, and an incident that starts under Grafana's title is the one Grafana joins when it
 * catches up. A host Grafana has no rule for (node3, and any host outside the fleet) passes through as its own incident.
 */
export function diskRule(host: string, alert: string, level: NetdataLevel, grafanaDiskHosts: readonly string[] = []): DiskRule | null {
  const h = canonicalHost(host, grafanaDiskHosts)
  const a = alert.toLowerCase()
  const tiers = SPACE_TIERS[a]
  if (tiers) {
    const tier = tiers[level]
    if (grafanaDiskHosts.some((x) => x.toLowerCase() === h)) return { rule: GRAFANA_TITLE[tier](h), tier, family: 'space' }
    return { rule: `Netdata: disk space (${h})`, tier: null, family: 'space' }
  }
  if (INODE_ALERTS.has(a)) return { rule: `Netdata: disk inodes (${h})`, tier: null, family: 'inodes' }
  return null
}

/** Every incident rule an alert can have across its levels: what a level change must resolve on its way. */
function ruleVariants(host: string, alert: string, grafanaDiskHosts: readonly string[]): string[] {
  const rules = (['warning', 'critical'] as const).map((l) => diskRule(host, alert, l, grafanaDiskHosts)?.rule ?? `Netdata: ${alert}`)
  return [...new Set(rules)]
}

// ---- reading the payload ------------------------------------------------------------------------------

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * Which Netdata body this is, or null when it is none of them. A `token` wins: a Test notification may carry alert-looking
 * fields, and it must never become an alert.
 */
export function netdataPayloadKind(p: Record<string, unknown>): NetdataPayloadKind | null {
  if (str(p.token) !== '') return 'verification'
  if (isRecord(p.status) && typeof p.status.reachable === 'boolean') return 'reachability'
  if (str(p.alert) !== '' && str(p.severity) !== '' && (str(p.chart) !== '' || str(p.alert_url) !== '')) return 'alert'
  return null
}

/** Words a "on <word>" match must not read as a host. */
const NOT_A_HOST = new Set(
  'average the this that these those a an all each every your my our one any host hosts node nodes server servers system systems disk disks chart charts space cpu memory ram network interface device devices mount path filesystem last over top demand behalf call fire purpose hold hand'.split(' ')
)
/**
 * A host as the wall names it: no quotes or markdown, and no domain when its first label is one of the operators' own hosts (`known`,
 * the source's `netdataHosts`): `node-3.example.net` reads `node-3`, while `build-box.example.com` is left whole.
 */
export function canonicalHost(raw: string, known: readonly string[] = []): string {
  const h = raw.trim().replace(/^[`'"*_\s]+|[`'"*_\s.,:;)]+$/g, '')
  const first = h.split('.')[0]
  if (known.some((k) => k.toLowerCase() === first.toLowerCase())) return first.toLowerCase()
  return clip(h, 80)
}

function plausible(token: string, known: readonly string[]): boolean {
  const h = canonicalHost(token, known)
  return h !== '' && !/^\d+$/.test(h) && !NOT_A_HOST.has(h.toLowerCase())
}

function hostFromText(text: string, known: readonly string[]): string {
  if (text === '') return ''
  // A host the operator named anywhere in the text beats a guess: Netdata names its nodes by hostname.
  for (const k of known) {
    const re = new RegExp(`(?<![A-Za-z0-9_.-])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'i')
    if (re.test(text)) return k.toLowerCase()
  }
  const labelled = /\bhost(?:name)?\s*[:=]\s*[`'"]?([A-Za-z0-9][A-Za-z0-9._-]*)/i.exec(text)
  if (labelled && plausible(labelled[1], known)) return canonicalHost(labelled[1], known)
  for (const m of text.matchAll(/\bon\s+(?:host\s+|node\s+|server\s+)?[`'"*_]*([A-Za-z0-9][A-Za-z0-9._-]*)/gi)) if (plausible(m[1], known)) return canonicalHost(m[1], known)
  const subject = /^[`'"*_\s]*([A-Za-z0-9][A-Za-z0-9._-]*)\s+(?:is|has|became|turned)\s+(?:now\s+)?(?:critical|warning|clear|unreachable|reachable)\b/i.exec(text)
  if (subject && plausible(subject[1], known)) return canonicalHost(subject[1], known)
  return ''
}

export interface HostRead {
  host: string
  /** Where the name came from, kept as a label so a wrong guess can be told from a field. */
  from: 'field' | 'message' | 'unknown'
}

/** The node: a host field when the payload has one, else the message text, else "unknown host". */
export function hostOf(p: Record<string, unknown>, known: readonly string[] = []): HostRead {
  const node = isRecord(p.node) ? p.node : {}
  for (const v of [p.host, p.hostname, p.node_name, p.nodename, node.hostname, node.name, typeof p.node === 'string' ? p.node : '']) {
    const h = canonicalHost(str(v), known)
    if (h !== '') return { host: h, from: 'field' }
  }
  const fromMessage = hostFromText(str(p.message), known)
  if (fromMessage !== '') return { host: fromMessage, from: 'message' }
  return { host: UNKNOWN_HOST, from: 'unknown' }
}

export const UNKNOWN_HOST = 'unknown host'

function levelOf(severity: string): NetdataLevel | 'clear' {
  const s = severity.toLowerCase()
  if (s === 'clear' || s === 'ok' || s === 'recovered' || s === 'resolved' || s === 'info') return 'clear'
  if (s === 'critical' || s === 'crit') return 'critical'
  // warning, warn, and anything unknown: shown, never a page.
  return 'warning'
}

/** The mount point a disk chart names: disk_space./var/lib/x is /var/lib/x, and disk_space._ (the sanitised form) is /. */
function mountOf(chart: string): string {
  const m = /^disk_(?:space|inodes)\.(.*)$/.exec(chart)
  if (!m) return ''
  return m[1] === '' || m[1] === '_' ? '/' : m[1]
}

const FRIENDLY: Record<string, string> = {
  disk_space_usage: 'Disk space usage',
  out_of_disk_space_time: 'Disk predicted to fill',
  disk_inode_usage: 'Inode usage',
  out_of_disk_inodes_time: 'Inodes predicted to run out'
}

function friendly(alert: string): string {
  const words = FRIENDLY[alert.toLowerCase()] ?? alert.replace(/[_-]+/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** md, smart, disk latency and utilisation alerts are about the host's disks even though they are not capacity. */
function isDiskHealth(alert: string, context: string): boolean {
  return /^(?:disk|md|smartctl|nvme)(?:\.|$)/.test(context) || /disk|mdstat|smart|raid|nvme/i.test(alert)
}

// ---- building alerts ----------------------------------------------------------------------------------

const fingerprintOf = (...parts: string[]): string => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)

interface Draft {
  host: string
  hostFrom: HostRead['from']
  alert: string
  chart: string
  rule: string
  /** What Netdata sent, lower case. */
  level: NetdataLevel
  /** What Watch makes of it: only a disk-full class and a dead node are critical (a page). */
  severity: 'critical' | 'warning'
  component: 'host-disk' | 'netdata'
  startsAt: string
  endsAt?: string
}

function alertFor(p: Record<string, unknown>, d: Draft, ctx: NetdataContext, now: string): Alert {
  const message = clip(str(p.message), 600)
  const info = clip(str(p.info), 400)
  const context = str(p.context)
  const mount = mountOf(d.chart)
  const rooms = isRecord(p.Rooms) ? Object.keys(p.Rooms).slice(0, 8).join(', ') : ''
  const labels: Record<string, string> = {
    alertname: d.alert,
    severity: d.severity,
    netdata_severity: d.level,
    host: d.host,
    instance: d.host,
    component: d.component,
    netdata_host_from: d.hostFrom
  }
  const optional: Record<string, string> = {
    chart: d.chart,
    context,
    mountpoint: mount,
    class: str(p.class),
    family: str(p.family),
    netdata_space: str(p.space),
    netdata_rooms: rooms
  }
  for (const [k, v] of Object.entries(optional)) if (v !== '') labels[k] = clip(v, 120)
  const annotations: Record<string, string> = {
    summary: `${friendly(d.alert)} on ${d.host}${mount ? ` (${mount})` : d.chart !== '' ? ` (${d.chart})` : ''} is ${d.level === 'critical' ? 'critical' : 'at warning'}`,
    description: message || info || `Netdata raised ${d.alert} on ${d.host}.`,
    where: `Netdata agent on ${d.host}, ${d.chart !== '' ? `chart ${d.chart}` : 'node level'}. ${str(p.space) !== '' ? `Raised through Netdata Cloud, space ${str(p.space)}` : 'Raised by the Netdata agent that sent this notification'}.`
  }
  if (info && info !== annotations.description) annotations.netdata_info = info
  if (str(p.duration) !== '') annotations.duration = clip(str(p.duration), 60)
  const critical = Number(p.additional_active_critical_alerts)
  const warning = Number(p.additional_active_warning_alerts)
  if (Number.isFinite(critical) && critical > 0) annotations.netdata_other_critical = String(critical)
  if (Number.isFinite(warning) && warning > 0) annotations.netdata_other_warning = String(warning)
  if (d.level === 'critical' && d.severity === 'warning') annotations.netdata_demoted = 'Netdata calls this critical; only a full disk or an unreachable node is a page here, so it is a warning.'
  if (d.hostFrom === 'unknown') annotations.where += ' The payload named no node; open the Netdata Cloud link to see which.'
  const cloud = safeUrl(p.alert_url) ?? safeUrl(p.url)
  const links: AlertLinks = cloud ? { generator: cloud } : {}
  const built = makeAlert(
    {
      origin: ctx.source,
      fingerprint: fingerprintOf(d.host.toLowerCase(), d.alert.toLowerCase(), d.chart, d.rule),
      rule: d.rule,
      labels,
      annotations,
      startsAt: d.startsAt,
      generatorURL: cloud,
      links,
      via: { source: ctx.source, kind: 'webhook', lastSeen: now, url: cloud },
      raw: p
    },
    ctx.deps.serviceMap,
    now
  )
  return d.endsAt ? markResolved(built, d.endsAt) : built
}

interface IgnoreRule {
  node?: RegExp
  instance: RegExp
  note?: string
}
// Compiled on first use, not at load: netdata-cloud.ts imports this module, so the list is not initialised yet while this one loads first.
let ignoreRules: IgnoreRule[] | undefined

/**
 * The built-in ignore rule of the Netdata Cloud source (DEFAULT_IGNORE_INSTANCES) a chart falls under on a host, or undefined. The webhook's chart is
 * Netdata's chart instance id (`disk_space./run/box-space/...`), what the poll source matches the same rules against, so both sources drop one set.
 */
export function ignoredBy(host: string, chart: string): IgnoreRule | undefined {
  if (chart === '') return undefined
  ignoreRules ??= DEFAULT_IGNORE_INSTANCES.map((r) => ({ node: r.node === undefined ? undefined : new RegExp(r.node), instance: new RegExp(r.instance), note: r.note }))
  return ignoreRules.find((r) => (!r.node || r.node.test(host)) && r.instance.test(chart))
}

function normalizeAlert(p: Record<string, unknown>, ctx: NetdataContext, now: string): Observation {
  const known = ctx.netdataHosts ?? []
  const diskHosts = ctx.grafanaDiskHosts ?? []
  const { host, from } = hostOf(p, known)
  const alert = str(p.alert)
  const chart = str(p.chart)
  const ignored = ignoredBy(host, chart)
  const level = levelOf(str(p.severity))
  const date = isoOrNull(p.date) ?? now
  const context = str(p.context)
  const capacity = isDiskCapacity(alert)
  const component = capacity || isDiskHealth(alert, context) ? 'host-disk' : 'netdata'
  const ruleAt = (l: NetdataLevel): string => diskRule(host, alert, l, diskHosts)?.rule ?? `Netdata: ${alert}`
  const base = { host, hostFrom: from, alert, chart, component } as const
  const firing: Alert[] = []
  const resolved: Alert[] = []
  const resolveRules = (except: string | null): void => {
    for (const rule of ruleVariants(host, alert, diskHosts)) {
      if (rule === except) continue
      resolved.push(alertFor(p, { ...base, rule, level: 'warning', severity: 'warning', startsAt: date, endsAt: date }, ctx, now))
    }
  }
  if (ignored) {
    // Never a host disk (a sandbox's own quota, a mounted image): no alert at any level, and a resolve for each incident it could have opened, so one
    // raised before the rule existed leaves the wall (the engine ignores a resolve it holds no firing alert for).
    ctx.deps.log?.(`netdata ${ctx.source}: ignored ${clip(alert, 80)} (${level}) on ${host} chart ${clip(chart, 200)}: ${ignored.note ?? ignored.instance.source}`)
    resolveRules(null)
  } else if (level === 'clear') {
    resolveRules(null)
  } else {
    const rule = ruleAt(level)
    firing.push(alertFor(p, { ...base, rule, level, severity: level === 'critical' && capacity ? 'critical' : 'warning', startsAt: date }, ctx, now))
    // The level moved this alert to another incident (warning to critical on a joined host): close the one it left.
    resolveRules(rule)
  }
  return { source: ctx.source, kind: 'webhook', at: now, firing, resolved, complete: false }
}

function normalizeReachability(p: Record<string, unknown>, ctx: NetdataContext, now: string): Observation {
  const { host, from } = hostOf(p, ctx.netdataHosts ?? [])
  const status = isRecord(p.status) ? p.status : {}
  const down = status.reachable === false || str(status.text).toLowerCase() === 'unreachable'
  const date = isoOrNull(p.date) ?? now
  const rule = 'Netdata: node unreachable'
  const alert = 'NetdataNodeUnreachable'
  const labels: Record<string, string> = { alertname: alert, severity: down ? 'critical' : 'info', host, instance: host, component: 'netdata', netdata_host_from: from }
  const url = safeUrl(p.url)
  const built = makeAlert(
    {
      origin: ctx.source,
      fingerprint: fingerprintOf(host.toLowerCase(), 'reachability'),
      rule,
      labels,
      annotations: {
        summary: `${host} is ${down ? 'unreachable from Netdata Cloud' : 'reachable again'}`,
        description: clip(str(p.message), 600) || `Netdata Cloud ${down ? 'lost' : 'regained'} contact with the agent on ${host}.`,
        where: `The Netdata agent on ${host}, as seen by Netdata Cloud. An unreachable agent is a stopped or restarting agent or a lost uplink, not proof the machine is down.`
      },
      startsAt: date,
      generatorURL: url,
      links: url ? { generator: url } : {},
      via: { source: ctx.source, kind: 'webhook', lastSeen: now, url },
      raw: p
    },
    ctx.deps.serviceMap,
    now
  )
  return {
    source: ctx.source,
    kind: 'webhook',
    at: now,
    firing: down ? [built] : [],
    resolved: down ? [] : [markResolved(built, date)],
    complete: false
  }
}

/** The top-level field names of a body, for a log line: names only, never values. */
export function payloadKeys(p: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(p)
      .slice(0, 20)
      .map((k) => clip(k, 40))
  )
}

/**
 * Turn a Netdata Cloud body into an Observation, or return null when the body is not one (the caller then rejects it like any
 * other unknown payload). A Test notification yields an empty Observation: the source is marked heard, and the token Netdata
 * asks the operator to paste back is written to the process log, the only place Watch shows it.
 */
export function normalizeNetdata(payload: Record<string, unknown>, ctx: NetdataContext): Observation | null {
  const kind = netdataPayloadKind(payload)
  if (kind === null) return null
  const now = ctx.deps.nowIso()
  if (kind === 'alert') return normalizeAlert(payload, ctx, now)
  if (kind === 'reachability') return normalizeReachability(payload, ctx, now)
  ctx.deps.log?.(`netdata ${ctx.source}: test notification received. verification token: ${clip(str(payload.token), 200)} (body keys ${payloadKeys(payload)})`)
  return { source: ctx.source, kind: 'webhook', at: now, firing: [], resolved: [], complete: false }
}
