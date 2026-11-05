// What an agent reads when it dials the Watcher, in the exact words it gets them: the session brief (`watcher status --brief`, which the
// SessionStart hook runs), the MCP tool list, and the call that fetches one incident's fix brief. The incident sheet and the demo's agent
// panel both render from here, so a person sees the same characters an agent does.

import { incidentTitle } from '../../shared/incident.ts'
import type { WallState } from '../../shared/types.ts'

/** The most incidents the brief lists before it says `+N more`: `runBrief` in src/cli/status.ts. */
export const BRIEF_MAX = 8

/** The brief's last line, the pointer to the next read: `runBrief` in src/cli/status.ts. */
export const BRIEF_HINT = 'run `watcher incident <key> --fix-context` or the MCP tool get_fix_context'

/** The command the agent's session hook runs: `HOOK_COMMAND` in src/cli/hooks.ts. */
export const BRIEF_COMMAND = 'watcher status --brief'

/** A human age from an ISO timestamp, as the CLI prints it ("3m", "2h", "4d"): `ageOf` in src/cli/output.ts. */
export function briefAge(iso: string | null, nowMs: number): string {
  if (!iso) return '-'
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return '-'
  const sec = Math.max(0, Math.round((nowMs - at) / 1000))
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h`
  return `${Math.floor(sec / 86_400)}d`
}

/**
 * The lines `watcher status --brief` prints for this wall: one per open incident (firing and not parked; an acknowledged one stays, since it
 * is still open), at most `BRIEF_MAX`, then the hint. Nothing at all when nothing is open: the hook stays silent on a green wall.
 */
export function statusBrief(wall: Pick<WallState, 'incidents'>, nowMs: number): string[] {
  const open = wall.incidents.filter((i) => i.state.firing !== false && i.state.attention !== 'parked')
  if (open.length === 0) return []
  const lines = open.slice(0, BRIEF_MAX).map((i) => `${i.severity}  ${i.service}  ${incidentTitle(i)}  ${briefAge(i.startsAt, nowMs)}  ${i.key}`)
  if (open.length > BRIEF_MAX) lines.push(`+${open.length - BRIEF_MAX} more`)
  lines.push(BRIEF_HINT)
  return lines
}

/** The text an MCP tool answers with: its result as JSON, one space of indent (src/server/mcp/server.ts). */
export function mcpText(data: unknown): string {
  return JSON.stringify(data, null, 1)
}

/** The call as an agent writes it: the tool and its arguments. */
export function mcpCall(tool: string, args: Record<string, unknown>): string {
  return `${tool} ${JSON.stringify(args)}`
}

/** A shell word that survives any key: single-quoted, with a quote inside closed, escaped and reopened. */
function shellWord(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** The CLI's way to the same brief, as JSON (`watcher incident <key> --fix-context`, src/cli/incident.ts). */
export function cliFixContext(key: string): string {
  return `watcher incident ${shellWord(key)} --fix-context --json`
}

/** Where the incident sheet and the CLI read the fix brief: the same handler the MCP tool runs (src/server/app.ts). */
export function fixContextPath(key: string): string {
  return `/api/incidents/${encodeURIComponent(key)}/fix-context`
}

/**
 * The tools an agent finds on the Watcher's MCP endpoint, in the server's order (`TOOLS` in src/server/mcp/tools.ts), each with the one line
 * that says when to reach for it. `reads` tools change nothing; the rest act on the Watcher.
 */
export const AGENT_TOOLS: ReadonlyArray<{ name: string; line: string; reads: boolean }> = [
  { name: 'watch_state', line: 'The wall in one answer: counts by severity and by who has them, one row per incident.', reads: true },
  { name: 'list_incidents', line: 'Incidents by state: firing, unattended, acknowledged, silenced, parked or resolved.', reads: true },
  { name: 'get_incident', line: 'One incident whole: its alerts, who has it, its history and comments.', reads: true },
  { name: 'get_fix_context', line: 'One brief for fixing an incident without asking a person.', reads: true },
  { name: 'incident_history', line: 'What ended in a time range, and who acknowledged, silenced or confirmed what.', reads: true },
  { name: 'list_sources', line: 'Every source: its state, when it last answered, and any error.', reads: true },
  { name: 'acknowledge', line: 'Say you are working an incident; the pager stops escalating it.', reads: false },
  { name: 'unacknowledge', line: 'Hand an incident back: unattended again, and the pager resumes.', reads: false },
  { name: 'silence', line: 'Pause the pager for one incident, for at most 4 hours.', reads: false },
  { name: 'park', line: 'Take a fixed or decided incident off the live wall until it is due.', reads: false },
  { name: 'unpark', line: 'End a park now: the incident is back, unattended.', reads: false },
  { name: 'comment', line: 'Leave what you found, a link or the fixing commit on an incident.', reads: false },
  { name: 'recheck', line: 'Ask the sources again now instead of waiting for the next poll.', reads: false },
  { name: 'verify_fix', line: 'Re-check now, and close the incident when the fix holds.', reads: false },
  { name: 'resolve', line: 'Mark an incident resolved by hand, with a reason.', reads: false },
  { name: 'confirm_resolution', line: 'Record that an incident a source resolved stayed fixed.', reads: false }
]
