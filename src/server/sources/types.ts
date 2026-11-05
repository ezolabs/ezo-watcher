import type { Observation, SourceKind } from '../../shared/types.ts'
import type { ServiceRule } from '../config.ts'

/** One ping as the path says it: an ok run, a run that just began, a declared failure, or a shell exit status. */
export type HeartbeatPingKind = 'ok' | 'start' | 'fail' | 'exit'

/** Injected so a test can run an adapter against recorded payloads with no network. */
export interface SourceDeps {
  fetch: typeof fetch
  env: NodeJS.ProcessEnv
  /** Now, as an ISO string. */
  nowIso: () => string
  serviceMap: ServiceRule[]
  /** One line to the process log, when the host wants it (diagnostics only; never a secret or a payload value). */
  log?: (line: string) => void
  /** The name this Watch goes by (config `brand.name`), where an alert's words say who read it. Absent: EZO Watcher. */
  brand?: string
  /** Where a heartbeat's ping history lives across a restart (src/server/stores.ts). Absent: memory only, the pre-persistence behaviour. */
  heartbeatStore?: HeartbeatStateStore
}

/** What a heartbeat remembers between pings. `startedMs` is the base of the first deadline when the job has never pinged. */
export interface HeartbeatState {
  startedMs: number
  lastPingMs: number | null
  lastKind: HeartbeatPingKind | null
  /** The last /start punch, kept so a restart does not rewrite a started run as a silent one. */
  lastStartMs?: number | null
  /** The open failure's start, while one is open. A `/start` punch does not close it: only an ok ping does. */
  failedSinceMs: number | null
  /** The exit status that opened the failure, when it came from `/<code>`. */
  exitCode?: number
}

/** The persisted form of one heartbeat: the same fields as HeartbeatState, as stored rows read them. */
export interface HeartbeatStateRecord {
  source: string
  registeredMs: number
  lastPingMs: number | null
  lastKind: HeartbeatPingKind | null
  lastStartMs?: number | null
  lastFailMs: number | null
  exitCode: number | null
}

/** The store a HeartbeatSource writes through. A database restart must not forget a missed run or an open failure. */
export interface HeartbeatStateStore {
  load(source: string): HeartbeatStateRecord | null
  save(state: HeartbeatStateRecord): void
}

/** A polled source: the poller calls `poll` every `pollSec` seconds and hands the Observation to the engine. */
export interface PolledSource {
  id: string
  kind: SourceKind
  name: string
  pollSec: number
  poll(): Promise<Observation>
}
