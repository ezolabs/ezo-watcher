// Turns a planned send into the Message a channel renders. Plain text, no emoji, at most six body lines.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { worstFirst } from '../../shared/evidence-links.ts'
import { DEFAULT_BRAND } from '../../shared/instance.ts'
import type { Severity } from '../../shared/types.ts'
import { NAME_MAX, shownName } from '../../shared/who.ts'
import type { Subject } from './plan.ts'
import type { InstanceView, Message } from './types.ts'

export interface MessageContext {
  baseUrl: string
  ackSecret: string
  nowMs: number
}

const MAX_BODY_LINES = 6
const MAX_DIGEST_LINES = 8
const WORD: Record<Severity, string> = { page: 'Page', warning: 'Warning', info: 'Info' }

function base(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

export function wallUrl(baseUrl: string, key: string): string {
  return `${base(baseUrl)}/#/i/${encodeURIComponent(key)}`
}

export function ackSignature(secret: string, key: string): string {
  return createHmac('sha256', secret).update(key).digest('hex')
}

export function verifyAckSignature(secret: string, key: string, signature: string): boolean {
  const expected = Buffer.from(ackSignature(secret, key))
  const given = Buffer.from(signature)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/** A fixed-length token for an incident key. Domain-separated from the ack signature, so one can never stand in for the other. */
export function noticeToken(secret: string, key: string): string {
  return createHmac('sha256', secret).update(`notice:${key}`).digest('hex').slice(0, 32)
}

/** The link a notice on a server we do not run clicks through to. It names nothing: /go/<token> resolves on this server only. */
export function noticeUrl(baseUrl: string, secret: string, key: string): string {
  return `${base(baseUrl)}/go/${noticeToken(secret, key)}`
}

/** The incident key a token was made from, found among `keys`, or null. */
export function findNoticeKey(secret: string, token: string, keys: Iterable<string>): string | null {
  if (!/^[0-9a-f]{32}$/.test(token)) return null
  const given = Buffer.from(token)
  for (const key of keys) {
    if (timingSafeEqual(Buffer.from(noticeToken(secret, key)), given)) return key
  }
  return null
}

export function ackUrl(baseUrl: string, secret: string, key: string): string {
  return `${base(baseUrl)}/api/ack?k=${encodeURIComponent(key)}&s=${ackSignature(secret, key)}`
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length <= max ? flat : `${chars.slice(0, max - 3).join('')}...`
}

function clock(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`
}

export function ageText(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  if (s < 60) return 'under 1m'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function validMs(iso: string, fallback: number): number {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? fallback : ms
}

type FiringView = Extract<Subject, { type: 'firing' }>['view']

function firingBody(view: FiringView, nowMs: number, lead: string[]): string {
  const startedMs = validMs(view.startsAt, nowMs)
  const n = view.instances.length
  const header = `${view.service}, ${count(n, 'instance')} firing since ${clock(startedMs)}, ${ageText((nowMs - startedMs) / 1000)} old.`
  const head = [...lead, header]
  const room = MAX_BODY_LINES - head.length
  const lines = view.instances.map((i) => {
    const name = oneLine(i.name, 60)
    return i.value ? `${name}: ${oneLine(i.value, 80)}` : name
  })
  const shown = lines.length <= room ? lines : lines.slice(0, room - 1)
  const more = lines.length - shown.length
  return [...head, ...shown, ...(more > 0 ? [`+${more} more`] : [])].join('\n')
}

/** Worst first: severity, then the most urgent value (the shortest ETA), then the oldest. Stable and pure. */
export function rankedInstances(view: FiringView): InstanceView[] {
  return worstFirst(view.instances, (i) => ({
    severity: i.severity ?? view.severity,
    startsAt: i.startsAt,
    summary: i.summary,
    value: i.value,
    name: i.name
  }))
}

function firingMessage(subject: Extract<Subject, { type: 'firing' }>, ctx: MessageContext): Message {
  const { view, kind } = subject
  const ranked = rankedInstances(view)
  // The headline names the WORST instance, not whichever the source listed first.
  const label = oneLine(ranked[0]?.summary || view.summary, 120) || oneLine(view.rule, 120)
  const word = WORD[view.severity]
  const title =
    kind === 'escalation' ? `Escalated ${word.toLowerCase()}: ${label}` : kind === 'flapping' ? `Flapping: ${label}` : `${word}: ${label}`
  let body: string
  if (kind === 'escalation') {
    body = firingBody(view, ctx.nowMs, [`Unattended for ${ageText(view.unattendedSec)}.`])
  } else if (kind === 'flapping') {
    const lines = firingBody(view, ctx.nowMs, []).split('\n').slice(0, 1)
    body = [...lines, 'It keeps firing and clearing. Alert messages for it are paused until it settles.'].join('\n')
  } else {
    body = firingBody(view, ctx.nowMs, [])
  }
  return {
    kind,
    title,
    body,
    severity: view.severity,
    tag: view.key,
    url: wallUrl(ctx.baseUrl, view.key),
    service: view.service,
    rule: view.rule,
    noticeUrl: noticeUrl(ctx.baseUrl, ctx.ackSecret, view.key),
    ackUrl: ackUrl(ctx.baseUrl, ctx.ackSecret, view.key),
    links: view.links,
    incident: { service: view.service, rule: view.rule, startsAt: view.startsAt, unattendedSec: view.unattendedSec, instances: ranked }
  }
}

function resolvedMessage(subject: Extract<Subject, { type: 'resolved' }>, ctx: MessageContext): Message {
  const { view } = subject
  const label = oneLine(view.summary, 120) || oneLine(view.rule, 120)
  const at = clock(validMs(view.resolvedAt, ctx.nowMs))
  // someone had it (an acknowledgement is stored with a name, even an empty one), and the name is said only when it names someone
  const acked = view.ackedBy !== undefined || view.ackedAt !== undefined
  const named = shownName(view.ackedBy)
  return {
    kind: 'resolved',
    title: `Resolved: ${label}`,
    body: `${view.service}, resolved at ${at} after ${ageText(view.durationSec)}.${acked ? ` Acknowledged${named === null ? '' : ` by ${oneLine(named, NAME_MAX)}`}${view.ackedAt ? ` at ${clock(validMs(view.ackedAt, ctx.nowMs))}` : ''}.` : ''}`,
    severity: view.severity,
    tag: view.key,
    url: wallUrl(ctx.baseUrl, view.key),
    service: view.service,
    rule: view.rule,
    noticeUrl: noticeUrl(ctx.baseUrl, ctx.ackSecret, view.key),
    durationSec: view.durationSec,
    // the name only when it names someone: a message that says "acknowledged by this browser" means nothing in a chat thread
    ...(acked ? { ...(named !== null ? { ackedBy: named } : {}), ...(view.ackedAt ? { ackedAt: view.ackedAt } : {}) } : {})
  }
}

function digestMessage(subject: Extract<Subject, { type: 'digest' }>, ctx: MessageContext): Message {
  const { views } = subject
  const rows = views.map((v) => `${oneLine(v.service, 60)}: ${oneLine(v.rule, 80)}, ${count(v.instances.length, 'instance')}`)
  const shown = rows.slice(0, MAX_DIGEST_LINES)
  const more = rows.length - shown.length
  const head = `${count(views.length, 'alert')} held during quiet hours ${views.length === 1 ? 'is' : 'are'} still firing.`
  return {
    kind: 'digest',
    title: 'Digest: held alerts',
    body: [head, ...shown, ...(more > 0 ? [`+${more} more`] : [])].join('\n'),
    severity: 'warning',
    tag: `digest:${subject.routeId}`,
    url: `${base(ctx.baseUrl)}/`
  }
}

/** "10 min" for a window of 600 s; seconds when it is not whole minutes. */
function windowText(sec: number): string {
  return sec % 60 === 0 ? `${sec / 60} min` : `${sec} s`
}

/**
 * The one notice for the pages of an origin that were held back (coalesce.ts): "webhook: 15 more pages in 10 min, see the wall". It names
 * the origin and a count, not an incident, so there is nothing to acknowledge: it links to the wall, and the pages stay on the wall one by one.
 */
function summaryMessage(subject: Extract<Subject, { type: 'summary' }>, ctx: MessageContext): Message {
  const { summary, kind } = subject
  const line = `${oneLine(summary.origin, 60)}: ${summary.count} more ${summary.count === 1 ? 'page' : 'pages'} in ${windowText(summary.windowSec)}, see the wall`
  const rows = summary.sample.map((s) => oneLine(s, 100))
  const more = summary.open - rows.length
  return {
    kind,
    title: kind === 'escalation' ? `Escalated: ${line}` : line,
    body: [
      `${summary.open} of them ${summary.open === 1 ? 'is' : 'are'} still firing with nobody on ${summary.open === 1 ? 'it' : 'them'}${kind === 'escalation' ? `, for ${ageText(summary.unattendedSec)} at the longest` : ''}.`,
      ...rows,
      ...(more > 0 ? [`+${more} more`] : [])
    ].join('\n'),
    severity: 'page',
    tag: summary.id,
    url: `${base(ctx.baseUrl)}/`,
    noticeUrl: `${base(ctx.baseUrl)}/`
  }
}

export function buildMessage(subject: Subject, ctx: MessageContext): Message {
  if (subject.type === 'firing') return firingMessage(subject, ctx)
  if (subject.type === 'resolved') return resolvedMessage(subject, ctx)
  if (subject.type === 'summary') return summaryMessage(subject, ctx)
  return digestMessage(subject, ctx)
}

/** The test every channel's Send test button sends, in the name this Watch goes by (config `brand.name`). */
export function testMessage(baseUrl: string, brand: string = DEFAULT_BRAND.name): Message {
  return {
    kind: 'test',
    title: `${brand} test`,
    body: `This is a test notification from ${brand}.`,
    severity: 'info',
    tag: 'ezo-watcher-test',
    url: `${base(baseUrl)}/`
  }
}
