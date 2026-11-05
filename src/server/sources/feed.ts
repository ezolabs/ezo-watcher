// feed source: a sender's push body, read by a poll instead of pushed. `GET <url>` with `Authorization: Bearer <tokenEnv's value>` answers exactly
// what POST /ingest/<source> takes: an Alertmanager v4 `alerts` list and/or a top-level `checks` object (skills/ezo-watcher/references/sources.md "A `checks` push"). It is read
// by the webhook ingest's own parser (sources/webhook.ts normalizeWebhook), under the sender origin the config names (`origin`, else the source id),
// so a feed and a push of the same body put the same alerts and cells on the wall. a second instance's `GET /api/ops/watch` is one.
//
// A good answer is the sender's whole state: a firing alert this feed reported before and does not list now is resolved (the Observation is
// complete), and a `checks` object is complete unless it says otherwise. A poll that fails changes nothing: a network error, a timeout, a status
// outside 2xx (a redirect is never followed: the token must not go anywhere else), a body over 1 MiB, one that is not JSON or one the parser refuses
// all throw, the engine counts a miss, and after `staleAfterMisses` misses the source reads Not answering and raises the source-stale warning.
// An error names the request, the status or the field the parser refused, never a value of the body and never the token.
//
// Plain http goes only to a loopback, RFC 1918 or 100.64.0.0/10 address (config.ts plainHttpAllowed); everything else is https.

import type { Observation } from '../../shared/types.ts'
import { secret } from '../config.ts'
import type { FeedSourceConfig } from '../config.ts'
import { hasChecks } from './checks.ts'
import type { PolledSource, SourceDeps } from './types.ts'
import { BadPayload, isRecord, readBodyCapped, requestFailure } from './shared.ts'
import { normalizeWebhook } from './webhook.ts'

export const FEED_DEFAULTS = { pollSec: 60, timeoutMs: 10_000 } as const
/** The largest body a feed may answer: the same 1 MiB POST /ingest/<source> takes. */
export const FEED_MAX_BODY_BYTES = 1_048_576

/**
 * One good answer's body as the Observation: the webhook parser's, marked complete. A body with neither an `alerts` list nor `checks` is refused
 * (a push may be a Netdata Cloud body; a feed may not), and so is an `alerts` that is not a list: either would otherwise read as "nothing firing"
 * and resolve everything. Throws BadPayload, whose message names a field and never a value.
 */
export function normalizeFeed(body: unknown, cfg: Pick<FeedSourceConfig, 'id' | 'origin'>, deps: SourceDeps): Observation {
  if (!isRecord(body)) throw new BadPayload('payload must be a JSON object')
  if ('alerts' in body && !Array.isArray(body.alerts)) throw new BadPayload('alerts must be a list')
  if (!Array.isArray(body.alerts) && !hasChecks(body)) throw new BadPayload('payload has no alerts list and no checks')
  const obs = normalizeWebhook(body, { source: cfg.id, origin: cfg.origin ?? cfg.id, kind: 'feed', deps })
  return { ...obs, complete: true }
}

export function createFeedSource(cfg: FeedSourceConfig, deps: SourceDeps): PolledSource {
  const timeoutMs = cfg.timeoutMs ?? FEED_DEFAULTS.timeoutMs

  async function poll(): Promise<Observation> {
    // Read on every poll, so a token added to the host applies at the next poll; a missing one names the variable, never a value.
    const token = secret(deps.env, cfg.tokenEnv)
    // One deadline for the request and its body.
    const signal = AbortSignal.timeout(timeoutMs)
    let res: Response
    try {
      res = await deps.fetch(cfg.url, { redirect: 'manual', signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
    } catch (err) {
      throw new Error(`feed request failed: ${requestFailure(err, timeoutMs)}`)
    }
    if (res.status < 200 || res.status > 299) {
      await res.body?.cancel().catch(() => undefined)
      throw new Error(`feed returned HTTP ${res.status}`)
    }
    let text: string | null
    try {
      text = await readBodyCapped(res, FEED_MAX_BODY_BYTES)
    } catch (err) {
      throw new Error(`feed request failed: ${requestFailure(err, timeoutMs)}`)
    }
    if (text === null) throw new Error('feed returned a body over 1 MiB')
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error('feed returned a body that is not JSON')
    }
    try {
      return normalizeFeed(body, cfg, deps)
    } catch (err) {
      if (err instanceof BadPayload) throw new Error(`feed body refused: ${err.message}`)
      throw err
    }
  }

  return { id: cfg.id, kind: 'feed', name: 'feed', pollSec: cfg.pollSec ?? FEED_DEFAULTS.pollSec, poll }
}
