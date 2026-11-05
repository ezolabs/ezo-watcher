import { createDecipheriv, createECDH, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, verify } from 'node:crypto'
import type { ECDH } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { WebPushChannelConfig } from '../src/server/config.ts'
import { createChannel } from '../src/server/notify/channels/index.ts'
import type { ChannelDeps, PushSub, PushSubscriptionStore } from '../src/server/notify/channels/index.ts'
import type { Message } from '../src/server/notify/types.ts'

// Real keys and real encryption: the fake fetch decrypts what it receives, as a browser would (RFC 8291).
const vapidPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const vapidJwk = vapidPair.privateKey.export({ format: 'jwk' })
const VAPID_PUBLIC = Buffer.concat([Buffer.from([4]), Buffer.from(vapidJwk.x as string, 'base64url'), Buffer.from(vapidJwk.y as string, 'base64url')]).toString('base64url')
const VAPID_PRIVATE = vapidJwk.d as string
const SUBJECT = 'mailto:ops@example.com'

const cfg: WebPushChannelConfig = { id: 'push', type: 'webpush', publicKeyEnv: 'VAPID_PUB', privateKeyEnv: 'VAPID_PRIV', subject: SUBJECT }
const env = { VAPID_PUB: VAPID_PUBLIC, VAPID_PRIV: VAPID_PRIVATE }

interface Browser {
  sub: PushSub
  ecdh: ECDH
  auth: Buffer
}

function browser(n: number): Browser {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = randomBytes(16)
  const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }
  return { sub: { endpoint: `https://push.example/send/${n}`, keys }, ecdh, auth }
}

function decrypt(body: Uint8Array, b: Browser): string {
  const buf = Buffer.from(body)
  const salt = buf.subarray(0, 16)
  const idLength = buf[20]
  const serverPublic = buf.subarray(21, 21 + idLength)
  const sealed = buf.subarray(21 + idLength)
  const shared = b.ecdh.computeSecret(serverPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), b.ecdh.getPublicKey(), serverPublic])
  const ikm = Buffer.from(hkdfSync('sha256', shared, b.auth, keyInfo, 32))
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const decipher = createDecipheriv('aes-128-gcm', key, nonce)
  decipher.setAuthTag(sealed.subarray(sealed.length - 16))
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()])
  let end = plain.length
  while (end > 0 && plain[end - 1] === 0) end--
  return plain.subarray(0, end - 1).toString('utf8') // the byte before the zero padding is the 0x02 delimiter
}

interface Call {
  url: string
  init: RequestInit
}

function setup(statusFor: (endpoint: string) => number | 'hang', browsers: Browser[]) {
  const calls: Call[] = []
  const removed: string[] = []
  const subscriptions: PushSubscriptionStore = { list: () => browsers.map((b) => b.sub), remove: (e) => removed.push(e) }
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const status = statusFor(String(url))
    if (status === 'hang') {
      const signal = init?.signal as AbortSignal
      return new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
    return new Response(null, { status })
  }) as typeof fetch
  const deps: ChannelDeps = { fetch: fetchFn, env, now: () => 5_000, subscriptions, timeoutMs: 200 }
  return { calls, removed, deps, channel: createChannel(cfg, deps) }
}

const msg: Message = {
  kind: 'alert',
  title: 'Page: API edge dead',
  body: 'edge, 2 instances firing since 14:05 UTC, 12m old.\nweb-1: 0',
  severity: 'page',
  tag: 'edge|EdgeDead',
  url: 'https://watch.example/#/i/edge%7CEdgeDead',
  ackUrl: 'https://watch.example/api/ack?k=edge%7CEdgeDead&s=abc123'
}

describe('webpush', () => {
  it('sends one encrypted, VAPID-signed request per subscription', async () => {
    const browsers = [browser(1), browser(2), browser(3)]
    const { calls, channel, removed } = setup(() => 201, browsers)
    const result = await channel.send(msg)
    expect(result).toEqual({ ok: true, status: '3 of 3 accepted', latencyMs: 0 })
    expect(removed).toEqual([])
    expect(calls.map((c) => c.url).sort()).toEqual(browsers.map((b) => b.sub.endpoint))

    const call = calls[0]
    expect(String(call.init.method).toUpperCase()).toBe('POST')
    const headers = new Headers(call.init.headers)
    expect(headers.get('ttl')).toBe('3600')
    expect(headers.get('urgency')).toBe('high')
    expect(headers.get('content-encoding')).toBe('aes128gcm')
    expect(headers.get('content-type')).toBe('application/octet-stream')

    const expected = {
      title: msg.title,
      body: msg.body,
      url: msg.url,
      tag: msg.tag,
      severity: 'page',
      requireInteraction: true,
      ackUrl: msg.ackUrl
    }
    for (const c of calls) {
      const target = browsers.find((b) => b.sub.endpoint === c.url) as Browser
      expect(JSON.parse(decrypt(c.init.body as Uint8Array, target))).toEqual(expected)
    }
  })

  it('signs a VAPID token for the push service origin and the configured subject', async () => {
    const { calls, channel } = setup(() => 201, [browser(1)])
    await channel.send(msg)
    const auth = new Headers(calls[0].init.headers).get('authorization') as string
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(auth)
    expect(match).not.toBeNull()
    const [header, claims, signature] = (match as RegExpExecArray)[1].split('.')
    expect((match as RegExpExecArray)[2]).toBe(VAPID_PUBLIC)
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({ aud: 'https://push.example', sub: SUBJECT })
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: vapidJwk.x, y: vapidJwk.y }, format: 'jwk' })
    const signed = Buffer.from(`${header}.${claims}`)
    expect(verify('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true)
  })

  it('uses normal urgency for anything but a page and keeps the payload inside the size limit', async () => {
    const b = browser(1)
    const { calls, channel } = setup(() => 201, [b])
    const result = await channel.send({ ...msg, severity: 'warning', ackUrl: undefined, body: 'x'.repeat(10_000) })
    expect(result.ok).toBe(true)
    const headers = new Headers(calls[0].init.headers)
    expect(headers.get('urgency')).toBeNull()
    expect(headers.get('ttl')).toBe('3600')
    const payload = JSON.parse(decrypt(calls[0].init.body as Uint8Array, b))
    expect(payload.requireInteraction).toBe(false)
    expect(payload).not.toHaveProperty('ackUrl')
    expect(payload.body.length).toBeLessThanOrEqual(1500)
  })

  it('removes subscriptions the push service reports gone and keeps counting the rest', async () => {
    const browsers = [browser(1), browser(2), browser(3)]
    const status = (e: string) => (e.endsWith('/1') ? 410 : e.endsWith('/2') ? 404 : 201)
    const { channel, removed } = setup(status, browsers)
    const result = await channel.send(msg)
    expect(result).toMatchObject({ ok: true, status: '1 of 3 accepted', detail: '2 removed' })
    expect(removed.sort()).toEqual(['https://push.example/send/1', 'https://push.example/send/2'])
  })

  it('keeps a subscription on a server error and is not ok when none accepted', async () => {
    const { channel, removed } = setup(() => 500, [browser(1), browser(2)])
    const result = await channel.send(msg)
    expect(result).toMatchObject({ ok: false, status: '0 of 2 accepted' })
    expect(removed).toEqual([])
  })

  it('counts a malformed subscription as failed without failing the others', async () => {
    const good = browser(1)
    const plain: Browser = { ...browser(2), sub: { endpoint: 'http://push.example/insecure', keys: browser(2).sub.keys } }
    const { channel, calls } = setup(() => 201, [plain, good])
    const result = await channel.send(msg)
    expect(result).toMatchObject({ ok: true, status: '1 of 2 accepted' })
    expect(calls).toHaveLength(1)
  })

  it('says "no subscribers" without calling anyone', async () => {
    const { channel, calls } = setup(() => 201, [])
    expect(await channel.send(msg)).toMatchObject({ ok: false, status: 'no subscribers' })
    expect(calls).toHaveLength(0)
  })

  it('refuses a subject that is not a mailto: or https: URI', async () => {
    const f = setup(() => 201, [browser(1)])
    const bad = createChannel({ ...cfg, subject: 'ops@example.com' }, f.deps)
    expect(await bad.send(msg)).toMatchObject({ ok: false, status: 'error', detail: 'bad vapid subject' })
    expect(f.calls).toHaveLength(0)
    const https = createChannel({ ...cfg, subject: 'https://example.com/contact' }, f.deps)
    expect((await https.send(msg)).ok).toBe(true)
  })

  it('times out and reports missing keys without leaking the key material', async () => {
    const slow = await setup(() => 'hang', [browser(1), browser(2)]).channel.send(msg)
    expect(slow).toMatchObject({ ok: false, status: 'timeout', detail: 'TimeoutError' })

    const f = setup(() => 201, [browser(1)])
    const missing = await createChannel(cfg, { ...f.deps, env: { VAPID_PUB: VAPID_PUBLIC } }).send(msg)
    expect(missing).toMatchObject({ ok: false, status: 'error', detail: 'missing credential' })

    for (const result of [slow, missing, await setup(() => 500, [browser(1)]).channel.send(msg)]) {
      const text = JSON.stringify(result)
      expect(text).not.toContain(VAPID_PRIVATE)
      expect(text).not.toContain(VAPID_PUBLIC)
      expect(text).not.toContain('push.example')
    }
  })
})
