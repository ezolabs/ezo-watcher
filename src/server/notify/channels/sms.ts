// SMS through Telnyx or Quo (formerly OpenPhone). One request per recipient; the result is ok only when every
// recipient was accepted. Numbers come from the environment and never appear in a result.
//  - Telnyx: POST /v2/messages, `Authorization: Bearer <key>`, JSON { from, to, text, type }.
//  - Quo: POST /v1/messages on api.quo.com (not api.openphone.com), `Authorization: <key>` with NO Bearer
//    prefix, JSON { content, from, to: [number] }, 202 on success.

import { secret } from '../../config.ts'
import type { SmsChannelConfig } from '../../config.ts'
import type { Channel, Message } from '../types.ts'
import { asciiLine, cut, drain, guarded, splitList } from './common.ts'
import type { ChannelDeps, Outcome } from './common.ts'

const MAX_CHARS = 320

/** "<title>. <first body line> <url>" in plain ASCII, the link always kept whole. */
export function smsText(msg: Message): string {
  const title = asciiLine(msg.title).replace(/[.\s]+$/, '')
  const first = asciiLine(msg.body.split('\n')[0] ?? '')
  const url = asciiLine(msg.url)
  const room = MAX_CHARS - url.length - 1
  const head = cut(first ? `${title}. ${first}` : `${title}.`, Math.max(room, 0))
  return cut(`${head} ${url}`, MAX_CHARS)
}

function request(cfg: SmsChannelConfig, key: string, from: string, to: string, text: string): [string, RequestInit] {
  if (cfg.provider === 'telnyx') {
    return [
      `${cfg.baseUrl ?? 'https://api.telnyx.com'}/v2/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, text, type: 'SMS' })
      }
    ]
  }
  return [
    `${cfg.baseUrl ?? 'https://api.quo.com'}/v1/messages`,
    {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, from, to: [to] })
    }
  ]
}

async function sendAll(cfg: SmsChannelConfig, msg: Message, deps: ChannelDeps, signal: AbortSignal): Promise<Outcome> {
  const key = secret(deps.env, cfg.apiKeyEnv)
  const from = secret(deps.env, cfg.fromEnv)
  const recipients = splitList(secret(deps.env, cfg.toEnv))
  if (recipients.length === 0) return { ok: false, status: 'no recipients' }
  const text = smsText(msg)
  const results = await Promise.all(
    recipients.map(async (to) => {
      const [url, init] = request(cfg, key, from, to, text)
      const res = await deps.fetch(url, { ...init, signal })
      await drain(res)
      return res
    })
  )
  const accepted = results.filter((r) => r.ok).length
  const ok = accepted === results.length
  const status = results.length === 1 ? String(results[0].status) : `${accepted} of ${results.length} accepted`
  return { ok, status }
}

export function createSmsChannel(cfg: SmsChannelConfig, deps: ChannelDeps): Channel {
  return {
    id: cfg.id,
    type: 'sms',
    send: (msg, signal) => guarded(deps, signal, (sig) => sendAll(cfg, msg, deps, sig))
  }
}
