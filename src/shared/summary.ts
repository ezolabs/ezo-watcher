// The small status object the chat panel shows on its Watch pill. Counts only: no incident text, no host, no label, so a read of it
// (GET /api/summary, or the embed view's postMessage) tells a reader how much is firing and nothing about what.
// One pure function, read by the server route and by the embed view, so the two never disagree.

import type { Severity, WallState } from './types.ts'

/** A count per severity: the same three words every other surface of Watch uses (critical is read as page, warn as warning at the door). */
export interface SeverityCounts {
  page: number
  warning: number
  info: number
}

export interface WatchSummary {
  /** The shape's version, so the chat panel can ignore a newer one it does not know. */
  v: 1
  /** Incidents firing now, acknowledged and silenced ones included, parked ones left out (they are in `parked`). */
  firing: number
  /** Firing incidents nobody has acknowledged or silenced: the ones still waiting for a person. */
  unattended: number
  /** Firing incidents someone has acknowledged. */
  acknowledged: number
  /** Incidents parked: an open triage verdict that is not due yet. In no other count here, and they never page. Additive: v stays 1, and a reader that predates it ignores it. */
  parked: number
  /** The worst severity among the firing incidents, or 'none' when nothing fires. */
  worst: Severity | 'none'
  /** Firing incidents by severity (acknowledged and silenced ones included), so the three add up to `firing`. Additive: v stays 1, and a reader that predates it ignores it. */
  bySeverity: SeverityCounts
  /** Of those, the unattended ones by severity (nobody has acknowledged or silenced them), so a client can dim the acknowledged. The three add up to `unattended`. */
  unattendedBySeverity: SeverityCounts
  /** A source stopped answering, so "nothing firing" cannot be trusted as an all clear. */
  stale: boolean
}

const RANK: Record<Severity, number> = { page: 3, warning: 2, info: 1 }

export function summaryOf(state: Pick<WallState, 'header' | 'incidents'>): WatchSummary {
  const firing = state.incidents.filter((i) => i.state.firing)
  let worst: WatchSummary['worst'] = 'none'
  const bySeverity: SeverityCounts = { page: 0, warning: 0, info: 0 }
  const unattendedBySeverity: SeverityCounts = { page: 0, warning: 0, info: 0 }
  for (const i of firing) {
    if (worst === 'none' || RANK[i.severity] > RANK[worst]) worst = i.severity
    bySeverity[i.severity] += 1
    if (i.state.attention === 'none') unattendedBySeverity[i.severity] += 1
  }
  return {
    v: 1,
    // counted from the incidents, not read from the header: a parked incident is on the wall and in no firing count, however the header was built
    firing: firing.length,
    unattended: firing.filter((i) => i.state.attention === 'none').length,
    acknowledged: firing.filter((i) => i.state.attention === 'acked').length,
    parked: state.incidents.filter((i) => i.state.attention === 'parked').length,
    worst,
    bySeverity,
    unattendedBySeverity,
    stale: state.header.stale
  }
}
