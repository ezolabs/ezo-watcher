// The tools of the Watch MCP server. Each is a name, a description an agent reads, an input shape (zod, so the JSON Schema the client sees is
// the one the call is checked against), the hints that say what the tool can do to the world, and a `run` over McpDeps. The SDK is not
// imported here: server.ts is the one file that knows it, so a move to the SDK's v2 packages changes that file and nothing else.
//
// Reading is free. Writing is six verbs: acknowledge, silence, park, comment, resolve and confirm_resolution, each attributed ("agent: <who>",
// required), plus the two that undo (unacknowledge, unpark) and re-poll (recheck). An agent can never resolve an alert, delete one or edit one: the
// `resolve` tool marks an INCIDENT resolved by hand and the engine reopens it the moment a source still reports it; `park` takes an incident off the
// live wall for at most 72 h after a fix or a verdict and never reopens, so it is the one to use when the source cannot catch up.
//
// What the hints mean here (MCP ToolAnnotations): readOnlyHint false for everything that writes; destructiveHint true only for what removes or
// suppresses something another person or the source set (silence, park, unacknowledge, unpark, resolve), false for what only adds a record (acknowledge,
// comment, confirm_resolution, recheck); idempotentHint true when repeating the same call changes nothing more; openWorldHint true only for
// recheck, which asks the outside sources.

import { z } from 'zod'
import { COMMENT_MAX, PARK_NOTE_MAX, PARK_REF_MAX, PARK_STATES, REASON_MAX, SILENCE_MAX_MINUTES, agentName, checkOptionalText, checkPark, checkSilenceMinutes, checkText } from '../../shared/agent.ts'
import { PARK_MAX_HOURS } from '../../shared/incident.ts'
import type { AlertRecheck, WallRecheck } from '../../shared/recheck.ts'
import type { Severity } from '../../shared/types.ts'
import type { WatchConfig } from '../config.ts'
import type { Db } from '../db.ts'
import type { Engine } from '../engine.ts'
import { fixContextOf, verifyFix } from './fix-context.ts'
import {
  eventLine,
  filterFiring,
  filterHistory,
  historyOut,
  historyRange,
  incidentOut,
  incidentRow,
  incidentUrl,
  sourceRow,
  summarizeWall
} from './shape.ts'
import type { IncidentFilter, StateFilter } from './shape.ts'

export interface McpDeps {
  engine: Engine
  db: Db
  /** The running config: `brand` names the server to the client (server.ts), and the brief's source blocks read its sources. */
  cfg: WatchConfig
  nowMs: () => number
  /** Re-poll the pull sources. Absent: `recheck` says it is not available. */
  recheck?: { all(): Promise<WallRecheck>; alert(key: string, asker?: { via: 'wall' | 'mcp'; by: string }): Promise<AlertRecheck | null> }
  /** Wake the notifier now, as an ack or an ingest does. */
  nudge: () => void
  /** One line to the operator log. Never a token. */
  log: (line: string) => void
}

export interface ToolHints {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string }

export interface ToolSpec {
  name: string
  title: string
  description: string
  shape: Record<string, z.ZodType>
  hints: ToolHints
  run: (d: McpDeps, args: Record<string, unknown>) => Promise<ToolResult>
}

const ok = (data: unknown): ToolResult => ({ ok: true, data })
const fail = (error: string): ToolResult => ({ ok: false, error })

const READ: ToolHints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const ADD: ToolHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
const ADD_IDEMPOTENT: ToolHints = { ...ADD, idempotentHint: true }
const SUPPRESS: ToolHints = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }

// ---- shared input fields ------------------------------------------------------------------------------------------------------------------

const key = z
  .string()
  .min(1)
  .max(300)
  .describe('The incident key exactly as watch_state or list_incidents print it ("<service>|<rule>", or "<service>|<rule>|<instance>" for a rule split per instance). Not an alert key.')
const by = z
  .string()
  .min(1)
  .max(64)
  .describe('Who is doing this, as "agent: <who>", for example "agent: claude in web-app". Required: it is shown on the tile, in the incident sheet and in History. "agent: " is added when left off. At most 64 characters.')
const note = z.string().max(REASON_MAX).optional().describe(`A sentence of context, at most ${REASON_MAX} characters: a fix commit, a PR, what you found. Longer findings go in a comment.`)
const limit = (dflt: number) => z.number().int().min(1).max(200).default(dflt).describe(`How many rows at most (default ${dflt}, most 200).`)

/** The author of a write, or the refusal that tells the agent to give one. */
function author(args: Record<string, unknown>): { ok: true; by: string } | { ok: false; error: string } {
  const name = agentName(args.by)
  return name === null ? { ok: false, error: 'by is required: say who you are as "agent: <who>"' } : { ok: true, by: name }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

const notFiring = (k: string): string => `${k} is not firing. Use list_incidents or watch_state for the keys that are.`

// ---- read tools ---------------------------------------------------------------------------------------------------------------------------

const watchState: ToolSpec = {
  name: 'watch_state',
  title: 'Wall summary',
  description:
    'The EZO Watcher wall in one answer: how many incidents are firing (by severity, and by who has them: unattended, acknowledged, silenced), how many are parked (a fix or a verdict that is not due yet: not live, never paged, counted in no firing or unattended number), every incident as one row (key, title, severity, attention: none, acked, silenced or parked, who acknowledged or silenced it or why, by whom and until when it is parked, age, comment count, link), and the sources that have gone stale, are erroring, or are configured but not started on this host (`skipped`, with its reason). Start here. The incident `key` it returns is what every other tool takes.',
  shape: {},
  hints: READ,
  run: async (d) => {
    const wall = d.engine.wall()
    return ok(summarizeWall(wall, d.engine.commentCounts(wall.incidents.map((i) => i.key)), d.cfg.baseUrl))
  }
}

const listIncidents: ToolSpec = {
  name: 'list_incidents',
  title: 'List incidents',
  description:
    'Incidents, filtered. `state`: firing (default: every live incident, parked ones left out), unattended (firing, nobody has it, never a parked one), acknowledged, silenced, parked (a fix or a verdict that is not due yet: `parkedState`, `parkedUntil`, `parkedBy`, `parkedRef`, `parkedNote` say why, by whom and until when), resolved (episodes that ended in the last `hours`), or all (every incident, parked included). Filter by `severity`, `service` (substring) and `source` (the system that raised it: grafana, prod, sweep, netdata-cloud, ...). Resolved rows say whether a source resolved the incident or someone marked it resolved by hand, and who.',
  shape: {
    state: z.enum(['firing', 'unattended', 'acknowledged', 'silenced', 'parked', 'resolved', 'all']).default('firing').describe('Which incidents. Default firing (live ones, parked left out).'),
    severity: z.enum(['page', 'warning', 'info']).optional().describe('Only this severity.'),
    service: z.string().max(100).optional().describe('Only services whose name contains this, any case.'),
    source: z.string().max(100).optional().describe('Only incidents raised by this source or system, exact name, any case.'),
    hours: z.number().int().min(1).max(720).default(24).describe('How far back resolved incidents reach (default 24, most 720: Watch keeps 30 days).'),
    limit: limit(50)
  },
  hints: READ,
  run: async (d, a) => {
    const f: IncidentFilter = { state: (str(a.state) ?? 'firing') as StateFilter, severity: str(a.severity) as Severity | undefined, service: str(a.service), source: str(a.source) }
    const max = typeof a.limit === 'number' ? a.limit : 50
    const nowMs = d.nowMs()
    const wall = d.engine.wall()
    const rows = filterFiring(
      wall.incidents.map((i) => incidentRow(i, nowMs, 0, d.cfg.baseUrl)),
      wall.incidents,
      f
    )
    const counts = d.engine.commentCounts(rows.map((r) => r.key))
    const firing = rows.map((r) => ({ ...r, comments: counts.get(r.key) ?? 0 }))
    const resolved =
      f.state === 'resolved' || f.state === 'all'
        ? filterHistory(d.engine.history(typeof a.hours === 'number' ? a.hours : 24), f).map((h) => historyOut(h, d.cfg.baseUrl))
        : []
    return ok({
      state: f.state,
      firing: firing.slice(0, max),
      firingMatching: firing.length,
      resolved: resolved.slice(0, max),
      resolvedMatching: resolved.length
    })
  }
}

const getIncident: ToolSpec = {
  name: 'get_incident',
  title: 'One incident',
  description:
    'One incident, whole: its alerts (rule, host, labels, annotations, value, who reports it and when it last did, evidence links and commands), who acknowledged, silenced and parked it, how it ended if it ended (a source, or someone by hand, and any confirmation), its history of acknowledgements, silences, reopens and resolves with who did each, every comment, and the pager\'s last sends. Works for a firing incident and for one that resolved in the last 30 days. Raw payloads are left out.',
  shape: { key },
  hints: READ,
  run: async (d, a) => {
    const k = str(a.key) ?? ''
    const detail = d.engine.incidentDetail(k)
    if (!detail.incident && detail.alerts.length === 0) return fail(`no incident ${k}. Use watch_state or list_incidents for the keys Watch has.`)
    const notifications = d.db
      .prepare('SELECT at, route_id, channel_id, kind, ok, status, latency_ms FROM results WHERE incident_key = ? ORDER BY id DESC LIMIT 10')
      .all(k)
    return ok(incidentOut(k, detail, d.nowMs(), d.cfg.baseUrl, notifications))
  }
}

const getFixContext: ToolSpec = {
  name: 'get_fix_context',
  title: 'Everything needed to fix an incident',
  description:
    'One structured brief for fixing an incident without asking a person: the incident (summary, severity, first and last seen, state and who has it), the source and target that raised it (their config, with every credential left as the env-var NAME and never a value), the predicates the rule cell asserts and which one the last run failed, `discovered.foundAt`/`read` (where the endpoint was found in the project and what was read there), the last good observation beside the last bad one (bodies cut), a `reproduce` block with the exact curl/nc/command that re-runs the check locally, the other open incidents on the same service, the evidence links the source offers (a Sentry permalink and culprit, a Netdata chart, Grafana panel links), and `next`: fix, restart/deploy, then verify_fix. Reads only; start here when you are about to fix something rather than triage it.',
  shape: { key },
  hints: READ,
  run: async (d, a) => {
    const r = fixContextOf(str(a.key) ?? '', { engine: d.engine, cfg: d.cfg, nowMs: d.nowMs })
    return r.ok ? ok(r.brief) : fail(r.error)
  }
}

const incidentHistory: ToolSpec = {
  name: 'incident_history',
  title: 'Incident history',
  description:
    'What ended and what was done in a time range: every incident episode that resolved in it (when it started and ended, how long, who had it acknowledged, whether a source or someone by hand resolved it, any confirmation) and, newest first, the acknowledgements, silences, reopens and confirmations people and agents made, each with who. Give `from` and `to` as ISO times, or `hours` back from now (24 by default). Watch keeps 30 days.',
  shape: {
    from: z.string().max(40).optional().describe('ISO 8601 start of the range, for example 2026-10-14T00:00:00Z.'),
    to: z.string().max(40).optional().describe('ISO 8601 end of the range. Default now.'),
    hours: z.number().int().min(1).max(720).optional().describe('Instead of from: this many hours before `to`. Default 24.'),
    service: z.string().max(100).optional().describe('Only services whose name contains this, any case.'),
    limit: limit(100)
  },
  hints: READ,
  run: async (d, a) => {
    const nowMs = d.nowMs()
    const r = historyRange({ from: str(a.from), to: str(a.to), hours: typeof a.hours === 'number' ? a.hours : undefined }, nowMs)
    if (!r.ok) return fail(r.error)
    const max = typeof a.limit === 'number' ? a.limit : 100
    const f: IncidentFilter = { state: 'resolved', service: str(a.service) }
    const rows = filterHistory(d.engine.history(r.hours), f).filter((h) => Date.parse(h.resolvedAt) <= r.toMs)
    const actions = d.engine.actions(new Date(r.fromMs).toISOString(), new Date(r.toMs).toISOString(), 200).filter((e) => (f.service === undefined ? true : (e.incidentKey ?? '').toLowerCase().includes(f.service.toLowerCase())))
    return ok({
      from: new Date(r.fromMs).toISOString(),
      to: new Date(r.toMs).toISOString(),
      resolved: rows.slice(0, max).map((h) => historyOut(h, d.cfg.baseUrl)),
      resolvedMatching: rows.length,
      actions: actions.slice(0, max).map((e) => ({ incident: e.incidentKey, url: incidentUrl(d.cfg.baseUrl, e.incidentKey ?? ''), ...eventLine(e) })),
      actionsMatching: actions.length
    })
  }
}

const listSources: ToolSpec = {
  name: 'list_sources',
  title: 'Sources',
  description:
    'Every source this Watcher reads or is pushed by (Grafana, vmalert, Netdata Cloud and the fleet load poll, Sentry, the HTTP and TCP probes, heartbeat, domain expiry, the feeds, the webhooks): its kind, state (ok, error, stale, idle), when it last answered, the error if any, `skipped` when this host did not start it (`missing <ENV>`; absent on a source that runs), how many alerts it reports firing, how many rules it lists, how many of its cells assert more than a nominal 200 (`asserted`) and, where it records one, `discovered`: where its endpoint was found. A source that has gone quiet or was not started means an all clear is not earned.',
  shape: {},
  hints: READ,
  run: async (d) => ok({ sources: d.engine.sources().map(sourceRow) })
}

// ---- write tools --------------------------------------------------------------------------------------------------------------------------

const acknowledge: ToolSpec = {
  name: 'acknowledge',
  title: 'Acknowledge an incident',
  description:
    'Say you are working this incident: it shows as acknowledged by you on the tile, in the sheet and in History, its age stops counting as unattended, and the pager stops escalating it. Acknowledge only while you are actively working the issue; it does not fix, hide or resolve anything, and a person can take it off. Re-acknowledging replaces the earlier name. Put what you found or did in a comment, not here: the optional note is one line of context.',
  shape: { key, by, note },
  hints: ADD_IDEMPOTENT,
  run: async (d, a) => {
    const who = author(a)
    if (!who.ok) return fail(who.error)
    const n = checkOptionalText(a.note, 'note', REASON_MAX)
    if (!n.ok) return fail(n.error)
    const k = str(a.key) ?? ''
    if (!d.engine.ack(k, who.by, n.text)) return fail(notFiring(k))
    d.nudge()
    d.log(`mcp: acknowledge ${who.by} on ${k}`)
    const i = d.engine.wall().incidents.find((x) => x.key === k)
    return ok({ ok: true, key: k, by: who.by, ...(i ? { incident: incidentRow(i, d.nowMs(), 0, d.cfg.baseUrl) } : {}) })
  }
}

const unacknowledge: ToolSpec = {
  name: 'unacknowledge',
  title: 'Take an acknowledgement off',
  description:
    'Take the acknowledgement (and any silence) off a firing incident, so it counts as unattended again and the pager resumes. Use it when you stop working an issue you acknowledged and no one else has it. `by` is recorded: History shows who handed it back.',
  shape: { key, by, note },
  hints: { ...SUPPRESS, destructiveHint: true, idempotentHint: true },
  run: async (d, a) => {
    const who = author(a)
    if (!who.ok) return fail(who.error)
    const n = checkOptionalText(a.note, 'note', REASON_MAX)
    if (!n.ok) return fail(n.error)
    const k = str(a.key) ?? ''
    if (!d.engine.isFiring(k)) return fail(notFiring(k))
    d.engine.unack(k, who.by, n.text)
    d.nudge()
    d.log(`mcp: unacknowledge ${who.by} on ${k}`)
    return ok({ ok: true, key: k, by: who.by })
  }
}

const silence: ToolSpec = {
  name: 'silence',
  title: 'Silence an incident for a while',
  description: `Pause the pager for one firing incident, for at most ${SILENCE_MAX_MINUTES} minutes (4 hours; more is refused, not shortened). It drops to the quiet tier of the wall and sends nothing until it runs out or someone takes it off. A silence hides a problem from the people who would act on it: use it only for something you know is expected right now (a deploy, a drill, a host you are rebooting), say why in \`reason\`, and never to make a real problem go quiet. If you are working the incident, acknowledge it instead.`,
  shape: {
    key,
    minutes: z.number().int().min(1).max(SILENCE_MAX_MINUTES).describe(`How long, in whole minutes, from 1 to ${SILENCE_MAX_MINUTES} (4 hours).`),
    by,
    reason: z.string().min(1).max(REASON_MAX).describe(`Why it is expected or safe to pause this incident, at most ${REASON_MAX} characters. Required: it is shown beside who silenced it.`)
  },
  hints: SUPPRESS,
  run: async (d, a) => {
    const who = author(a)
    if (!who.ok) return fail(who.error)
    const m = checkSilenceMinutes(a.minutes)
    if (!m.ok) return fail(m.error)
    const why = checkText(a.reason, 'reason', REASON_MAX)
    if (!why.ok) return fail(why.error)
    const k = str(a.key) ?? ''
    if (!d.engine.silence(k, m.minutes, who.by, why.text)) return fail(notFiring(k))
    d.nudge()
    d.log(`mcp: silence ${who.by} on ${k} for ${m.minutes} min`)
    return ok({ ok: true, key: k, by: who.by, minutes: m.minutes, until: new Date(d.nowMs() + m.minutes * 60_000).toISOString() })
  }
}

const park: ToolSpec = {
  name: 'park',
  title: 'Park an incident after a fix or a verdict',
  description: `Take a firing incident off the live wall into the Parked section, for at most ${PARK_MAX_HOURS} hours (more is refused, not shortened), once you have FIXED it or reached a VERDICT on it. \`state\`: fixed_undeployed (the fix is merged and not live yet), awaiting_source (the fix is live and the source's evaluation window has not caught up, so it still reports the alert), deferred (a person decided to handle it at a later date; the note says who and why). It works for any source, Grafana included. Unlike \`resolve\` it never reopens or pages while the park holds, and unlike \`silence\` it states a known cause: the tile reads "Parked until <time> by <you>" with your note, it counts as parked and not firing, and nothing is sent. It ends when the source resolves the alert, when \`until\` passes (the incident comes back unattended and its clock counts from \`until\`, so the pager treats it as a new problem), on \`unpark\`, or on a manual \`resolve\`; an acknowledgement or silence on the incident still wins over it, and a second park replaces the first. Park only after a fix or a verdict, never to hide a live problem you have not looked at or to quiet one you cannot explain. The park covers only the alerts firing when you park (get_incident lists their keys in \`park.alertKeys\`): an alert that joins the incident later (another host or instance, a new rule on it) ends the park at once, the incident comes back unattended and pages as a new problem, and History says which alert joined. An alert that resolves and fires again keeps the park.`,
  shape: {
    key,
    state: z.enum(PARK_STATES).describe('Why it is parked: fixed_undeployed (the fix is merged, not live yet), awaiting_source (the fix is live, the source has not caught up), or deferred (handled at a later date).'),
    until: z.string().min(1).max(40).describe(`When the park ends: an ISO 8601 time with a zone (Z or an offset), for example 2026-10-17T04:00:00Z, after now and at most ${PARK_MAX_HOURS} hours from now. More is refused, not shortened: the refusal names the latest time that is taken. Choose the shortest time that covers the fix.`),
    by,
    note: z.string().min(1).max(PARK_NOTE_MAX).describe(`Why it is parked: what you fixed or decided and how you know, at most ${PARK_NOTE_MAX} characters. Required: it is shown on the tile and in the sheet beside your name.`),
    ref: z.string().max(PARK_REF_MAX).optional().describe(`A ticket, PR or commit that explains the park, one line, at most ${PARK_REF_MAX} characters.`)
  },
  hints: SUPPRESS,
  run: async (d, a) => {
    const who = author(a)
    if (!who.ok) return fail(who.error)
    const p = checkPark(a, d.nowMs())
    if (!p.ok) return fail(p.error)
    const k = str(a.key) ?? ''
    const r = d.engine.park(k, { state: p.state, until: p.until, by: who.by, note: p.note, ref: p.ref })
    if (!r.ok) return fail(notFiring(k))
    d.nudge()
    d.log(`mcp: park ${who.by} on ${k} as ${p.state} until ${p.until}`)
    const i = d.engine.wall().incidents.find((x) => x.key === k)
    return ok({
      ok: true,
      key: k,
      by: who.by,
      state: p.state,
      until: p.until,
      replaced: r.replaced,
      covers: d.engine.manualParkOf(k)?.alertKeys ?? [],
      ...(i ? { attention: i.state.attention, incident: incidentRow(i, d.nowMs(), 0, d.cfg.baseUrl) } : {}),
      ...(i && i.state.attention !== 'parked' ? { warning: `The park is recorded, but this incident is ${i.state.attention}, which outranks a park: it shows as parked once that is taken off.` } : {})
    })
  }
}

const unpark: ToolSpec = {
  name: 'unpark',
  title: 'End a park now',
  description:
    'End a park set by hand with `park` before it runs out: the incident is back in its severity tier, unattended and paging as a new problem would, with its clock starting now. Use it when the fix did not hold or the verdict was wrong. `by` is recorded: History shows who ended it. Refused for an incident that is not firing, one that was not parked by hand (a park the regression sweep states ends when the sweep stops stating it), and one whose park has already ended.',
  shape: { key, by, note },
  hints: { ...SUPPRESS, idempotentHint: true },
  run: async (d, a) => {
    const who = author(a)
    if (!who.ok) return fail(who.error)
    const n = checkOptionalText(a.note, 'note', REASON_MAX)
    if (!n.ok) return fail(n.error)
    const k = str(a.key) ?? ''
    const r = d.engine.unpark(k, who.by, n.text)
    if (!r.ok) {
      if (r.error === 'not firing') return fail(notFiring(k))
      if (r.error === 'park ended') return fail(`${k}: its park already ended at ${r.endedAt}, so it is already back in its tier. Nothing to end.`)
      return fail(`${k} was not parked by hand. A park the regression sweep states ends when the sweep stops stating it; use list_incidents with state parked to see what is parked and by whom.`)
    }
    d.nudge()
    d.log(`mcp: unpark ${who.by} on ${k}`)
    const i = d.engine.wall().incidents.find((x) => x.key === k)
    return ok({ ok: true, key: k, by: who.by, at: r.at, ...(i ? { incident: incidentRow(i, d.nowMs(), 0, d.cfg.baseUrl) } : {}) })
  }
}

const comment: ToolSpec = {
  name: 'comment',
  title: 'Comment on an incident',
  description: `Add a comment to an incident, firing or resolved: what you found, a link, the commit that fixes it, what you ruled out. Markdown, at most ${COMMENT_MAX} characters (longer is refused, not cut). It is stored on the incident and shows in the incident sheet with your name and the time, and every one is written to the operator log. Comment as you learn things; a comment is the right place for findings, links and fix commits.`,
  shape: {
    key,
    by,
    text: z.string().min(1).max(COMMENT_MAX).describe(`The comment, markdown, at most ${COMMENT_MAX} characters.`)
  },
  hints: ADD,
  run: async (d, a) => {
    const who = author(a)
    if (!who.ok) return fail(who.error)
    const t = checkText(a.text, 'text', COMMENT_MAX)
    if (!t.ok) return fail(t.error)
    const k = str(a.key) ?? ''
    const saved = d.engine.comment(k, who.by, t.text)
    if (!saved) return fail(`no incident ${k}. Use watch_state or list_incidents for the keys the Watcher has.`)
    d.log(`mcp: comment ${who.by} on ${k}`)
    return ok({ ok: true, comment: { id: saved.id, by: saved.by, at: saved.createdAt, text: saved.text } })
  }
}

const recheck: ToolSpec = {
  name: 'recheck',
  title: 'Re-check now',
  description:
    'Ask the sources again instead of waiting for the next poll: with `incident` (an incident key), re-polls the sources that report its alerts and answers what each alert is now; with `alert` (an alert key such as grafana:1a2b3c4d), the same for one alert; with neither, re-polls every pull source and says how many alerts cleared. At most one poll per source every 10 seconds, so a repeat inside it is answered from the last poll. A pushing sender that takes requests (the regression sweep) is asked to run the check again: each firing alert it reports gets one request, an alert that already has an open one reuses it, and the answer\'s `pushed[].request` says where it stands (asked, picked up, waiting, ran, failed, cannot, or not picked up within 30 min); a repeat while it is open returns the same request, so it only reads where it stands. Any other pushing sender (webhooks) cannot be forced: the answer says when it last reported, when it reports next if it said, and when the alert clears if it stops sending it. It changes no alert except by the sources\' own answers.',
  shape: {
    by,
    incident: z.string().min(1).max(300).optional().describe('An incident key: re-check the alerts that make it up.'),
    alert: z.string().min(1).max(120).optional().describe('An alert key, "<origin>:<8 hex>".')
  },
  hints: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run: async (d, a) => {
    const who = author(a)
    if (!who.ok) return fail(who.error)
    if (!d.recheck) return fail('re-check is not available on this Watch')
    const alertKey = str(a.alert)
    const incidentKey = str(a.incident)
    d.log(`mcp: recheck ${who.by}${incidentKey ? ` on ${incidentKey}` : alertKey ? ` on ${alertKey}` : ''}`)
    if (alertKey) {
      const r = await d.recheck.alert(alertKey, { via: 'mcp', by: who.by })
      return r ? ok({ by: who.by, alerts: [r] }) : fail(`no alert ${alertKey}`)
    }
    if (incidentKey) {
      const detail = d.engine.incidentDetail(incidentKey)
      const keys = detail.alerts.filter((x) => !x.resolvedAt).map((x) => x.key).slice(0, 10)
      if (keys.length === 0) return fail(notFiring(incidentKey))
      const answers = (await Promise.all(keys.map((k) => d.recheck!.alert(k, { via: 'mcp', by: who.by })))).filter((x): x is AlertRecheck => x !== null)
      return ok({ by: who.by, alerts: answers })
    }
    return ok({ by: who.by, wall: await d.recheck.all() })
  }
}

const verifyFixTool: ToolSpec = {
  name: 'verify_fix',
  title: 'Verify a fix and close the incident',
  description: `Close the fix loop: re-check the sources now, wait up to \`timeoutSec\` seconds for the source's fresh observation, and answer { resolved, observation, asserts }. When every alert of the incident is resolved by its source, it records the confirmation (the existing confirm_resolution path) with the note "verified by agent", so History reads "resolution confirmed by <you>" and the incident closes with the attribution. When the source still reports an alert firing it resolves nothing and says which assertion failed and why, so the fix can be repaired rather than guessed at. Never resolves an alert itself: only the source (or a person's resolve) ends an alert. Idempotent: after a green answer a repeat reads the resolved episode and records at most another confirmation.`,
  shape: {
    key,
    by,
    timeoutSec: z.number().int().min(5).max(300).default(60).describe('How long to wait for the source to answer, in seconds (5 to 300; default 60). Each round re-checks the sources no faster than once every 10 seconds, so a shorter wait makes fewer rounds.')
  },
  hints: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run: async (d, a) => {
    const who = author(a)
    if (!who.ok) return fail(who.error)
    const k = str(a.key) ?? ''
    const timeoutSec = typeof a.timeoutSec === 'number' ? a.timeoutSec : undefined
    d.log(`mcp: verify_fix ${who.by} on ${k}`)
    const r = await verifyFix({ engine: d.engine, recheck: d.recheck, nowMs: d.nowMs, log: d.log }, k, who.by, { timeoutSec })
    return r.ok ? ok(r.result) : fail(r.error)
  }
}

const resolve: ToolSpec = {
  name: 'resolve',
  title: 'Mark an incident resolved by hand',
  description:
    'Mark a firing incident resolved now, with a required reason, when you have fixed it and the source has not caught up (a push source repeats only every few hours). It leaves the wall, History records "marked resolved by <you>" with your reason, and the operator log records the write. It does not hide a live problem: if the source reports the alert as firing on its next poll or push, Watch reopens the incident as a NEW firing (unacknowledged, escalating, paging again) and records "reopened: source still firing after manual resolve by <you>". A manual resolve ends any acknowledgement or silence on the incident. You can never resolve, delete or edit an alert itself: only its source resolves alerts. After the source resolves, use confirm_resolution to record that you checked.',
  shape: {
    key,
    by,
    reason: z.string().min(1).max(REASON_MAX).describe(`Why it is resolved: what you changed and how you know, at most ${REASON_MAX} characters. Required.`)
  },
  hints: SUPPRESS,
  run: async (d, a) => {
    const who = author(a)
    if (!who.ok) return fail(who.error)
    const why = checkText(a.reason, 'reason', REASON_MAX)
    if (!why.ok) return fail(why.error)
    const k = str(a.key) ?? ''
    const r = d.engine.resolveManual(k, who.by, why.text)
    if (!r.ok) return fail(notFiring(k))
    d.nudge()
    d.log(`mcp: resolve ${who.by} on ${k}`)
    return ok({
      ok: true,
      key: k,
      by: who.by,
      resolvedAt: r.at,
      alertsResolved: r.alerts,
      warning: 'Marked resolved by hand. If the source still reports the alert on its next poll or push, Watch reopens the incident as a new firing.'
    })
  }
}

const confirmResolution: ToolSpec = {
  name: 'confirm_resolution',
  title: 'Confirm an incident is resolved',
  description:
    'Record that an incident a source has already resolved is resolved: "resolution confirmed by <you>", with an optional note (the fix commit, the PR, an evidence link). It shows in the sheet and in History, and the operator log records the write. It changes no state, so it cannot hide anything: use it after you checked that the fix held. Refused for an incident that is firing, one that never resolved, and one that was marked resolved by hand while a source still reports it.',
  shape: { key, by, note },
  hints: ADD,
  run: async (d, a) => {
    const who = author(a)
    if (!who.ok) return fail(who.error)
    const n = checkOptionalText(a.note, 'note', REASON_MAX)
    if (!n.ok) return fail(n.error)
    const k = str(a.key) ?? ''
    const r = d.engine.confirmResolution(k, who.by, n.text)
    if (!r.ok) return fail(`${k}: ${r.error}`)
    d.log(`mcp: confirm_resolution ${who.by} on ${k}`)
    return ok({ ok: true, key: k, by: who.by, at: r.at, resolvedAt: r.resolvedAt })
  }
}

/** Every tool, reads first. The order is the order `tools/list` answers. */
export const TOOLS: readonly ToolSpec[] = [watchState, listIncidents, getIncident, getFixContext, incidentHistory, listSources, acknowledge, unacknowledge, silence, park, unpark, comment, recheck, verifyFixTool, resolve, confirmResolution]
