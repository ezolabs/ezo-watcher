// vmalert source: proof of watch for a vmalert rule file, read from the VictoriaMetrics that stores vmalert's own metrics.
//
// The api router's 70 alerting rules live in vmalert (api.rules.yml in the prod namespace), not in Grafana, so no
// rules inventory ever reached the wall for them. vmalert exports two series per alerting rule, labelled alertname, group,
// file and id (retrieved from the api VictoriaMetrics 2026-10-15, recorded in test/fixtures/vmalert-*.json):
//  - vmalert_alerting_rules_errors_total: a counter of failed evaluations.
//  - vmalert_alerting_rules_last_evaluation_series_fetched: a gauge of the series the last evaluation read.
// A rule is a cell: "ok" when its series exist and its error counter has not risen in the last few minutes, "error" when it
// has, "no data" when a series seen in the last hour is gone. Whether a rule FIRES is not read here; that already reaches
// Watch through the Alertmanager and the webhook source. A fetch of zero series is normal for a counter-based rule whose
// metric has not been emitted yet, so it is never "no data". When the VictoriaMetrics itself does not answer the poll
// throws, the engine counts a miss, and after the configured number the source is stale and its cells are dashed.

import type { Observation, RuleCell } from '../../shared/types.ts'
import type { VmalertSourceConfig } from '../config.ts'
import { deriveService } from '../derive.ts'
import type { PolledSource, SourceDeps } from './types.ts'
import { epochIso, getJson, isRecord, trimSlash } from './shared.ts'

const FETCHED = 'vmalert_alerting_rules_last_evaluation_series_fetched'
const ERRORS = 'vmalert_alerting_rules_errors_total'
/**
 * vmalert's metrics are scraped every 15 s and VictoriaMetrics answers an instant query as of 30 s ago (-search.latencyOffset), so
 * the newest sample is up to about 45 s old at the moment of a poll (measured 2026-10-15: at most 13 s behind the offset). The
 * engine dashes a cell once its reading is older than twice this, which is 3 minutes: well past that, and not a blip.
 */
const SCRAPE_INTERVAL_SEC = 90

interface Sample {
  labels: Record<string, string>
  value: number
}

/** One instant-vector response as a list of samples. Anything else is a failure of the source, not an empty answer. */
function samples(body: unknown, label: string): Sample[] {
  const data = isRecord(body) ? body.data : undefined
  if (!isRecord(body) || body.status !== 'success' || !isRecord(data) || data.resultType !== 'vector' || !Array.isArray(data.result)) {
    throw new Error(`${label} returned an unexpected shape`)
  }
  const out: Sample[] = []
  for (const r of data.result) {
    if (!isRecord(r) || !isRecord(r.metric) || !Array.isArray(r.value)) continue
    const value = Number(r.value[1])
    if (!Number.isFinite(value)) continue
    const labels: Record<string, string> = {}
    for (const [k, v] of Object.entries(r.metric)) if (typeof v === 'string') labels[k] = v
    out.push({ labels, value })
  }
  return out
}

/** One rule is told apart by group, name and vmalert's own rule id (a name can repeat across groups). */
const ruleKey = (l: Record<string, string>): string => `${l.group ?? ''}\u0000${l.alertname ?? ''}\u0000${l.id ?? ''}`

export function createVmalertSource(cfg: VmalertSourceConfig, deps: SourceDeps): PolledSource {
  const base = trimSlash(cfg.url)
  const errorWindow = Math.max(60, cfg.errorWindowSec ?? 300)
  const knownWindow = Math.max(errorWindow, cfg.knownWindowSec ?? 3600)

  async function query(promql: string, label: string): Promise<Sample[]> {
    const body = await getJson(deps.fetch, `${base}/api/v1/query?query=${encodeURIComponent(promql)}`, { Accept: 'application/json' }, label)
    return samples(body, label)
  }

  async function poll(): Promise<Observation> {
    const [present, known, errors] = await Promise.all([
      // The sample time of each series now present: the rule is there, and when it was last read.
      query(`timestamp(${FETCHED})`, 'vmalert rules'),
      // Every rule seen within the window, present or not: one that is only here has gone.
      query(`last_over_time(${FETCHED}[${knownWindow}s])`, 'vmalert rule history'),
      query(`increase(${ERRORS}[${errorWindow}s])`, 'vmalert errors')
    ])
    const now = deps.nowIso()
    const failing = new Set(errors.filter((s) => s.value > 0).map((s) => ruleKey(s.labels)))
    const stamp = new Map(present.map((s) => [ruleKey(s.labels), s.value]))
    const cells = new Map<string, RuleCell>()
    for (const s of [...present, ...known]) {
      const k = ruleKey(s.labels)
      const name = s.labels.alertname
      if (!name || cells.has(k)) continue
      const at = stamp.get(k)
      cells.set(k, {
        id: `${cfg.id}:${s.labels.group ?? ''}/${name}${s.labels.id ? `:${s.labels.id}` : ''}`,
        source: cfg.id,
        name,
        service: deriveService(cfg.id, name, {}, deps.serviceMap),
        state: at === undefined ? 'nodata' : failing.has(k) ? 'error' : 'ok',
        ...(at === undefined ? {} : { evaluatedAt: epochIso(at), intervalSec: SCRAPE_INTERVAL_SEC })
      })
    }
    // An empty answer is not a healthy rule file: the rules are gone from the metrics for longer than the window (vmalert down, or
    // not scraped). Ingesting it would delete every cell and leave the tile quietly dotted; throwing makes it a missed poll, so the
    // cells already held are dashed and the source raises source-stale.
    if (cells.size === 0) throw new Error(`vmalert reported no rules in the last ${knownWindow} s`)
    return { source: cfg.id, kind: 'vmalert', at: now, firing: [], resolved: [], complete: true, rules: [...cells.values()] }
  }

  return { id: cfg.id, kind: 'vmalert', name: 'vmalert', pollSec: cfg.pollSec, poll }
}
