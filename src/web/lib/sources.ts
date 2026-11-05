// What the Sources page says about a source going quiet. The answer is different for each kind, and only some kinds reach the wall, so the
// page says it per kind instead of promising one thing for all of them (the engine decides, in src/server/engine.ts: `staleAlerts` skips a pushed
// source that promised no schedule and the collector, and raises a pushed source's silence at its own severity). Every other kind is polled.

import type { SourceKind, SourceStatus } from '../../shared/types.ts'
import { durationText } from './format.ts'

export const SOURCES_LINE = 'Where alerts come from, and what each one does when it goes quiet.'

/** What the Sources page calls each kind of source: its job in words, never the raw kind name. A new kind must be added here to compile. */
export const KIND_LABEL: Record<SourceKind, string> = {
  grafana: 'Grafana alerting',
  zulip: 'Retired alert bridge poll (history only)',
  webhook: 'Webhook receiver',
  self: 'EZO Watcher',
  vmalert: 'Alert rules (vmalert)',
  'netdata-cloud': 'Netdata Cloud, polled every minute',
  'netdata-fleet': 'Netdata fleet metrics (CPU, memory, load), polled every minute',
  sentry: 'Sentry issues and crashes, polled every two minutes',
  'http-probe': 'HTTP probes: uptime, response time and certificate expiry of each target',
  'tcp-probe': 'TCP probes: a connect to each host and port, and certificate expiry for a TLS one',
  'domain-expiry': 'Domain expiry: each domain\'s registrar expiry, read from RDAP',
  feed: 'Feed: a sender\'s alerts and checks, polled',
  heartbeat: 'Heartbeat: a scheduled job pings after each run',
  host: 'Host: this machine\'s load, memory, free disk space and one pid file, read locally'
}

/** The label of a kind, or the raw name for a kind a newer server sends that this page has not heard of. */
export const kindLabel = (kind: SourceKind): string => KIND_LABEL[kind] ?? kind

/** What the Sources page calls one source: its own label when it has one, else its kind's words. */
export const sourceLabel = (s: Pick<SourceStatus, 'id' | 'kind'>): string => kindLabel(s.kind)

/** One sentence: what happens when this source stops answering or stops pushing. '' for a kind that has nothing to say. */
export function quietText(s: Pick<SourceStatus, 'kind' | 'staleAfterSec'>): string {
  switch (s.kind) {
    case 'grafana':
    case 'zulip':
    case 'vmalert':
    case 'netdata-cloud':
    case 'netdata-fleet':
    case 'sentry':
    case 'feed':
      return 'If it misses three polls in a row, the wall raises its own source-stale warning.'
    case 'http-probe':
      return 'The Watcher runs it itself: a target that stops answering is that target\'s ProbeDown alert, never a quiet source.'
    case 'tcp-probe':
      return 'The Watcher runs it itself: an endpoint that stops accepting connections is that target\'s ProbeDown alert, never a quiet source.'
    case 'domain-expiry':
      return 'The Watcher runs it itself: a failed RDAP lookup leaves the domain\'s cell without data, never a quiet source.'
    case 'host':
      return 'The Watcher runs it itself: a reading it cannot take leaves that check\'s cell without data, never a quiet source, and a failing one is the host incident.'
    case 'heartbeat':
      return 'Its own schedule decides: a run that does not ping by its grace raises the HeartbeatDown page, and an ok ping resolves it.'
    case 'webhook':
      return s.staleAfterSec === undefined
        ? 'It only pushes when an alert changes, so silence is not a failure and nothing flags it.'
        : `If it is silent for more than ${durationText(s.staleAfterSec)}, this page reads Not answering and the wall raises a source-stale alert.`
    default:
      return ''
  }
}
