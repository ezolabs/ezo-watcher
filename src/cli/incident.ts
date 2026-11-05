// `watcher incident <key> [--fix-context]` and `watcher recheck <key> [--wait]`: the CLI half of the fix loop
// (src/server/mcp/fix-context.ts owns the server half, which the MCP tools call).
//
// Both verbs read the running Watcher over HTTP, never its SQLite file: the server is the single writer, so a CLI run and an
// agent's MCP call see the same state. `--output json|md|table` decides the shape; nothing here prompts.

import type { ParsedArgs } from './util.ts'
import { CliError, numberFlag, usageError } from './util.ts'
import type { Output } from './output.ts'
import { ageOf, markdownTable } from './output.ts'
import { readConfig, resolveProject } from './project.ts'
import { requestJson, requireServer, serverRef } from './status.ts'
import type { FixContextBrief, VerifyResult } from '../server/mcp/fix-context.ts'
import { eventLine } from '../shared/event-text.ts'
import type { AlertEvent } from '../shared/types.ts'

export const INCIDENT_SPEC = { valueFlags: ['dir', 'output', 'url'], switchFlags: ['help', 'fix-context'] } as const
export const RECHECK_SPEC = { valueFlags: ['dir', 'output', 'url', 'timeout'], switchFlags: ['help', 'wait'] } as const

function spanSec(sec: number): string {
  if (sec < 60) return `${Math.max(0, Math.round(sec))}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h`
  return `${Math.floor(sec / 86_400)}d`
}

const actor = (): string => {
  const named = (process.env.WATCHER_USER ?? '').trim()
  return named === '' ? 'watcher CLI' : named
}

function keyOf(args: ParsedArgs): string {
  const key = args.positionals[0]?.trim() ?? ''
  if (key === '') {
    throw usageError('incident.missing-key', 'an incident key is required', 'Run `watcher incidents --open --json` for the keys, then `watcher incident \'<service>|<rule>\' --fix-context`.')
  }
  return key
}

function notFound(key: string): CliError {
  return new CliError('incident.not-found', `the Watcher has no incident ${key}`, { next: 'Run `watcher incidents --open --json` for the keys the wall has.' })
}

/** The incident detail GET /api/incidents/:key answers (engine.incidentDetail), as much of it as the CLI reads. */
interface IncidentDetail {
  incident: {
    key: string
    summary?: string
    service?: string
    rule?: string
    severity?: string
    startsAt?: string
    ackedBy?: string | null
    silencedUntil?: string | null
    state?: { attention?: string }
  } | null
  alerts: Array<{ key: string; rule: string; host: string; state: 'firing' | 'resolved'; startsAt: string; resolvedAt: string | null; lastSeen: string }>
  events?: AlertEvent[]
  resolved?: { resolvedAt?: string; endedBy?: string } | null
  comments?: Array<{ createdAt: string; by: string; text: string }>
}

function renderIncident(key: string, detail: IncidentDetail, out: Output): void {
  const i = detail.incident
  const state = i === null ? 'resolved' : 'firing'
  const title = i?.rule ?? key
  const attention = i?.state?.attention ?? 'none'
  out.line(`${out.bold(title)}  ${out.severity(String(i?.severity ?? 'info'))}  ${i?.service ?? ''}  ${state}`)
  out.line(`key ${key}  attention ${attention}  age ${ageOf(i?.startsAt ?? null)}`)
  out.table(
    detail.alerts.map((a) => ({ state: a.resolvedAt === null ? 'firing' : 'resolved', rule: a.rule, host: a.host, since: ageOf(a.startsAt), lastSeen: ageOf(a.lastSeen), key: a.key })),
    [
      { key: 'state', label: 'state', max: 8 },
      { key: 'rule', label: 'rule', max: 30 },
      { key: 'host', label: 'host', max: 24 },
      { key: 'since', label: 'since', max: 7 },
      { key: 'lastSeen', label: 'last seen', max: 9 },
      { key: 'key', label: 'alert', max: 30 }
    ]
  )
  if ((detail.events ?? []).length > 0) {
    out.section('history')
    for (const e of (detail.events ?? []).slice(0, 8)) out.line(`  ${e.at}  ${eventLine(e).text}`)
  }
  if ((detail.comments ?? []).length > 0) {
    out.section('comments')
    for (const c of (detail.comments ?? []).slice(0, 5)) out.line(`  ${c.createdAt} ${c.by}: ${c.text.split('\n')[0]}`)
  }
  out.md(`# ${title}`)
  out.md('')
  out.md(`- Key: \`${key}\``)
  out.md(`- Severity: ${i?.severity ?? 'info'}; state: ${state}; attention: ${attention}`)
  out.md(`- Age: ${ageOf(i?.startsAt ?? null)}`)
  out.md('')
  out.md(markdownTable(detail.alerts.map((a) => ({ state: a.resolvedAt === null ? 'firing' : 'resolved', rule: a.rule, host: a.host, since: ageOf(a.startsAt), key: a.key })), [
    { key: 'state', label: 'state' },
    { key: 'rule', label: 'rule' },
    { key: 'host', label: 'host' },
    { key: 'since', label: 'since' },
    { key: 'key', label: 'alert' }
  ]))
  out.line(out.dim('next: watcher incident \'<key>\' --fix-context'))
}

function renderFixContext(brief: FixContextBrief, out: Output): void {
  out.line(`${out.bold(brief.title)}  ${out.severity(brief.severity)}  ${brief.service}  ${brief.state.firing ? 'firing' : 'resolved'}`)
  out.line(`key ${brief.key}  attention ${brief.state.attention}  age ${ageOf(brief.startsAt)}  first seen ${brief.firstSeen}  last seen ${brief.lastSeen}`)
  for (const s of brief.sources) {
    out.line(`source ${s.id} (${s.kind})  ${s.state}  last ok ${ageOf(s.lastOk)}${s.error ? `  error: ${s.error}` : ''}`)
    if (s.discovered?.foundAt) out.line(`  found at ${s.discovered.foundAt}${s.discovered.read ? `: ${s.discovered.read}` : ''}`)
    if (s.target) out.line(`  target ${JSON.stringify(s.target).slice(0, 240)}`)
  }
  out.section('assertions')
  out.table(
    brief.asserts.map((a) => ({ alert: a.alert, cell: a.cell ?? '-', state: a.state ?? '-', failed: a.failed.join('; '), detail: a.failureDetail ?? '' })),
    [
      { key: 'alert', label: 'alert', max: 26 },
      { key: 'cell', label: 'cell', max: 20 },
      { key: 'state', label: 'state', max: 8 },
      { key: 'failed', label: 'failed', max: 36 },
      { key: 'detail', label: 'last run', max: 40 }
    ]
  )
  if (brief.observations.lastGood) {
    out.line(`last good  ${brief.observations.lastGood.at ?? '-'}  HTTP ${brief.observations.lastGood.status ?? '?'}  ${brief.observations.lastGood.detail}`)
    if (brief.observations.lastGood.body) out.line(`  body ${brief.observations.lastGood.body.replace(/\s+/g, ' ').slice(0, 240)}`)
  }
  out.line(`last bad   ${brief.observations.lastBad.at ?? '-'}  HTTP ${brief.observations.lastBad.status ?? '?'}  ${brief.observations.lastBad.detail}`)
  out.section('reproduce')
  out.line(`  ${brief.reproduce.command}`)
  out.line(`  expect: ${brief.reproduce.expect}`)
  for (const a of brief.reproduce.alternatives) out.line(`  ${a.label}: ${a.command}   # expect ${a.expect}`)
  out.line(`  re-run through Watch: ${brief.reproduce.watcher}`)
  if (brief.related.length > 0) {
    out.section('related open incidents')
    for (const r of brief.related) out.line(`  ${r.severity} ${brief.service} ${r.title} (${spanSec(r.ageSec)})  ${r.key}`)
  }
  if (brief.evidence.length > 0) {
    out.section('evidence')
    for (const e of brief.evidence.slice(0, 10)) out.line(`  ${e.kind}  ${e.label}${e.url ? `  ${e.url}` : e.text ? `  ${e.text}` : ''}`)
  }
  if (brief.sourceEvidence) out.line(`source evidence  ${JSON.stringify(brief.sourceEvidence)}`)
  out.section('next')
  for (const [i, step] of brief.next.entries()) out.line(`  ${i + 1}. ${step.action}: ${step.detail}`)

  out.md(`# ${brief.title}`)
  out.md('')
  out.md(`- Key: \`${brief.key}\``)
  out.md(`- Severity: ${brief.severity}; service: ${brief.service}; state: ${brief.state.firing ? 'firing' : 'resolved'} (${brief.state.attention})`)
  out.md(`- First seen: ${brief.firstSeen}; last seen: ${brief.lastSeen}; age: ${ageOf(brief.startsAt)}`)
  out.md('')
  out.md('## Source')
  for (const s of brief.sources) {
    out.md(`- \`${s.id}\` (${s.kind}): ${s.state}; last ok ${s.lastOk ?? 'never'}${s.error ? `; error: ${s.error}` : ''}`)
    if (s.discovered?.foundAt) out.md(`  - found at ${s.discovered.foundAt}${s.discovered.read ? ` — ${s.discovered.read}` : ''}`)
    if (s.target) out.md(`  - target: \`${JSON.stringify(s.target).slice(0, 400)}\``)
  }
  out.md('')
  out.md('## Assertions')
  out.md(markdownTable(brief.asserts.map((a) => ({ alert: a.alert, cell: a.cell ?? '-', state: a.state ?? '-', failed: a.failed.join('; '), detail: a.failureDetail ?? '' })), [
    { key: 'alert', label: 'alert' },
    { key: 'cell', label: 'cell' },
    { key: 'state', label: 'state' },
    { key: 'failed', label: 'failed' },
    { key: 'detail', label: 'last run' }
  ]))
  out.md('')
  out.md('## Observations')
  if (brief.observations.lastGood) out.md(`- Last good: ${brief.observations.lastGood.at ?? 'unknown'}, HTTP ${brief.observations.lastGood.status ?? '?'} — \`${(brief.observations.lastGood.body ?? '').replace(/\s+/g, ' ').slice(0, 300)}\``)
  out.md(`- Last bad: ${brief.observations.lastBad.at ?? 'unknown'} — ${brief.observations.lastBad.detail}`)
  out.md('')
  out.md('## Reproduce')
  out.md('```sh')
  out.md(brief.reproduce.command)
  out.md('```')
  out.md(`Expect: ${brief.reproduce.expect}`)
  out.md('')
  out.md(`Or through Watch: \`${brief.reproduce.watcher}\``)
  if (brief.related.length > 0) {
    out.md('')
    out.md('## Related open incidents')
    for (const r of brief.related) out.md(`- ${r.severity} ${brief.service}: ${r.title} — \`${r.key}\``)
  }
  if (brief.evidence.length > 0) {
    out.md('')
    out.md('## Evidence')
    for (const e of brief.evidence.slice(0, 10)) out.md(`- ${e.label}${e.url ? `: ${e.url}` : e.text ? `: \`${e.text}\`` : ''}`)
  }
  out.md('')
  out.md('## Next')
  for (const [i, step] of brief.next.entries()) out.md(`${i + 1}. **${step.action}**: ${step.detail}`)
}

export async function runIncident(args: ParsedArgs, out: Output): Promise<number> {
  const key = keyOf(args)
  const project = resolveProject(args.dir)
  const read = readConfig(project)
  const ref = serverRef(args, read.ok ? read.config : null)
  const fixContext = args.switches.get('fix-context') === true
  const path = `/api/incidents/${encodeURIComponent(key)}${fixContext ? '/fix-context' : ''}`
  const answer = await requestJson(`${ref.base}${path}`, { headers: ref.headers })
  if (answer === null) requireServer(answer, ref.base, path)
  if (answer!.status === 404) throw notFound(key)
  if (answer!.status !== 200) {
    requireServer(answer, ref.base, path)
    throw new CliError('incident.http', `${ref.base}${path} answered HTTP ${answer!.status}`, { next: 'Read .watcher/data/watcher.log.' })
  }
  if (fixContext) {
    const brief = answer!.body as FixContextBrief
    out.json(brief)
    renderFixContext(brief, out)
    return 0
  }
  const detail = answer!.body as IncidentDetail
  out.json(detail)
  renderIncident(key, detail, out)
  return 0
}

interface RecheckAnswer {
  key: string
  at: string
  alerts: Array<{ key: string; before: string; after: string; sources: Array<{ id: string; ok: boolean; ran: boolean; throttled: boolean; error: string | null }>; rule: string }>
  resolved: boolean
  stillFiring: number
}

export async function runRecheck(args: ParsedArgs, out: Output): Promise<number> {
  const key = keyOf(args)
  const project = resolveProject(args.dir)
  const read = readConfig(project)
  const ref = serverRef(args, read.ok ? read.config : null)
  const wait = args.switches.get('wait') === true
  const timeoutSec = numberFlag(args, 'timeout', { min: 5, max: 300, fallback: 60 })
  const path = `/api/incidents/${encodeURIComponent(key)}/${wait ? 'verify' : 'recheck'}`
  // `--wait` makes the server hold the request while it re-checks and waits for the source, so the HTTP client's own timeout
  // must outlast the wait it asked for (and the poll inside it), never the fixed 5 s of a read.
  const answer = await requestJson(
    `${ref.base}${path}`,
    {
      method: 'POST',
      headers: { ...ref.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ by: actor(), timeoutSec })
    },
    wait ? (timeoutSec ?? 60) * 1000 + 30_000 : 5000
  )
  if (answer === null) requireServer(answer, ref.base, path)
  if (answer!.status === 404) throw notFound(key)
  if (answer!.status === 503) {
    throw new CliError('recheck.unavailable', `${ref.base}${path} answered 503: re-check is not available`, { next: 'Start the Watcher with `watcher run --detach`; the verb needs its poller.' })
  }
  if (answer!.status !== 200) {
    requireServer(answer, ref.base, path)
    throw new CliError('recheck.http', `${ref.base}${path} answered HTTP ${answer!.status}`, { next: 'Read .watcher/data/watcher.log.' })
  }
  if (wait) {
    const result = answer!.body as VerifyResult
    out.json(result)
    out.line(`${result.resolved ? out.ok('resolved') : out.bad('still firing')}  ${result.key}  ${result.rounds} re-check round${result.rounds === 1 ? '' : 's'}${result.timedOut ? `  timed out after ${timeoutSec}s` : ''}`)
    out.table(
      result.observation.alerts.map((a) => ({ state: a.state, rule: a.rule, lastSeen: ageOf(a.lastSeen), resolvedAt: a.resolvedAt ?? '-' })),
      [
        { key: 'state', label: 'state', max: 8 },
        { key: 'rule', label: 'rule', max: 30 },
        { key: 'lastSeen', label: 'last seen', max: 9 },
        { key: 'resolvedAt', label: 'resolved at', max: 24 }
      ]
    )
    if (result.confirmation) out.line(`confirmed  ${result.confirmation.at}  note: ${result.confirmation.note}`)
    if (result.confirmationError) out.line(out.warn(`not confirmed: ${result.confirmationError}`))
    for (const step of result.next) out.line(`next  ${step}`)
    out.md(`# Re-check ${result.key}`)
    out.md('')
    out.md(`- ${result.resolved ? 'Resolved' : 'Still firing'} (${result.rounds} rounds${result.timedOut ? ', timed out' : ''})`)
    if (result.confirmation) out.md(`- Confirmed: ${result.confirmation.note}`)
    if (result.confirmationError) out.md(`- Not confirmed: ${result.confirmationError}`)
    out.md('')
    out.md(markdownTable(result.observation.alerts.map((a) => ({ state: a.state, rule: a.rule, key: a.key })), [
      { key: 'state', label: 'state' },
      { key: 'rule', label: 'rule' },
      { key: 'key', label: 'alert' }
    ]))
    return result.resolved ? 0 : 1
  }
  const result = answer!.body as RecheckAnswer
  out.json(result)
  out.line(`${result.resolved ? out.ok('resolved') : out.warn('still firing')}  ${result.key}  ${result.alerts.length} alert${result.alerts.length === 1 ? '' : 's'} re-checked`)
  out.table(
    result.alerts.map((a) => ({
      alert: a.key,
      before: a.before,
      after: a.after,
      sources: a.sources.map((s) => `${s.id}:${s.ok ? 'ok' : s.error ?? 'failed'}${s.throttled ? '(gap)' : ''}`).join(', '),
      rule: a.rule
    })),
    [
      { key: 'alert', label: 'alert', max: 26 },
      { key: 'rule', label: 'rule', max: 24 },
      { key: 'before', label: 'before', max: 8 },
      { key: 'after', label: 'after', max: 8 },
      { key: 'sources', label: 'sources', max: 40 }
    ]
  )
  out.line(out.dim('next: watcher recheck \'<key>\' --wait --timeout 60'))
  out.md(`# Re-check ${result.key}`)
  out.md('')
  out.md(`- ${result.resolved ? 'Resolved' : `Still firing (${result.stillFiring})`}`)
  out.md('')
  out.md(markdownTable(result.alerts.map((a) => ({ alert: a.key, before: a.before, after: a.after })), [
    { key: 'alert', label: 'alert' },
    { key: 'before', label: 'before' },
    { key: 'after', label: 'after' }
  ]))
  return 0
}
