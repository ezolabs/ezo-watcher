// Generic webhook: POST the message as JSON to the URL held in the environment, with the configured static
// headers (which may carry a token, so they are never echoed).

import { secret } from '../../config.ts'
import type { WebhookChannelConfig } from '../../config.ts'
import type { Channel } from '../types.ts'
import { drain, guarded, httpOutcome } from './common.ts'
import type { ChannelDeps } from './common.ts'

export function createWebhookChannel(cfg: WebhookChannelConfig, deps: ChannelDeps): Channel {
  return {
    id: cfg.id,
    type: 'webhook',
    send: (msg, signal) =>
      guarded(deps, signal, async (sig) => {
        const url = secret(deps.env, cfg.urlEnv)
        const { kind, title, body, severity, tag, url: wall, ackUrl, links } = msg
        const res = await deps.fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...cfg.headers },
          body: JSON.stringify({ kind, title, body, severity, tag, url: wall, ackUrl, links }),
          signal: sig
        })
        await drain(res)
        return httpOutcome(res)
      })
  }
}
