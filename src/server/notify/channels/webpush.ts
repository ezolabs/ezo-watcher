// Web Push: RFC 8291 aes128gcm encryption and RFC 8292 VAPID, both done by @block65/webcrypto-web-push
// (README retrieved from node_modules, v2.0.0). The library builds the request; this file only fans it out
// to the stored subscriptions and prunes the dead ones (404 and 410 mean the browser dropped it).

import { buildPushPayload } from '@block65/webcrypto-web-push'
import { secret } from '../../config.ts'
import type { WebPushChannelConfig } from '../../config.ts'
import type { Channel, Message } from '../types.ts'
import { cut, drain, guarded } from './common.ts'
import type { ChannelDeps, Outcome } from './common.ts'

export interface PushSub {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface PushSubscriptionStore {
  list(): PushSub[]
  remove(endpoint: string): void
}

interface Vapid {
  subject: string
  publicKey: string
  privateKey: string
}

const TTL_SEC = 3600
const GONE = new Set([404, 410])

/**
 * The status of a send that found nobody subscribed: the channel is not configured yet, which is not a delivery failure. The send still
 * reads ok: false, so the notifier counts nothing delivered and moves on to the next receiver, but a test that answers it is a channel
 * with no subscribers, not a failed test. Kept word for word: the result rows written since 2026-10-14 carry it.
 */
export const NO_SUBSCRIBERS = 'no subscribers'

/** Whether a send or test result (a SendResult, or a results row whose ok is 0 or 1) says the push channel has no subscribers. */
export function pushUnconfigured(result: { ok: boolean | number; status: string }): boolean {
  return !result.ok && result.status === NO_SUBSCRIBERS
}

function payload(msg: Message): Record<string, string | boolean> {
  return {
    title: cut(msg.title, 200),
    body: cut(msg.body, 1500),
    url: msg.url,
    tag: msg.tag,
    severity: msg.severity,
    requireInteraction: msg.severity === 'page',
    ...(msg.ackUrl ? { ackUrl: msg.ackUrl } : {})
  }
}

type Push = 'ok' | 'gone' | 'failed'

async function pushOne(sub: PushSub, msg: Message, vapid: Vapid, deps: ChannelDeps, signal: AbortSignal): Promise<Push> {
  try {
    const options = msg.severity === 'page' ? { ttl: TTL_SEC, urgency: 'high' as const } : { ttl: TTL_SEC }
    const request = await buildPushPayload(
      { data: payload(msg), options },
      { endpoint: sub.endpoint, expirationTime: null, keys: sub.keys },
      vapid
    )
    const res = await deps.fetch(sub.endpoint, { ...request, signal })
    await drain(res)
    if (res.ok) return 'ok'
    if (GONE.has(res.status)) {
      deps.subscriptions?.remove(sub.endpoint)
      return 'gone'
    }
    return 'failed'
  } catch {
    // One bad subscription (a non-https endpoint, a malformed key) must not fail the others.
    return 'failed'
  }
}

function vapidFor(cfg: WebPushChannelConfig, env: NodeJS.ProcessEnv): Vapid | null {
  if (!/^(mailto:|https:\/\/)/.test(cfg.subject)) return null
  return { subject: cfg.subject, publicKey: secret(env, cfg.publicKeyEnv), privateKey: secret(env, cfg.privateKeyEnv) }
}

async function fanOut(cfg: WebPushChannelConfig, msg: Message, deps: ChannelDeps, signal: AbortSignal): Promise<Outcome> {
  const subs = deps.subscriptions?.list() ?? []
  if (subs.length === 0) return { ok: false, status: NO_SUBSCRIBERS }
  const vapid = vapidFor(cfg, deps.env)
  if (!vapid) return { ok: false, status: 'error', detail: 'bad vapid subject' }
  const results = await Promise.all(subs.map((s) => pushOne(s, msg, vapid, deps, signal)))
  const accepted = results.filter((r) => r === 'ok').length
  const gone = results.filter((r) => r === 'gone').length
  if (accepted === 0 && signal.aborted) throw signal.reason
  // Every stored subscription was one the browser had dropped and is now removed: nobody is subscribed, the same state as an empty list.
  if (gone === subs.length) return { ok: false, status: NO_SUBSCRIBERS, detail: `${gone} removed` }
  return {
    ok: accepted > 0,
    status: `${accepted} of ${subs.length} accepted`,
    ...(gone > 0 ? { detail: `${gone} removed` } : {})
  }
}

export function createWebPushChannel(cfg: WebPushChannelConfig, deps: ChannelDeps): Channel {
  return {
    id: cfg.id,
    type: 'webpush',
    send: (msg, signal) => guarded(deps, signal, (sig) => fanOut(cfg, msg, deps, sig))
  }
}
