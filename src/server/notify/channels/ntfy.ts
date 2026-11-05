// ntfy: POST <server>/<topic>, the body is the message text and the rest rides in headers
// (docs.ntfy.sh/publish, retrieved 2026-10-14). Header values must be latin-1, so Title and Tags are folded to ASCII.
//
// Two targets, because the operator of a public server can read everything published to it:
//   public  ntfy.sh (config `server` + `topicEnv`). Gets a CONTENT-FREE notice: a fixed title ("EZO Watcher: page", the brand's name), a fixed
//           message ("Open Watch for details"), an opaque click link, the same priority and tags as always. No service,
//           host, rule, error text, runbook link or Acknowledge action: nothing of the alert leaves the building.
//   self    our own ntfy server (config `self`: NTFY_SELF_URL, NTFY_SELF_TOPIC, NTFY_SELF_TOKEN). Gets the whole alert,
//           with the real click link and the one-tap Acknowledge, authenticated with `Authorization: Bearer <token>`.
// Both are published at the same time and one failing never stops the other. The phone listens to one of them (NTFY_PRIMARY,
// `public` by default): only that target's answer decides whether the ntfy step succeeded, which is what makes web push fire
// on the page ladder when the phone's own target is down. The other target is best effort; its failure is logged as a status
// word, never as a URL, topic or token.
//
// Each target has its own circuit (circuit.ts): a 429 or a timeout from ntfy.sh opens ntfy.sh's circuit and leaves the self-hosted server's
// alone, and while a circuit is open that target is not called at all. The ntfy.sh host rejected this one for hours after a burst of
// 429s that retries kept alive; a target that is left alone is the only way the ban lifts.

import { secret } from '../../config.ts'
import type { NtfyChannelConfig } from '../../config.ts'
import { skippedResult, tripsCircuit, wasSkipped } from '../circuit.ts'
import type { Channel, Message, SendResult } from '../types.ts'
import { asciiLine, brandName, cut, drain, guarded, httpOutcome, retryAfter, truncateBytes } from './common.ts'
import type { ChannelDeps } from './common.ts'

const MAX_BODY_BYTES = 4096
/** The only message text ntfy.sh ever gets. */
const NOTICE_BODY = 'Open Watch for details'

type Target = 'public' | 'self'

interface Publish {
  url: string
  headers: Record<string, string>
  body: string
}

function priority(msg: Message): number {
  if (msg.kind === 'escalation') return 5
  if (msg.kind === 'digest' || msg.kind === 'resolved') return 2
  if (msg.kind === 'test') return 3
  const bySeverity = msg.severity === 'page' ? 5 : msg.severity === 'warning' ? 3 : 2
  return msg.kind === 'flapping' ? Math.min(bySeverity, 3) : bySeverity
}

function tags(msg: Message): string {
  if (msg.kind === 'resolved') return 'white_check_mark'
  if (msg.kind === 'digest') return 'clipboard'
  if (msg.kind === 'flapping') return 'repeat'
  if (msg.kind === 'test') return 'test_tube'
  const base = msg.severity === 'page' ? 'rotating_light' : msg.severity === 'warning' ? 'warning' : 'information_source'
  return msg.kind === 'escalation' ? `${base},arrow_up` : base
}

/** The full alert, for the server we run. */
function fullHeaders(msg: Message, token: string): Record<string, string> {
  const h: Record<string, string> = {
    Title: cut(asciiLine(msg.title), 200),
    Priority: String(priority(msg)),
    Tags: tags(msg),
    Click: asciiLine(msg.url)
  }
  if (msg.ackUrl) {
    h.Actions = `http, Acknowledge, ${asciiLine(msg.ackUrl)}, method=POST, clear=true; view, Open wall, ${asciiLine(msg.url)}`
  }
  h.Authorization = `Bearer ${token}`
  return h
}

/** What kind of notice this is, in words that say nothing about the alert: which Watch, and its severity or its kind. */
function noticeTitle(msg: Message, brand: string): string {
  const name = cut(asciiLine(brand), 60)
  if (msg.kind === 'resolved' || msg.kind === 'digest' || msg.kind === 'test') return `${name}: ${msg.kind}`
  return `${name}: ${msg.severity}`
}

/** The site root of a URL: where a notice with no incident of its own clicks through to. */
function rootOf(url: string): string {
  try {
    return `${new URL(url).origin}/`
  } catch {
    return ''
  }
}

/** Nothing of the alert: not its title, text, key, links or ack signature. The click link is the opaque /go/<token>. */
function noticeHeaders(msg: Message, token: string | undefined, brand: string): Record<string, string> {
  const h: Record<string, string> = { Title: noticeTitle(msg, brand), Priority: String(priority(msg)), Tags: tags(msg) }
  const click = asciiLine(msg.noticeUrl ?? rootOf(msg.url))
  if (click) h.Click = click
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

function target(base: string, topic: string): string {
  return `${base.trim().replace(/\/+$/, '')}/${encodeURIComponent(topic.trim())}`
}

/** The self-hosted server's three variables, all present and non-blank, or null. */
function selfSettings(cfg: NtfyChannelConfig, env: NodeJS.ProcessEnv): { url: string; topic: string; token: string } | null {
  if (!cfg.self) return null
  const url = env[cfg.self.urlEnv]?.trim()
  const topic = env[cfg.self.topicEnv]?.trim()
  const token = env[cfg.self.tokenEnv]?.trim()
  return url && topic && token ? { url, topic, token } : null
}

/** Which target the phone listens to. Anything but `self` is `public`; a value that is neither is said so in the log. */
function primaryOf(cfg: NtfyChannelConfig, deps: ChannelDeps): Target {
  if (!cfg.primaryEnv || !cfg.self) return 'public'
  const raw = (deps.env[cfg.primaryEnv] ?? '').trim().toLowerCase()
  if (raw === '' || raw === 'public') return 'public'
  if (raw === 'self') return 'self'
  deps.log?.(`ntfy: ${cfg.primaryEnv} must be public or self, using public`)
  return 'public'
}

export function createNtfyChannel(cfg: NtfyChannelConfig, deps: ChannelDeps): Channel {
  if (cfg.self && !selfSettings(cfg, deps.env)) {
    deps.log?.(
      `ntfy: self-hosted target not configured (${cfg.self.urlEnv}, ${cfg.self.topicEnv}, ${cfg.self.tokenEnv}); ` +
        'pages reach ntfy.sh as a notice with no alert text and nothing else'
    )
  }

  /** The request for one target. Throws the missing-credential error a channel turns into `missing credential`. */
  function request(which: Target, msg: Message): Publish {
    if (which === 'public') {
      const topic = secret(deps.env, cfg.topicEnv)
      const token = cfg.tokenEnv ? secret(deps.env, cfg.tokenEnv) : undefined
      return { url: target(cfg.server, topic), headers: noticeHeaders(msg, token, brandName(deps)), body: NOTICE_BODY }
    }
    const self = cfg.self
    if (!self) throw new Error('missing environment variable (no self-hosted target configured)')
    const url = secret(deps.env, self.urlEnv)
    const topic = secret(deps.env, self.topicEnv)
    const token = secret(deps.env, self.tokenEnv)
    return { url: target(url, topic), headers: fullHeaders(msg, token.trim()), body: truncateBytes(msg.body, MAX_BODY_BYTES) }
  }

  /** The call was cut short by the notifier's own cap on an attempt: from here it is a timeout like the channel's own. */
  const timedOut = (r: SendResult): boolean => tripsCircuit(r) || (!r.ok && r.status === 'error' && r.detail === 'AbortError')

  async function publish(which: Target, msg: Message, signal: AbortSignal | undefined): Promise<SendResult> {
    // A test is a person asking whether the target answers now: it goes out whatever the circuit says, and can still open it.
    const key = `${cfg.id}:${which}`
    const circuits = deps.circuits
    const until = msg.kind === 'test' ? null : (circuits?.openUntil(key) ?? null)
    if (until !== null) return skippedResult(until)
    const result = await guarded(deps, signal, async (sig) => {
      const req = request(which, msg)
      const res = await deps.fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: sig })
      await drain(res)
      const wait = res.status === 429 ? retryAfter(res, deps.now()) : undefined
      return { ...httpOutcome(res), ...(wait !== undefined ? { retryAfterMs: wait } : {}) }
    })
    if (circuits && timedOut(result)) {
      const wasOpen = circuits.openUntil(key) !== null
      const openUntil = circuits.trip(key, result.retryAfterMs)
      if (!wasOpen) deps.log?.(`ntfy: ${which} target answered ${result.status === 'error' ? 'timeout' : result.status}, circuit open until ${new Date(openUntil).toISOString().slice(11, 19)} UTC`)
      return { ...result, circuitUntil: openUntil }
    }
    return result
  }

  return {
    id: cfg.id,
    type: 'ntfy',
    async send(msg, signal) {
      const primary = primaryOf(cfg, deps)
      const other: Target = primary === 'public' ? 'self' : 'public'
      // The self-hosted server is skipped while it is not configured, unless the phone depends on it: then the missing
      // credential is the answer, and web push takes over.
      const publishSelf = cfg.self !== undefined && (primary === 'self' || selfSettings(cfg, deps.env) !== null)
      const [pub, self] = await Promise.all([publish('public', msg, signal), publishSelf ? publish('self', msg, signal) : Promise.resolve(null)])
      const results: Record<Target, SendResult | null> = { public: pub, self }
      const secondary = results[other]
      if (secondary && !secondary.ok && !wasSkipped(secondary)) {
        deps.log?.(`ntfy: ${other} target did not take the notice (${secondary.status}${secondary.detail ? `, ${secondary.detail}` : ''})`)
      }
      return results[primary] ?? pub
    }
  }
}
