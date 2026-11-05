// `watcher rm <id>`: take one source or channel out of .watcher/config.json through the server's
// validator, and take a removed channel out of every route that named it. A channel a route still
// referred to would make the whole config invalid, and a hand edit is exactly how an id survives a
// removal; this is the reverse of `watcher add`, not a text editor.
//
// The write goes through `validateConfig` like every other writer, and `_meta` is re-stamped, so a
// removal is reported as a managed write rather than a hand edit (config.hand-edited).

import type { ParsedArgs } from './util.ts'
import { CliError, flagValue, usageError } from './util.ts'
import type { Output } from './output.ts'
import { cliVersion, managedHash, readConfig, resolveProject, writeConfig } from './project.ts'
import { validateConfig } from '../server/config.ts'

export const RM_SPEC = {
  valueFlags: ['dir', 'output', 'id'],
  switchFlags: ['help', 'dry-run']
} as const

/**
 * Drop one channel id from a route's receivers, record list and escalation steps, and remove a route
 * that existed only to deliver to it. A route with `continue: true` stays even with nothing left: it is
 * also a matcher, and deleting it would let later routes catch incidents it was meant to stop.
 */
function withoutChannel(
  routes: Array<Record<string, unknown>>,
  id: string
): { routes: Array<Record<string, unknown>>; changed: string[]; removed: string[] } {
  const changed: string[] = []
  const removed: string[] = []
  const kept: Array<Record<string, unknown>> = []
  const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
  for (const route of routes) {
    const receivers = listOf(route.receivers)
    const record = listOf(route.record)
    const escalate = listOf(route.escalate) as Array<Record<string, unknown>>
    const named = receivers.includes(id) || record.includes(id) || escalate.some((step) => listOf(step.receivers).includes(id))
    if (!named) {
      kept.push(route)
      continue
    }
    const pulled = String(route.id)
    const nextReceivers = receivers.filter((receiver) => receiver !== id)
    const nextRecord = record.filter((receiver) => receiver !== id)
    const nextEscalate = escalate
      .map((step) => ({ ...step, receivers: listOf(step.receivers).filter((receiver) => receiver !== id) }))
      .filter((step) => listOf(step.receivers).length > 0)
    if (nextReceivers.length === 0 && nextRecord.length === 0 && nextEscalate.length === 0 && route.continue !== true) {
      removed.push(pulled)
      continue
    }
    const next: Record<string, unknown> = { ...route, receivers: nextReceivers }
    if (record.length > 0) next.record = nextRecord
    if (escalate.length > 0) next.escalate = nextEscalate
    kept.push(next)
    changed.push(pulled)
  }
  return { routes: kept, changed, removed }
}

export async function runRm(args: ParsedArgs, out: Output): Promise<number> {
  const project = resolveProject(args.dir)
  const read = readConfig(project)
  if (!read.ok) throw new CliError(read.error.code, read.error.message, { next: read.error.next })
  const positional = args.positionals[0]
  const flagged = flagValue(args, 'id')
  if (positional !== undefined && flagged !== undefined && positional !== flagged) {
    throw usageError('rm.id-conflict', `two different ids were given: ${JSON.stringify(positional)} and ${JSON.stringify(flagged)}`, 'Name the id once: watcher rm <id>')
  }
  const id = positional ?? flagged
  if (id === undefined || id.trim() === '') {
    throw usageError('usage.missing-id', 'rm needs the id of the source or channel to remove', 'Example: watcher rm ntfy   (watcher status lists the ids)')
  }
  const raw = read.raw
  const sources = (raw.sources ?? []) as Array<Record<string, unknown>>
  const channels = (raw.channels ?? []) as Array<Record<string, unknown>>
  const routes = (raw.routes ?? []) as Array<Record<string, unknown>>
  const sourceAt = sources.findIndex((entry) => entry.id === id)
  const channelAt = channels.findIndex((entry) => entry.id === id)
  if (sourceAt < 0 && channelAt < 0) {
    const known = [...sources, ...channels].map((entry) => `${String(entry.id)} (${String(entry.type)})`)
    throw new CliError('rm.unknown-id', `no source or channel has the id ${id}`, {
      next: known.length > 0 ? `Configured: ${known.join(', ')}.` : 'The config has no sources or channels to remove.'
    })
  }
  let removed: 'source' | 'channel'
  let nextRoutes = routes
  let routesChanged: string[] = []
  let routesRemoved: string[] = []
  if (sourceAt >= 0) {
    sources.splice(sourceAt, 1)
    removed = 'source'
  } else {
    channels.splice(channelAt, 1)
    removed = 'channel'
    // A route that still named the channel would fail the validator, so the removal carries through.
    const pulled = withoutChannel(routes, id)
    nextRoutes = pulled.routes
    routesChanged = pulled.changed
    routesRemoved = pulled.removed
  }

  const candidate: Record<string, unknown> = { ...raw, sources, channels, routes: nextRoutes }
  candidate._meta = { writer: 'watcher', version: cliVersion(), sha256: managedHash(candidate) }
  if (!args.dryRun) {
    const written = writeConfig(project, candidate)
    if (!written.ok) throw new CliError(written.error.code, written.error.message, { next: written.error.next })
  } else {
    const checked = validateConfig(candidate)
    if (!checked.ok) throw new CliError('config.invalid', checked.errors.join('; '), { next: 'Fix the fields named above and run the command again.' })
  }

  const result = {
    ok: true,
    dryRun: args.dryRun,
    removed,
    id,
    configPath: project.configPath,
    ...(removed === 'channel' ? { routesChanged, routesRemoved } : {})
  }
  out.json(result)
  out.line(`${out.ok(args.dryRun ? 'would remove' : 'removed')} ${removed} ${out.bold(id)} from ${project.configPath}`)
  for (const route of routesChanged) out.line(`route   ${route} no longer names ${id}`)
  for (const route of routesRemoved) out.line(`route   ${route} removed (it delivered only to ${id})`)
  out.line(`next    watcher doctor`)
  return 0
}
