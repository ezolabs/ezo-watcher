// Which SourceKind this process POLLS, and how. The record is the guard: it is typed over the whole union, so a new kind
// does not compile until its author decides here whether it is polled (a factory) or pushed/app-driven (null). main.ts
// iterates config sources through this map instead of an if/else chain, where a kind could be added and silently never start.
import type { SourceKind } from '../shared/types.ts'
import type {
  DomainExpirySourceConfig,
  FeedSourceConfig,
  GrafanaSourceConfig,
  HeartbeatSourceConfig,
  HostSourceConfig,
  HttpProbeSourceConfig,
  NetdataCloudSourceConfig,
  NetdataFleetSourceConfig,
  SentrySourceConfig,
  SourceConfig,
  TcpProbeSourceConfig,
  VmalertSourceConfig
} from './config.ts'
import type { FleetSource } from './sources/netdata-fleet.ts'
import type { PolledSource, SourceDeps } from './sources/types.ts'
import { createDomainExpirySource } from './sources/domain-expiry.ts'
import { createFeedSource } from './sources/feed.ts'
import { createGrafanaSource } from './sources/grafana.ts'
import { createHttpProbeSource } from './sources/http-probe.ts'
import { heartbeatSource } from './sources/heartbeat.ts'
import { createHostSource } from './sources/host.ts'
import { createNetdataCloudSource } from './sources/netdata-cloud.ts'
import { createNetdataFleetSource } from './sources/netdata-fleet.ts'
import { createSentrySource } from './sources/sentry.ts'
import { createTcpProbeSource } from './sources/tcp-probe.ts'
import { createVmalertSource } from './sources/vmalert.ts'

/** What the factories need beyond the config and the deps: the nodes the Netdata fleet-load rules cover. */
export interface BuildContext {
  loadNodes: string[]
}

/** One source built from its config. `fleet` is set by the one source that also feeds the fleet view. */
export interface BuiltSource {
  source: PolledSource
  fleet?: FleetSource
}

/** `null` means the kind is pushed to this process (webhook) or is app-driven (self), never polled by a timer. A heartbeat is both pushed to and polled: its poll only evaluates the schedule its pings feed. */
export type SourceFactory = (config: SourceConfig, deps: SourceDeps, ctx: BuildContext) => BuiltSource

export const POLLED: Record<SourceKind, SourceFactory | null> = {
  grafana: (s, deps) => ({ source: createGrafanaSource(s as GrafanaSourceConfig, deps) }),
  vmalert: (s, deps) => ({ source: createVmalertSource(s as VmalertSourceConfig, deps) }),
  'netdata-cloud': (s, deps, ctx) => ({ source: createNetdataCloudSource(s as NetdataCloudSourceConfig, deps, ctx.loadNodes) }),
  'netdata-fleet': (s, deps) => {
    const fleet = createNetdataFleetSource(s as NetdataFleetSourceConfig, deps)
    return { source: fleet, fleet }
  },
  sentry: (s, deps) => ({ source: createSentrySource(s as SentrySourceConfig, deps) }),
  'http-probe': (s, deps) => ({ source: createHttpProbeSource(s as HttpProbeSourceConfig, deps) }),
  'tcp-probe': (s, deps) => ({ source: createTcpProbeSource(s as TcpProbeSourceConfig, deps) }),
  'domain-expiry': (s, deps) => ({ source: createDomainExpirySource(s as DomainExpirySourceConfig, deps) }),
  // A push body read by a poll: polled here, parsed by the webhook ingest's own parser.
  feed: (s, deps) => ({ source: createFeedSource(s as FeedSourceConfig, deps) }),
  // A scheduled job that is pinged: the poll only evaluates its schedule, so a missed run becomes an incident with no request of its own.
  heartbeat: (s, deps) => ({ source: heartbeatSource(s as HeartbeatSourceConfig, deps) }),
  // The machine this process runs on, read with node:os and fs.statfs: no network, no credential, nothing installed.
  host: (s, deps) => ({ source: createHostSource(s as HostSourceConfig, deps) }),
  // Pushed or app-driven: no timer, no factory.
  webhook: null,
  self: null,
  zulip: null
}
