import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChannel } from '../src/server/notify/channels/index.ts'
import type { ChannelDeps } from '../src/server/notify/channels/index.ts'
import { emailHtml, emailSubject, emailText } from '../src/server/notify/channels/email.ts'
import { smsText } from '../src/server/notify/channels/sms.ts'
import type { ChannelConfig } from '../src/server/config.ts'
import type { Channel, InstanceView, Message, MessageIncident, SendResult } from '../src/server/notify/types.ts'

interface Call {
  url: string
  init: RequestInit
}

type Responder = (call: Call, n: number) => Response | Promise<Response>

function fakeFetch(respond: Responder = () => new Response('{}', { status: 200 })) {
  const calls: Call[] = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} }
    calls.push(call)
    return respond(call, calls.length)
  }) as typeof fetch
  return { fn, calls }
}

// Every value is a canary: if one shows up in a result, a channel leaked what it was given.
const canary = (name: string) => `canary-${name}-9f3a`
const ENV = {
  TOPIC: canary('topic'),
  NTFY_TOKEN: canary('ntfy'),
  NTFY_SELF_URL: 'https://ntfy-self.example/',
  NTFY_SELF_TOPIC: canary('selftopic'),
  NTFY_SELF_TOKEN: canary('selftoken'),
  SMS_KEY: canary('smsapi'),
  SMS_FROM: '+15550009999',
  SMS_TO: '+15550001111, +15550002222',
  MAIL_KEY: canary('mailapi'),
  MAIL_TO: 'oncall@canary-domain.example, boss@canary-domain.example',
  CHAT_TOKEN: canary('chattoken'),
  HOOK_URL: 'https://hooks.canary-host.example/path/canarypath'
}
const HOOK_HEADER = canary('hookheader')

function deps(over: Partial<ChannelDeps> & { fetch: typeof fetch }): ChannelDeps {
  return { env: { ...ENV }, now: () => Date.UTC(2026, 9, 14, 12, 0, 30), ...over }
}

const msg: Message = {
  kind: 'alert',
  title: 'Page: API edge dead',
  body: 'edge, 2 instances firing since 14:05 UTC, 12m old.\nweb-1: 0\nweb-2: 0',
  severity: 'page',
  tag: 'edge|EdgeDead',
  url: 'https://watch.example/#/i/edge%7CEdgeDead',
  ackUrl: 'https://watch.example/api/ack?k=edge%7CEdgeDead&s=abc123',
  links: { runbook: 'https://wiki.example/edge' }
}

/** A response that never arrives: it rejects only when the signal aborts, like a real fetch. */
const hang: Responder = (call) =>
  new Promise<Response>((_, reject) => {
    const signal = call.init.signal as AbortSignal
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })

function expectNoSecrets(result: SendResult) {
  const text = JSON.stringify(result)
  const forbidden = [...Object.values(ENV).flatMap((v) => v.split(',').map((s) => s.trim())), HOOK_HEADER, 'canary']
  for (const value of forbidden) expect(text).not.toContain(value)
}

/** Runs the shared failure paths against one channel: server error, thrown error, timeout, missing secret. */
async function sweepFailures(make: (d: ChannelDeps) => Channel, brokenEnvName: string, status500 = '500') {
  const serverError = await make(deps({ fetch: fakeFetch(() => new Response('nope', { status: 500 })).fn })).send(msg)
  expect(serverError.ok).toBe(false)
  expect(serverError.status).toBe(status500)
  expectNoSecrets(serverError)

  const thrown = await make(
    deps({
      fetch: (async () => {
        throw new TypeError(`fetch failed: connect ECONNREFUSED ${ENV.HOOK_URL} ${ENV.TOPIC} ${ENV.SMS_TO}`)
      }) as typeof fetch
    })
  ).send(msg)
  expect(thrown).toMatchObject({ ok: false, status: 'error', detail: 'TypeError' })
  expectNoSecrets(thrown)

  const slow = await make(deps({ fetch: fakeFetch(hang).fn, timeoutMs: 20 })).send(msg)
  expect(slow).toMatchObject({ ok: false, status: 'timeout', detail: 'TimeoutError' })
  expectNoSecrets(slow)

  const ignoresSignal = await make(deps({ fetch: (() => new Promise(() => {})) as typeof fetch, timeoutMs: 20 })).send(msg)
  expect(ignoresSignal).toMatchObject({ ok: false, status: 'timeout' })

  const controller = new AbortController()
  controller.abort()
  const aborted = await make(deps({ fetch: fakeFetch(hang).fn })).send(msg, controller.signal)
  expect(aborted).toMatchObject({ ok: false, status: 'error', detail: 'AbortError' })

  const env: NodeJS.ProcessEnv = { ...ENV }
  delete env[brokenEnvName]
  const missing = await make(deps({ fetch: fakeFetch().fn, env })).send(msg)
  expect(missing).toMatchObject({ ok: false, status: 'error', detail: 'missing credential' })
  expect(JSON.stringify(missing)).not.toContain(brokenEnvName)
}

// ---- ntfy: two targets -------------------------------------------------------------------------------------------
// ntfy.sh is a public server, so it gets a content-free notice. The self-hosted server (ntfy.example.com) gets the full
// alert. NTFY_PRIMARY says which of the two the phone listens to, and only that one decides whether the ntfy step
// of the page ladder succeeded; the other is best effort.

const PUBLIC_URL = `https://ntfy.example/${ENV.TOPIC}`
const SELF_URL = `https://ntfy-self.example/${ENV.NTFY_SELF_TOPIC}`
const NOTICE = 'https://watch.example/go/0123456789abcdef0123456789abcdef'

/** Words of the alert in `msg`. None of them may reach ntfy.sh, in the URL, a header or the body. */
const ALERT_WORDS = ['API', 'edge', 'EdgeDead', 'web-1', 'web-2', 'wiki.example', 'instances', 'Page:', 'abc123', 'Acknowledge', 'runbook']

describe('ntfy', () => {
  const cfg: ChannelConfig = {
    id: 'phone',
    type: 'ntfy',
    server: 'https://ntfy.example/',
    topicEnv: 'TOPIC',
    self: { urlEnv: 'NTFY_SELF_URL', topicEnv: 'NTFY_SELF_TOPIC', tokenEnv: 'NTFY_SELF_TOKEN' },
    primaryEnv: 'NTFY_PRIMARY'
  }
  const make = (d: ChannelDeps) => createChannel(cfg, d)
  const pageMsg: Message = { ...msg, noticeUrl: NOTICE }
  const callTo = (f: { calls: Call[] }, url: string): Call[] => f.calls.filter((c) => c.url === url)
  const headersOf = (c: Call) => c.init.headers as Record<string, string>
  /** 200 for both servers unless a status is given per server. */
  const servers = (status: { public?: number; self?: number } = {}): Responder => (call) =>
    new Response('{"id":"abc"}', { status: (call.url.startsWith('https://ntfy-self.') ? status.self : status.public) ?? 200 })
  const withEnv = (over: Record<string, string | undefined>): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...ENV }
    for (const [k, v] of Object.entries(over)) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    return env
  }

  describe('the notice on ntfy.sh carries no alert text', () => {
    it('publishes a fixed title and message and the opaque click link, in the headers it sends today and nothing else', async () => {
      const f = fakeFetch(servers())
      await make(deps({ fetch: f.fn })).send(pageMsg)
      const pub = callTo(f, PUBLIC_URL)
      expect(pub).toHaveLength(1)
      expect(pub[0].init.method).toBe('POST')
      expect(pub[0].init.body).toBe('Open Watch for details')
      expect(headersOf(pub[0])).toEqual({ Title: 'EZO Watcher: page', Priority: '5', Tags: 'rotating_light', Click: NOTICE })
    })

    it('has no service, host, rule, error text, link or Acknowledge action anywhere in the request', async () => {
      const f = fakeFetch(servers())
      await make(deps({ fetch: f.fn })).send({
        ...pageMsg,
        incident: {
          service: 'API edge',
          rule: 'EdgeDead',
          startsAt: '2026-10-14T12:00:00Z',
          unattendedSec: 0,
          instances: [{ fingerprint: 'fp', name: 'web-1', value: 'connection refused', startsAt: '2026-10-14T12:00:00Z', summary: 'API edge dead' }]
        }
      })
      const pub = callTo(f, PUBLIC_URL)[0]
      const wire = JSON.stringify({ url: pub.url, init: { method: pub.init.method, headers: pub.init.headers, body: pub.init.body } }).toLowerCase()
      for (const word of ALERT_WORDS) expect(wire, word).not.toContain(word.toLowerCase())
      expect(wire).not.toContain('actions')
      expect(wire).not.toContain('authorization')
    })

    it('never uses the real incident link as the click target: a message with no notice link clicks through to the root', async () => {
      const f = fakeFetch(servers())
      await make(deps({ fetch: f.fn })).send(msg)
      expect(headersOf(callTo(f, PUBLIC_URL)[0]).Click).toBe('https://watch.example/')
    })

    it('titles by kind and severity only, with the priority and tags it sent before', async () => {
      const f = fakeFetch(servers())
      const channel = make(deps({ fetch: f.fn }))
      const cases: Array<[Partial<Message>, string, string, string]> = [
        [{ kind: 'alert', severity: 'page' }, 'EZO Watcher: page', '5', 'rotating_light'],
        [{ kind: 'alert', severity: 'warning' }, 'EZO Watcher: warning', '3', 'warning'],
        [{ kind: 'alert', severity: 'info' }, 'EZO Watcher: info', '2', 'information_source'],
        [{ kind: 'escalation', severity: 'warning' }, 'EZO Watcher: warning', '5', 'warning,arrow_up'],
        [{ kind: 'digest', severity: 'warning' }, 'EZO Watcher: digest', '2', 'clipboard'],
        [{ kind: 'resolved', severity: 'page' }, 'EZO Watcher: resolved', '2', 'white_check_mark'],
        [{ kind: 'test', severity: 'info' }, 'EZO Watcher: test', '3', 'test_tube'],
        [{ kind: 'flapping', severity: 'page' }, 'EZO Watcher: page', '3', 'repeat']
      ]
      for (const [over] of cases) await channel.send({ ...pageMsg, ...over })
      const pub = callTo(f, PUBLIC_URL)
      expect(pub).toHaveLength(cases.length)
      cases.forEach(([, title, priority, tags], i) => {
        const h = headersOf(pub[i])
        expect([h.Title, h.Priority, h.Tags, pub[i].init.body]).toEqual([title, priority, tags, 'Open Watch for details'])
      })
    })

    it('still sends a bearer token when the public server is given one', async () => {
      const f = fakeFetch(servers())
      await createChannel({ ...cfg, tokenEnv: 'NTFY_TOKEN' } as ChannelConfig, deps({ fetch: f.fn })).send(pageMsg)
      expect(headersOf(callTo(f, PUBLIC_URL)[0]).Authorization).toBe(`Bearer ${ENV.NTFY_TOKEN}`)
      expect(headersOf(callTo(f, SELF_URL)[0]).Authorization).toBe(`Bearer ${ENV.NTFY_SELF_TOKEN}`)
    })
  })

  describe('the self-hosted server gets the whole alert', () => {
    it('posts the full title and text, the real click link and the one-tap Acknowledge, authenticated with the watch token as Bearer', async () => {
      const f = fakeFetch(servers())
      await make(deps({ fetch: f.fn })).send(pageMsg)
      const self = callTo(f, SELF_URL)
      expect(self).toHaveLength(1)
      expect(self[0].init.method).toBe('POST')
      expect(self[0].init.body).toBe(msg.body)
      expect(headersOf(self[0])).toEqual({
        Title: 'Page: API edge dead',
        Priority: '5',
        Tags: 'rotating_light',
        Click: msg.url,
        Actions: `http, Acknowledge, ${msg.ackUrl}, method=POST, clear=true; view, Open wall, ${msg.url}`,
        Authorization: `Bearer ${ENV.NTFY_SELF_TOKEN}`
      })
    })

    it('sends no Actions without an ackUrl, and takes the server from the environment (a trailing slash is fine)', async () => {
      const f = fakeFetch(servers())
      await make(deps({ fetch: f.fn, env: withEnv({ NTFY_SELF_URL: 'https://ntfy-self.example///' }) })).send({ ...pageMsg, ackUrl: undefined })
      const headers = headersOf(callTo(f, SELF_URL)[0])
      expect(headers).not.toHaveProperty('Actions')
      expect(headers.Authorization).toBe(`Bearer ${ENV.NTFY_SELF_TOKEN}`)
    })

    it('maps kind and severity to priority and tags', async () => {
      const f = fakeFetch(servers())
      const channel = make(deps({ fetch: f.fn }))
      const cases: Array<[Partial<Message>, string, string]> = [
        [{ kind: 'alert', severity: 'warning' }, '3', 'warning'],
        [{ kind: 'alert', severity: 'info' }, '2', 'information_source'],
        [{ kind: 'escalation', severity: 'warning' }, '5', 'warning,arrow_up'],
        [{ kind: 'digest', severity: 'warning' }, '2', 'clipboard'],
        [{ kind: 'resolved', severity: 'page' }, '2', 'white_check_mark'],
        [{ kind: 'test', severity: 'info' }, '3', 'test_tube'],
        [{ kind: 'flapping', severity: 'page' }, '3', 'repeat']
      ]
      for (const [over] of cases) await channel.send({ ...pageMsg, ...over })
      const self = callTo(f, SELF_URL)
      cases.forEach(([, priority, tags], i) => {
        const h = headersOf(self[i])
        expect([h.Priority, h.Tags]).toEqual([priority, tags])
      })
    })

    it('keeps header values latin-1 safe', async () => {
      const f = fakeFetch(servers())
      await make(deps({ fetch: f.fn })).send({ ...pageMsg, title: 'Warning: Café ‘down’ 日本\r\nX-Evil: 1' })
      const headers = headersOf(callTo(f, SELF_URL)[0])
      expect(headers.Title).toBe("Warning: Cafe 'down' X-Evil: 1")
      expect(/^[\x20-\x7e]*$/.test(Object.values(headers).join(''))).toBe(true)
    })

    it('cuts the body to 4096 bytes on a character boundary', async () => {
      const f = fakeFetch(servers())
      await make(deps({ fetch: f.fn })).send({ ...pageMsg, body: 'é'.repeat(3000) })
      const sent = callTo(f, SELF_URL)[0].init.body as string
      expect(Buffer.byteLength(sent)).toBeLessThanOrEqual(4096)
      expect(sent.endsWith('...')).toBe(true)
      expect(sent).not.toContain('�')
    })
  })

  describe('which target counts as delivered (NTFY_PRIMARY)', () => {
    const run = async (status: { public?: number; self?: number }, over: Record<string, string | undefined>) => {
      const f = fakeFetch(servers(status))
      const lines: string[] = []
      const result = await make(deps({ fetch: f.fn, env: withEnv(over), log: (l) => lines.push(l) })).send(pageMsg)
      return { f, lines, result }
    }
    const NO_LEAK = ['canary', ENV.TOPIC, ENV.NTFY_SELF_TOKEN, ENV.NTFY_SELF_TOPIC, 'ntfy-self.example']
    const noLeak = (lines: string[]) => {
      for (const value of NO_LEAK) expect(lines.join('\n')).not.toContain(value)
    }

    it('public (the default, also when NTFY_PRIMARY is empty): both servers are published to, the result is the ntfy.sh one', async () => {
      for (const primary of [undefined, '', 'public', ' PUBLIC ']) {
        const { f, result } = await run({}, { NTFY_PRIMARY: primary })
        expect(f.calls.map((c) => c.url).sort()).toEqual([PUBLIC_URL, SELF_URL].sort())
        expect(result).toMatchObject({ ok: true, status: '200' })
      }
    })

    it('public: the self-hosted server failing is logged and never fails the ntfy step', async () => {
      const { f, lines, result } = await run({ self: 503 }, { NTFY_PRIMARY: 'public' })
      expect(result).toMatchObject({ ok: true, status: '200' })
      expect(callTo(f, PUBLIC_URL)).toHaveLength(1)
      expect(lines.some((l) => l.includes('self') && l.includes('503'))).toBe(true)
      noLeak(lines)
    })

    it('public: ntfy.sh failing fails the step with its status, and the self-hosted alert is still published', async () => {
      const { f, lines, result } = await run({ public: 502 }, { NTFY_PRIMARY: 'public' })
      expect(result).toMatchObject({ ok: false, status: '502' })
      expect(callTo(f, SELF_URL)).toHaveLength(1)
      expect(lines).toEqual([])
    })

    it('self: only the self-hosted server decides, and ntfy.sh failing is logged, not escalated', async () => {
      const { f, lines, result } = await run({ public: 500 }, { NTFY_PRIMARY: 'self' })
      expect(result).toMatchObject({ ok: true, status: '200' })
      expect(callTo(f, PUBLIC_URL)).toHaveLength(1)
      expect(lines.some((l) => l.includes('public') && l.includes('500'))).toBe(true)
      noLeak(lines)
    })

    it('self: the self-hosted server failing fails the step, and the content-free notice is still published', async () => {
      for (const status of [401, 403, 500]) {
        const { f, result } = await run({ self: status }, { NTFY_PRIMARY: 'self' })
        expect(result).toMatchObject({ ok: false, status: String(status) })
        expect(callTo(f, PUBLIC_URL)).toHaveLength(1)
        expect(headersOf(callTo(f, PUBLIC_URL)[0]).Title).toBe('EZO Watcher: page')
      }
    })

    it('self with the self-host variables missing: the step fails as a missing credential, ntfy.sh still gets its notice', async () => {
      const { f, result } = await run({}, { NTFY_PRIMARY: 'self', NTFY_SELF_TOKEN: undefined })
      expect(result).toMatchObject({ ok: false, status: 'error', detail: 'missing credential' })
      expect(JSON.stringify(result)).not.toContain('NTFY_SELF')
      expect(f.calls.map((c) => c.url)).toEqual([PUBLIC_URL])
    })

    it('public with the self-host variables missing (any one of them): the ntfy.sh notice goes out and the step succeeds', async () => {
      for (const name of ['NTFY_SELF_URL', 'NTFY_SELF_TOPIC', 'NTFY_SELF_TOKEN']) {
        const { f, result } = await run({}, { [name]: undefined })
        expect(result).toMatchObject({ ok: true, status: '200' })
        expect(f.calls.map((c) => c.url)).toEqual([PUBLIC_URL])
      }
    })

    it('a channel with no self-hosted target configured at all still publishes only the notice', async () => {
      const f = fakeFetch(servers())
      const bare: ChannelConfig = { id: 'p', type: 'ntfy', server: 'https://ntfy.example', topicEnv: 'TOPIC' }
      const result = await createChannel(bare, deps({ fetch: f.fn })).send(pageMsg)
      expect(result).toMatchObject({ ok: true, status: '200' })
      expect(f.calls.map((c) => [c.url, c.init.body])).toEqual([[PUBLIC_URL, 'Open Watch for details']])
    })

    it('an unknown NTFY_PRIMARY counts as public and says so once per send, without the value', async () => {
      const { result, lines } = await run({ self: 500 }, { NTFY_PRIMARY: 'sefl-hosted' })
      expect(result).toMatchObject({ ok: true })
      expect(lines.some((l) => l.includes('NTFY_PRIMARY'))).toBe(true)
      expect(lines.join('\n')).not.toContain('sefl-hosted')
    })

    it('a target that throws or hangs does not stop the other', async () => {
      const throwsOnSelf = fakeFetch((call) => {
        if (call.url.startsWith('https://ntfy-self.')) throw new TypeError(`connect ECONNREFUSED ${ENV.NTFY_SELF_TOKEN}`)
        return new Response('{}', { status: 200 })
      })
      const a = await make(deps({ fetch: throwsOnSelf.fn })).send(pageMsg)
      expect(a).toMatchObject({ ok: true, status: '200' })
      expect(throwsOnSelf.calls).toHaveLength(2)

      const hangsOnPublic = fakeFetch((call) => (call.url.startsWith('https://ntfy.example') ? hang(call, 0) : new Response('{}', { status: 200 })))
      const b = await make(deps({ fetch: hangsOnPublic.fn, timeoutMs: 20, env: withEnv({ NTFY_PRIMARY: 'self' }) })).send(pageMsg)
      expect(b).toMatchObject({ ok: true, status: '200' })
      const c = await make(deps({ fetch: hangsOnPublic.fn, timeoutMs: 20 })).send(pageMsg)
      expect(c).toMatchObject({ ok: false, status: 'timeout' })
      expect(hangsOnPublic.calls.filter((x) => x.url === SELF_URL)).toHaveLength(2)
    })
  })

  it('reports failures without leaking a secret', async () => {
    await sweepFailures(make, 'TOPIC')
    await sweepFailures((d) => make({ ...d, env: { ...d.env, NTFY_PRIMARY: 'self' } }), 'NTFY_SELF_TOKEN')
    const denied = await make(deps({ fetch: fakeFetch(() => new Response('', { status: 401 })).fn })).send(msg)
    expect(denied).toMatchObject({ ok: false, status: '401' })
  })
})

describe('sms', () => {
  const telnyx: ChannelConfig = {
    id: 'sms',
    type: 'sms',
    provider: 'telnyx',
    apiKeyEnv: 'SMS_KEY',
    fromEnv: 'SMS_FROM',
    toEnv: 'SMS_TO'
  }
  const quo: ChannelConfig = { ...telnyx, provider: 'quo' }
  const expectedText = `Page: API edge dead. edge, 2 instances firing since 14:05 UTC, 12m old. ${msg.url}`

  it('telnyx: one bearer-authorised JSON post per recipient', async () => {
    const f = fakeFetch(() => new Response('{}', { status: 200 }))
    const result = await createChannel(telnyx, deps({ fetch: f.fn })).send(msg)
    expect(result).toMatchObject({ ok: true, status: '2 of 2 accepted' })
    expect(f.calls.map((c) => c.url)).toEqual(Array(2).fill('https://api.telnyx.com/v2/messages'))
    expect(f.calls[0].init.method).toBe('POST')
    expect(f.calls[0].init.headers).toEqual({ Authorization: `Bearer ${ENV.SMS_KEY}`, 'Content-Type': 'application/json' })
    const bodies = f.calls.map((c) => JSON.parse(c.init.body as string))
    expect(bodies).toEqual([
      { from: ENV.SMS_FROM, to: '+15550001111', text: expectedText, type: 'SMS' },
      { from: ENV.SMS_FROM, to: '+15550002222', text: expectedText, type: 'SMS' }
    ])
    expectNoSecrets(result)
  })

  it('quo: raw key without Bearer, content/from/to[] body, 202 is success', async () => {
    const f = fakeFetch(() => new Response('{}', { status: 202 }))
    const env = { ...ENV, SMS_FROM: 'PNabc123', SMS_TO: '+15550001111' }
    const result = await createChannel(quo, deps({ fetch: f.fn, env })).send(msg)
    expect(result).toMatchObject({ ok: true, status: '202' })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].url).toBe('https://api.quo.com/v1/messages')
    expect(f.calls[0].init.headers).toEqual({ Authorization: ENV.SMS_KEY, 'Content-Type': 'application/json' })
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual({ content: expectedText, from: 'PNabc123', to: ['+15550001111'] })
  })

  it('honours a base URL override and is not ok when any recipient is refused', async () => {
    const f = fakeFetch((_, n) => new Response('{}', { status: n === 1 ? 200 : 400 }))
    const result = await createChannel({ ...telnyx, baseUrl: 'http://127.0.0.1:9' }, deps({ fetch: f.fn })).send(msg)
    expect(f.calls[0].url).toBe('http://127.0.0.1:9/v2/messages')
    expect(result).toMatchObject({ ok: false, status: '1 of 2 accepted' })
    expectNoSecrets(result)
  })

  it('reports an empty recipient list', async () => {
    const f = fakeFetch()
    const result = await createChannel(telnyx, deps({ fetch: f.fn, env: { ...ENV, SMS_TO: ' , ' } })).send(msg)
    expect(result).toMatchObject({ ok: false, status: 'no recipients' })
    expect(f.calls).toHaveLength(0)
  })

  it('keeps the text plain ASCII, within 320 characters, and the link whole', () => {
    const long: Message = {
      ...msg,
      title: `Page: \u{1F6A8} Café outage ${'x'.repeat(400)}`,
      body: `svc, 9 instances firing since 01:00 UTC, 3h old.\n${'y'.repeat(300)}`
    }
    const text = smsText(long)
    expect(text.length).toBeLessThanOrEqual(320)
    expect(text.endsWith(long.url)).toBe(true)
    expect(/^[\x20-\x7e]*$/.test(text)).toBe(true)
    expect(text).toContain('...')
  })

  it('reports failures without leaking a secret', async () => {
    await sweepFailures((d) => createChannel(telnyx, d), 'SMS_KEY', '0 of 2 accepted')
    await sweepFailures((d) => createChannel(quo, d), 'SMS_TO', '0 of 2 accepted')
  })
})

describe('email', () => {
  const cfg: ChannelConfig = {
    id: 'mail',
    type: 'email',
    provider: 'resend',
    apiKeyEnv: 'MAIL_KEY',
    from: 'EZO Watcher <watch@ezo.example>',
    toEnv: 'MAIL_TO'
  }
  const make = (d: ChannelDeps) => createChannel(cfg, d)

  it('posts to resend with a bearer key and a per-minute idempotency key', async () => {
    const f = fakeFetch(() => new Response('{"id":"em_1"}', { status: 200 }))
    const now = Date.UTC(2026, 9, 14, 12, 0, 30)
    const result = await make(deps({ fetch: f.fn, now: () => now })).send(msg)
    expect(result).toMatchObject({ ok: true, status: '200' })
    expect(f.calls[0].url).toBe('https://api.resend.com/emails')
    expect(f.calls[0].init.method).toBe('POST')
    expect(f.calls[0].init.headers).toEqual({
      Authorization: `Bearer ${ENV.MAIL_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `edge|EdgeDead-alert-${Math.floor(now / 60000)}`
    })
    const body = JSON.parse(f.calls[0].init.body as string)
    expect(Object.keys(body).sort()).toEqual(['from', 'html', 'subject', 'text', 'to'])
    expect(body.from).toBe('EZO Watcher <watch@ezo.example>')
    expect(body.to).toEqual(['oncall@canary-domain.example', 'boss@canary-domain.example'])
    expect(body.subject).toBe(msg.title)
    expect(body.subject).toBe(emailSubject(msg))
    expect(body.text).toBe(emailText(msg))
    expect(body.text).toContain(`Open in EZO Watcher: ${msg.url}`)
    expect(body.text).toContain('Runbook: https://wiki.example/edge')
    expect(body.html).toBe(emailHtml(msg))
    expectNoSecrets(result)
  })

  it('changes the idempotency key each minute and per kind, and encodes odd tags without collisions', async () => {
    const f = fakeFetch()
    let now = Date.UTC(2026, 9, 14, 12, 0, 0)
    const channel = make(deps({ fetch: f.fn, now: () => now }))
    await channel.send(msg)
    await channel.send(msg)
    now += 60_000
    await channel.send(msg)
    await channel.send({ ...msg, kind: 'escalation' })
    await channel.send({ ...msg, tag: 'café|50%\r\nX: y' })
    await channel.send({ ...msg, tag: 'caf%E9|50%25%DX: y' })
    const keys = f.calls.map((c) => (c.init.headers as Record<string, string>)['Idempotency-Key'])
    const minute = Math.floor(now / 60000)
    expect(keys[0]).toBe(keys[1])
    expect(new Set(keys).size).toBe(5)
    expect(keys[2]).toBe(`edge|EdgeDead-alert-${minute}`)
    expect(keys[3]).toBe(`edge|EdgeDead-escalation-${minute}`)
    expect(keys[4]).toBe(`caf%C3%A9|50%25%0D%0AX: y-alert-${minute}`)
    expect(keys[5]).toBe(`caf%25E9|50%2525%25DX: y-alert-${minute}`)
    expect(keys.every((k) => /^[\x20-\x7e]*$/.test(k))).toBe(true)
  })

  it('escapes every interpolated value in the html and loads nothing external', () => {
    const html = emailHtml({
      ...msg,
      title: 'Page: <script>alert(1)</script> & "x"',
      body: "a < b\n<img src=x onerror=1>\n'q'",
      url: 'javascript:alert(1)'
    })
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;')
    expect(html).toContain('&#39;q&#39;')
    expect(html).not.toContain('javascript:')
    expect(html).not.toMatch(/src=\S+>|<link|url\(/)
    expect(html).not.toContain('Open in EZO Watcher</a>')
    const ok = emailHtml(msg)
    expect(ok).toContain(`href="${msg.url}"`)
    expect(ok).toContain('>Open in EZO Watcher</a>')
  })

  it('reports failures without leaking a secret', async () => {
    await sweepFailures(make, 'MAIL_KEY')
  })
})

describe('webhook', () => {
  const cfg: ChannelConfig = { id: 'hook', type: 'webhook', urlEnv: 'HOOK_URL', headers: { 'X-Token': HOOK_HEADER } }
  const make = (d: ChannelDeps) => createChannel(cfg, d)

  it('posts the message as JSON with the configured headers', async () => {
    const f = fakeFetch()
    const result = await make(deps({ fetch: f.fn })).send(msg)
    expect(result).toMatchObject({ ok: true, status: '200' })
    expect(f.calls[0].url).toBe(ENV.HOOK_URL)
    expect(f.calls[0].init.method).toBe('POST')
    expect(f.calls[0].init.headers).toEqual({ 'Content-Type': 'application/json', 'X-Token': HOOK_HEADER })
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual({
      kind: 'alert',
      title: msg.title,
      body: msg.body,
      severity: 'page',
      tag: msg.tag,
      url: msg.url,
      ackUrl: msg.ackUrl,
      links: msg.links
    })
    expectNoSecrets(result)
  })

  it('reports failures without leaking a secret', async () => {
    await sweepFailures(make, 'HOOK_URL')
  })
})

describe('file', () => {
  const temp = () => mkdtempSync(join(tmpdir(), 'watcher-file-channel-'))
  const make = (path: string | undefined, cwd: string) => createChannel({ id: 'local', type: 'file', ...(path ? { path } : {}) }, deps({ fetch: fakeFetch().fn, cwd }))

  it('appends one JSON line per notification under the project, with no credential and no network', async () => {
    const dir = temp()
    try {
      const result = await make(join('alerts', 'out.jsonl'), dir).send(msg)
      expect(result).toMatchObject({ ok: true, status: 'appended' })
      const lines = readFileSync(join(dir, 'alerts', 'out.jsonl'), 'utf8').trim().split('\n')
      expect(lines).toHaveLength(1)
      const row = JSON.parse(lines[0]) as Record<string, unknown>
      expect(row).toMatchObject({ kind: 'alert', title: msg.title, severity: 'page', tag: msg.tag, url: msg.url, ackUrl: msg.ackUrl })
      expect(JSON.stringify(row)).not.toContain('canary')
      // Two notifications are two lines, each a complete record.
      await make(join('alerts', 'out.jsonl'), dir).send({ ...msg, kind: 'test', title: 'Test' })
      expect(readFileSync(join(dir, 'alerts', 'out.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes .watcher/data/alerts.jsonl by default', async () => {
    const dir = temp()
    try {
      expect(await make(undefined, dir).send(msg)).toMatchObject({ ok: true })
      expect(readFileSync(join(dir, '.watcher', 'data', 'alerts.jsonl'), 'utf8')).toContain('"kind":"alert"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a failure without carrying the path', async () => {
    const dir = temp()
    try {
      writeFileSync(join(dir, 'blocked'), 'not a directory')
      const result = await make(join('blocked', 'out.jsonl'), dir).send(msg)
      expect(result.ok).toBe(false)
      expect(result.status).toBe('error')
      expect(JSON.stringify(result)).not.toContain(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('createChannel', () => {
  it('builds each type with its id and type', () => {
    const f = fakeFetch()
    const configs: ChannelConfig[] = [
      { id: 'a', type: 'ntfy', server: 'https://n', topicEnv: 'T' },
      { id: 'b', type: 'webpush', publicKeyEnv: 'P', privateKeyEnv: 'K', subject: 'mailto:a@b.example' },
      { id: 'c', type: 'sms', provider: 'quo', apiKeyEnv: 'K', fromEnv: 'F', toEnv: 'T' },
      { id: 'd', type: 'email', provider: 'resend', apiKeyEnv: 'K', from: 'a@b.example', toEnv: 'T' },
      { id: 'f', type: 'webhook', urlEnv: 'U' },
      { id: 'g', type: 'file', path: '.watcher/data/alerts.jsonl' }
    ]
    const built = configs.map((c) => createChannel(c, deps({ fetch: f.fn })))
    expect(built.map((c) => [c.id, c.type])).toEqual(configs.map((c) => [c.id, c.type]))
    const bogus = { id: 'x', type: 'pigeon' } as unknown as ChannelConfig
    expect(() => createChannel(bogus, deps({ fetch: f.fn }))).toThrow('pigeon')
  })
})
