// A Web Push channel nobody has subscribed to is not configured yet: a send or test answers "no subscribers" (ok: false, so a page moves
// on down the ladder) and pushUnconfigured() tells that apart from a delivery that failed. With a subscriber, a send works as it always did.

import { createECDH, generateKeyPairSync, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { WebPushChannelConfig } from '../src/server/config.ts'
import { createChannel } from '../src/server/notify/channels/index.ts'
import type { ChannelDeps, PushSub } from '../src/server/notify/channels/index.ts'
import { NO_SUBSCRIBERS, pushUnconfigured } from '../src/server/notify/channels/webpush.ts'
import { testMessage } from '../src/server/notify/message.ts'

const vapid = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' })
const env = {
  VAPID_PUB: Buffer.concat([Buffer.from([4]), Buffer.from(vapid.x as string, 'base64url'), Buffer.from(vapid.y as string, 'base64url')]).toString('base64url'),
  VAPID_PRIV: vapid.d as string
}
const cfg: WebPushChannelConfig = { id: 'webpush', type: 'webpush', publicKeyEnv: 'VAPID_PUB', privateKeyEnv: 'VAPID_PRIV', subject: 'mailto:ops@example.com' }

function subscriber(n: number): PushSub {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { endpoint: `https://push.example/send/${n}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
}

function setup(subs: PushSub[], status = 201) {
  const calls: string[] = []
  const removed: string[] = []
  const fetchFn = (async (url: string | URL | Request) => {
    calls.push(String(url))
    return new Response(null, { status })
  }) as typeof fetch
  const deps: ChannelDeps = {
    fetch: fetchFn,
    env,
    now: () => 5_000,
    timeoutMs: 500,
    subscriptions: {
      list: () => subs.filter((s) => !removed.includes(s.endpoint)),
      remove: (e) => removed.push(e)
    }
  }
  return { calls, removed, channel: createChannel(cfg, deps) }
}

const test = testMessage('https://watch.example')

describe('webpush with no subscribers', () => {
  it('answers a test with no subscribers as unconfigured, calling nobody', async () => {
    const { channel, calls } = setup([])
    const result = await channel.send(test)
    expect(result).toEqual({ ok: false, status: NO_SUBSCRIBERS, latencyMs: 0 })
    expect(NO_SUBSCRIBERS).toBe('no subscribers')
    expect(pushUnconfigured(result)).toBe(true)
    expect(calls).toEqual([])
  })

  it('sends a test to one subscriber as before, which is not unconfigured', async () => {
    const { channel, calls } = setup([subscriber(1)])
    const result = await channel.send(test)
    expect(result).toEqual({ ok: true, status: '1 of 1 accepted', latencyMs: 0 })
    expect(pushUnconfigured(result)).toBe(false)
    expect(calls).toEqual(['https://push.example/send/1'])
  })

  it('keeps a push service that refused the one subscriber a failure', async () => {
    const { channel, removed } = setup([subscriber(1)], 500)
    const result = await channel.send(test)
    expect(result).toMatchObject({ ok: false, status: '0 of 1 accepted' })
    expect(pushUnconfigured(result)).toBe(false)
    expect(removed).toEqual([])
  })

  it('answers no subscribers when every stored subscription turns out gone, and the next test agrees', async () => {
    const { channel, removed, calls } = setup([subscriber(1), subscriber(2)], 410)
    const first = await channel.send(test)
    expect(first).toEqual({ ok: false, status: NO_SUBSCRIBERS, detail: '2 removed', latencyMs: 0 })
    expect(pushUnconfigured(first)).toBe(true)
    expect(removed.sort()).toEqual(['https://push.example/send/1', 'https://push.example/send/2'])
    const again = await channel.send(test)
    expect(pushUnconfigured(again)).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('reads a stored results row the same way: ok 0 with no subscribers is unconfigured, any other row is not', () => {
    expect(pushUnconfigured({ ok: 0, status: 'no subscribers' })).toBe(true)
    expect(pushUnconfigured({ ok: 0, status: '0 of 1 accepted' })).toBe(false)
    expect(pushUnconfigured({ ok: 0, status: 'timeout' })).toBe(false)
    expect(pushUnconfigured({ ok: 1, status: '1 of 1 accepted' })).toBe(false)
  })
})
