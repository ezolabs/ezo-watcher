// Email through Resend: POST /emails with a Bearer key and an Idempotency-Key, so a retry inside the same
// minute cannot send twice. The acknowledge link is left out on purpose: mail scanners open every link, and a
// GET that acks would ack by itself.
//
// The message is built around the same evidence-link model the drill-down sheet renders (src/shared/
// evidence-links.ts), so the mail and the wall name the same worst instance and offer the same links.
//   subject  severity, the worst instance's own summary, "and N more hosts"
//   html     a severity band (danger red for a page, warning amber for a warning), the worst instance as the
//            title, one status sentence, a worst-first table with each instance's value, report and evidence,
//            a bulletproof "Open in EZO Watcher" button, then the source and runbook links
//   text     the same content, every URL written out in full
// "EZO Watcher" is the brand (config `brand.name`, ChannelDeps.brand): another Watch's mail names itself in the header, the button and the footer,
// and a `from` written as a bare address is sent under the brand's name.
// Technique: inline styles on tables (600 px, no external CSS, no images), color-scheme and supported-color-schemes
// meta plus a small prefers-color-scheme block so it reads in light and dark clients, well under Gmail's 102 KB clip.

import { secret } from '../../config.ts'
import type { EmailChannelConfig } from '../../config.ts'
import { evidenceLinks, incidentEvidence, statusText, webUrl } from '../../../shared/evidence-links.ts'
import type { EvidenceLink } from '../../../shared/evidence-links.ts'
import type { Severity } from '../../../shared/types.ts'
import type { Channel, InstanceView, Message } from '../types.ts'
import { DEFAULT_BRAND } from '../../../shared/instance.ts'
import { asciiLine, brandName, cut, drain, guarded, httpOutcome, splitList, stripControl } from './common.ts'
import type { ChannelDeps } from './common.ts'

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ENTITIES[c])
}

// ---- tokens, transcribed from src/web/styles/tokens.css (the look plan lives in docs/design.md) ---------------
// Light is the inline default (a client with no dark support shows it); the dark values ride in the
// prefers-color-scheme block below and win with !important.
interface Palette {
  bg: string
  raised: string
  sunken: string
  line: string
  lineStrong: string
  fg: string
  fg2: string
  muted: string
  danger: string
  warn: string
}
const LIGHT: Palette = {
  bg: '#faf8f3', // --color-bg, light
  raised: '#f0ede5', // --color-raised, light
  sunken: '#f2f2f2', // --color-sunken, light
  line: '#e3dfd6', // --color-line, light
  lineStrong: '#8a8780', // --color-line-strong, light
  fg: '#141310', // --color-fg, light
  fg2: '#3d3a33', // --color-fg-secondary, light
  muted: '#5f5b52', // --color-muted, light
  danger: '#a84f4f', // --color-danger, light
  warn: '#806218' // --color-warn, light
}
const DARK: Palette = {
  bg: '#0d0d0d', // --color-bg
  raised: '#1a1a1c', // --color-raised
  sunken: '#0a0a0b', // --color-sunken
  line: '#1e1e21', // --color-line
  lineStrong: '#3a3b40', // --color-line-strong
  fg: '#e6e8ee', // --color-fg
  fg2: '#c9ccd4', // --color-fg-secondary
  muted: '#aeb1bc', // --color-muted
  danger: '#f23f42', // --color-danger
  warn: '#f0b132' // --color-warn
}
const FONT = 'SF Pro Rounded,ui-rounded,Inter,system-ui,sans-serif' // --font-ui
const MONO = 'ui-monospace,SF Mono,SFMono-Regular,Menlo,Consolas,Liberation Mono,monospace' // --font-mono
const WIDTH = 600 // --size-measure
// type ramp: headline 22/28 -0.4, title 15/20, body 13/19, code 12/18 (tokens --text-*)
const R8 = 8 // --radius-8
const R16 = 16 // --radius-16
const PILL = 9999 // --radius-pill, the mark's bar ends

const MAX_ROWS = 10
const MAX_SECONDARY = 4

// ---- the incident, as the email reads it -------------------------------------------------------------------

interface Row {
  name: string
  severity: Severity
  value: string
  links: EvidenceLink[]
}

interface Mail {
  severity: Severity
  /** What the band says: "Page", "Warning", "Resolved". */
  bandWord: string
  /** The band's right side: "3 hosts firing". Empty when there is nothing to count. */
  bandCount: string
  title: string
  status: string
  rows: Row[]
  /** Instances beyond the rows shown. */
  hidden: number
  secondary: EvidenceLink[]
  /** The deep link to the incident, only when it is a real http(s) URL. */
  url: string | undefined
  /** A neutral band: nothing is on fire (resolved, digest, test). */
  neutral: boolean
}

const WORD: Record<Severity, string> = { page: 'Page', warning: 'Warning', info: 'Info' }

function noun(msg: Message, n: number): string {
  const inc = msg.incident
  const hosts = inc !== undefined && inc.instances.length > 0 && inc.instances.every((i) => i.name !== inc.rule)
  const word = hosts ? 'host' : 'instance'
  return n === 1 ? word : `${word}s`
}

function clock(iso: string): string {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? '' : `${new Date(ms).toISOString().slice(11, 16)} UTC`
}

function age(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  if (s < 60) return 'under 1m'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`
}

function oneLine(text: string, max: number): string {
  return cut(stripControl(text).replace(/\s+/g, ' ').trim(), max)
}

function rowOf(inst: InstanceView, fallback: Severity): Row {
  // A name that is only the summary or the alertname says nothing a host would: the first column then holds the
  // severity alone and the second column carries the summary, so no row repeats the title or its own text twice.
  const named = inst.nameSource !== 'summary' && inst.nameSource !== 'rule'
  return {
    name: named ? oneLine(inst.name, 60) : '',
    severity: inst.severity ?? fallback,
    value: oneLine(statusText(named ? inst.name : '', inst.summary, inst.value), 200),
    links: evidenceLinks(inst).filter((l) => l.kind === 'report' || l.kind === 'evidence')
  }
}

/** The message title without its "Page: " style prefix. */
function bareTitle(msg: Message): string {
  return msg.title.replace(/^[^:]*:\s*/, '')
}

/** The headline names the worst instance: `Message.incident.instances` arrives ranked worst first. */
function mailOf(msg: Message): Mail {
  const inc = msg.incident
  const url = webUrl(msg.url)
  if (!inc || inc.instances.length === 0) {
    const links = evidenceLinks({ links: msg.links }).filter((l) => l.kind === 'source' || l.kind === 'runbook')
    const resolved = msg.kind === 'resolved'
    return {
      severity: msg.severity,
      bandWord: msg.kind === 'test' ? 'Test' : msg.kind === 'digest' ? 'Digest' : resolved ? 'Resolved' : WORD[msg.severity],
      bandCount: '',
      title: oneLine(msg.title, 200),
      status: '',
      rows: [],
      hidden: 0,
      secondary: links.slice(0, MAX_SECONDARY),
      url,
      neutral: msg.kind === 'test' || msg.kind === 'digest' || resolved || msg.severity === 'info'
    }
  }
  const instances = inc.instances
  const worst = instances[0]
  const n = instances.length
  let status: string
  if (msg.kind === 'escalation') status = `Nobody has acknowledged this for ${age(inc.unattendedSec)}, so it escalated.`
  else if (msg.kind === 'flapping') status = 'It keeps firing and clearing, so alert messages for it are paused until it settles.'
  else status = `Firing since ${clock(inc.startsAt)}, unattended for ${age(inc.unattendedSec)}.`
  return {
    severity: msg.severity,
    bandWord: WORD[msg.severity],
    bandCount: `${n} ${noun(msg, n)} firing`,
    title: oneLine(worst.summary || bareTitle(msg), 200),
    status,
    rows: instances.slice(0, MAX_ROWS).map((i) => rowOf(i, msg.severity)),
    hidden: Math.max(0, n - MAX_ROWS),
    secondary: incidentEvidence(instances).filter((l) => l.kind === 'source' || l.kind === 'runbook').slice(0, MAX_SECONDARY),
    url,
    neutral: msg.severity === 'info'
  }
}

/** Severity, then the worst instance's own summary, then "and N more hosts". No middle dots, no em dashes. */
export function emailSubject(msg: Message): string {
  const inc = msg.incident
  if (!inc || inc.instances.length === 0 || (msg.kind !== 'alert' && msg.kind !== 'escalation' && msg.kind !== 'flapping')) {
    return cut(asciiLine(msg.title), 200)
  }
  const word = WORD[msg.severity]
  const lead = msg.kind === 'escalation' ? `Escalated ${word.toLowerCase()}` : msg.kind === 'flapping' ? 'Flapping' : word
  const worst = inc.instances[0]
  const summary = oneLine(worst.summary || bareTitle(msg), 120)
  const more = inc.instances.length - 1
  const tail = more > 0 ? `, and ${more} more ${noun(msg, more)}` : ''
  return cut(asciiLine(`${lead}: ${summary}${tail}`), 200)
}

// ---- plain text: the same content, every URL in full ------------------------------------------------------------

export function emailText(msg: Message, brand: string = DEFAULT_BRAND.name): string {
  const m = mailOf(msg)
  const lines: string[] = []
  lines.push(m.bandCount ? `${m.bandWord}, ${m.bandCount}` : m.bandWord)
  lines.push('')
  lines.push(m.title)
  if (m.status) lines.push(m.status)
  if (!msg.incident || msg.incident.instances.length === 0) {
    const body = stripControl(msg.body).trim()
    if (body) lines.push('', body)
  }
  if (m.rows.length > 0) {
    lines.push('', 'Worst first:')
    for (const r of m.rows) {
      lines.push('', r.name ? `${r.name} (${WORD[r.severity]})` : WORD[r.severity])
      if (r.value) lines.push(`  ${r.value}`)
      for (const l of r.links) lines.push(l.url ? `  ${l.label}: ${l.url}` : `  ${l.label}: ${l.text}`)
    }
    if (m.hidden > 0) lines.push('', `and ${m.hidden} more, listed in ${brand}`)
  }
  if (m.url) lines.push('', `Open in ${brand}: ${m.url}`)
  for (const l of m.secondary) if (l.url) lines.push(`${l.label}: ${l.url}`)
  return `${lines.join('\n')}\n`
}

// ---- html -----------------------------------------------------------------------------------------------------

function css(decl: Record<string, string | number>): string {
  return Object.entries(decl)
    .map(([k, v]) => `${k}:${v}`)
    .join(';')
}

/** The dark values, keyed by class, so a client that honours prefers-color-scheme repaints without touching the markup. */
function darkBlock(): string {
  const d = DARK
  const rules: Array<[string, string]> = [
    ['c-bg', `background-color:${d.bg} !important`],
    ['c-card', `background-color:${d.raised} !important;border-color:${d.line} !important`],
    ['c-fg', `color:${d.fg} !important`],
    ['c-fg2', `color:${d.fg2} !important`],
    ['c-muted', `color:${d.muted} !important`],
    ['c-line-top', `border-top-color:${d.line} !important`],
    ['c-edge', `border-color:${d.lineStrong} !important`],
    ['c-sunken', `background-color:${d.sunken} !important;border-color:${d.line} !important;color:${d.fg} !important`],
    ['c-btn', `background-color:${d.fg} !important`],
    ['c-btn-a', `color:${d.bg} !important`],
    ['c-mark', `background-color:${d.fg} !important`],
    ['c-band-page', `background-color:${d.danger} !important;color:${d.bg} !important`],
    ['c-band-warn', `background-color:${d.warn} !important;color:${d.bg} !important`],
    ['c-band-calm', `background-color:${d.line} !important;color:${d.fg} !important`],
    ['c-sev-page', `color:${d.danger} !important`],
    ['c-sev-warn', `color:${d.warn} !important`]
  ]
  return `@media (prefers-color-scheme: dark){${rules.map(([c, r]) => `.${c}{${r}}`).join('')}}`
}

const FOCUS = 'a:focus-visible{outline:2px solid currentColor;outline-offset:2px}' // --size-ring
const NARROW = '@media (max-width:480px){.px{padding-left:16px !important;padding-right:16px !important}}'

/** The brand mark as table rows: no image, nothing a client can block. Geometry from the small cut in public/favicon.svg
 *  (64 units to 20 px): a bar, the pupil between two short bars, a bar. Outlook drops the radius and draws a square pupil. */
function markHtml(): string {
  const px = (n: number): string => `${n}px`
  const fill = (w: number, h: number, radius: number): string =>
    `<td class="c-mark" width="${w}" height="${h}" bgcolor="${LIGHT.fg}" style="${css({ width: px(w), height: px(h), 'line-height': px(h), 'font-size': px(h), 'background-color': LIGHT.fg, 'border-radius': px(radius) })}">&nbsp;</td>`
  const space = (w: number): string => `<td width="${w}" style="${css({ width: px(w), 'font-size': '1px', 'line-height': '1px' })}">&nbsp;</td>`
  const row = (cells: string): string =>
    `<tr><td align="center" style="padding:0"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>${cells}</tr></table></td></tr>`
  const gap = `<tr><td height="1" style="${css({ height: px(1), 'line-height': px(1), 'font-size': px(1) })}">&nbsp;</td></tr>`
  const bar = row(fill(17, 3, PILL))
  // the short bars sit on the pupil's centre line: a 3 px bar inside the 6 px row
  const short = `<td valign="middle" style="padding:0"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${fill(5, 3, PILL)}</tr></table></td>`
  const eye = row(`${short}${space(2)}${fill(6, 6, PILL)}${space(2)}${short}`)
  return `<table role="presentation" aria-hidden="true" cellpadding="0" cellspacing="0" border="0" width="20">${bar}${gap}${eye}${gap}${bar}</table>`
}

function linkHtml(l: EvidenceLink): string {
  // an inline block with its own padding is a 31 px target, and nowrap keeps one label on one line
  const base = css({ display: 'inline-block', padding: '6px 12px 6px 0', color: LIGHT.fg, 'text-decoration': 'underline', 'font-size': '13px', 'line-height': '19px', 'white-space': 'nowrap' })
  if (l.url) return `<a class="c-fg" href="${escapeHtml(l.url)}" style="${base}">${escapeHtml(l.label)}</a>`
  return ''
}

function chipHtml(text: string): string {
  const style = css({
    display: 'inline-block',
    'max-width': '100%',
    padding: '4px 8px',
    border: `1px solid ${LIGHT.line}`,
    'border-radius': `${R8}px`,
    'background-color': LIGHT.sunken,
    color: LIGHT.fg,
    'font-family': MONO,
    'font-size': '12px',
    'line-height': '18px',
    'white-space': 'pre-wrap',
    'overflow-wrap': 'anywhere'
  })
  return `<code class="c-sunken" style="${style}">${escapeHtml(text)}</code>`
}

function rowHtml(r: Row, first: boolean): string {
  const cell = css({ padding: '12px 0', 'vertical-align': 'top', 'border-top': first ? '0' : `1px solid ${LIGHT.line}` })
  const sevClass = r.severity === 'page' ? 'c-sev-page' : r.severity === 'warning' ? 'c-sev-warn' : 'c-muted'
  const sevColor = r.severity === 'page' ? LIGHT.danger : r.severity === 'warning' ? LIGHT.warn : LIGHT.muted
  const links = r.links.filter((l) => l.url).map(linkHtml)
  const chips = r.links.filter((l) => l.text !== undefined).map((l) => `<div style="${css({ 'padding-top': '8px' })}">${chipHtml(l.text as string)}</div>`)
  const linkRow = links.length > 0 ? `<div style="${css({ 'padding-top': '2px' })}">${links.join('')}</div>` : ''
  return (
    `<tr>` +
    `<td class="c-line-top" width="96" style="${cell};${css({ width: '96px', 'padding-right': '12px' })}">` +
    (r.name
      ? `<div class="c-fg" style="${css({ color: LIGHT.fg, 'font-family': MONO, 'font-size': '13px', 'line-height': '19px', 'font-weight': 500, 'overflow-wrap': 'anywhere' })}">${escapeHtml(r.name)}</div>`
      : '') +
    `<div class="${sevClass}" style="${css({ color: sevColor, 'font-size': '12px', 'line-height': '18px' })}">${WORD[r.severity]}</div>` +
    `</td>` +
    `<td class="c-line-top" style="${cell}">` +
    (r.value ? `<div class="c-fg" style="${css({ color: LIGHT.fg, 'font-size': '13px', 'line-height': '19px', 'overflow-wrap': 'anywhere' })}">${escapeHtml(r.value)}</div>` : '') +
    linkRow +
    chips.join('') +
    `</td></tr>`
  )
}

function buttonHtml(url: string, brand: string): string {
  const a = css({
    display: 'inline-block',
    padding: '12px 24px',
    color: LIGHT.bg,
    'font-family': FONT,
    'font-size': '15px',
    'line-height': '20px',
    'font-weight': 500,
    'text-decoration': 'none',
    'border-radius': `${R8}px`
  })
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td class="c-btn" bgcolor="${LIGHT.fg}" style="${css({ 'background-color': LIGHT.fg, 'border-radius': `${R8}px` })}">` +
    `<a class="c-btn-a" href="${escapeHtml(url)}" style="${a}">Open in ${escapeHtml(brand)}</a>` +
    `</td></tr></table>`
  )
}

function secondaryHtml(links: EvidenceLink[]): string {
  const items = links
    .filter((l) => l.url)
    .map((l) => {
      const a = css({
        display: 'inline-block',
        padding: '12px 16px',
        border: `1px solid ${LIGHT.lineStrong}`,
        'border-radius': `${R8}px`,
        color: LIGHT.fg,
        'font-size': '13px',
        'line-height': '19px',
        'font-weight': 500,
        'text-decoration': 'none'
      })
      return `<a class="c-fg c-edge" href="${escapeHtml(l.url as string)}" style="${a}">${escapeHtml(l.label)}</a>`
    })
  if (items.length === 0) return ''
  const gap = `<span style="${css({ 'font-size': '8px' })}">&nbsp;</span>`
  return `<div style="${css({ 'padding-top': '16px', 'line-height': '56px' })}">${items.join(gap)}</div>`
}

export function emailHtml(msg: Message, brand: string = DEFAULT_BRAND.name): string {
  const m = mailOf(msg)
  const subject = emailSubject(msg)
  const bandClass = m.neutral ? 'c-band-calm' : m.severity === 'page' ? 'c-band-page' : 'c-band-warn'
  const bandBg = m.neutral ? LIGHT.line : m.severity === 'page' ? LIGHT.danger : LIGHT.warn
  const bandInk = m.neutral ? LIGHT.fg : LIGHT.bg
  const band =
    `<tr><td class="${bandClass} px" bgcolor="${bandBg}" style="${css({ 'background-color': bandBg, color: bandInk, padding: '12px 24px', 'border-radius': `${R16}px ${R16}px 0 0`, 'font-size': '15px', 'line-height': '20px', 'font-weight': 500 })}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td style="${css({ color: 'inherit' })}">${escapeHtml(m.bandWord)}</td>` +
    `<td align="right" style="${css({ color: 'inherit', 'font-size': '13px', 'line-height': '19px', 'font-weight': 400 })}">${escapeHtml(m.bandCount)}</td>` +
    `</tr></table></td></tr>`
  const title = `<h1 class="c-fg" style="${css({ margin: 0, color: LIGHT.fg, 'font-family': FONT, 'font-size': '22px', 'line-height': '28px', 'font-weight': 500, 'letter-spacing': '-0.4px', 'overflow-wrap': 'anywhere' })}">${escapeHtml(m.title)}</h1>`
  const status = m.status ? `<p class="c-fg2" style="${css({ margin: '8px 0 0', color: LIGHT.fg2, 'font-size': '15px', 'line-height': '20px' })}">${escapeHtml(m.status)}</p>` : ''
  const plainBody =
    !msg.incident || msg.incident.instances.length === 0
      ? stripControl(msg.body)
          .split('\n')
          .filter((l) => l.trim() !== '')
          .map((l) => `<p class="c-fg2" style="${css({ margin: '8px 0 0', color: LIGHT.fg2, 'font-size': '15px', 'line-height': '20px' })}">${escapeHtml(l)}</p>`)
          .join('')
      : ''
  const head = (label: string, extra = ''): string =>
    `<th class="c-muted" align="left" scope="col" style="${css({ padding: '0 0 8px', color: LIGHT.muted, 'font-size': '12px', 'line-height': '18px', 'font-weight': 400, 'text-align': 'left' })};${extra}">${label}</th>`
  const table =
    m.rows.length > 0
      ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="${css({ 'margin-top': '24px' })}"><tr>` +
        head('Instance', css({ width: '96px', 'padding-right': '12px' })) +
        head('Value and links') +
        `</tr>${m.rows.map((r, i) => rowHtml(r, i === 0)).join('')}</table>` +
        (m.hidden > 0
          ? `<p class="c-muted" style="${css({ margin: '8px 0 0', color: LIGHT.muted, 'font-size': '13px', 'line-height': '19px' })}">and ${m.hidden} more, listed in ${escapeHtml(brand)}</p>`
          : '')
      : ''
  const card =
    `<tr><td class="c-card" bgcolor="${LIGHT.raised}" style="${css({ 'background-color': LIGHT.raised, border: `1px solid ${LIGHT.line}`, 'border-radius': `${R16}px` })}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${band}` +
    `<tr><td class="px" style="${css({ padding: '24px' })}">${title}${status}${plainBody}${table}` +
    `<div style="${css({ 'padding-top': '24px' })}">${m.url ? buttonHtml(m.url, brand) : ''}</div>${secondaryHtml(m.secondary)}</td></tr>` +
    `</table></td></tr>`
  const header =
    `<tr><td style="${css({ padding: '0 0 16px' })}"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td style="${css({ 'vertical-align': 'middle', 'padding-right': '8px' })}">${markHtml()}</td>` +
    `<td class="c-fg" style="${css({ 'vertical-align': 'middle', color: LIGHT.fg, 'font-family': FONT, 'font-size': '15px', 'line-height': '20px', 'font-weight': 500, 'letter-spacing': '-0.15px' })}">${escapeHtml(brand)}</td>` +
    `</tr></table></td></tr>`
  const footer =
    `<tr><td style="${css({ padding: '16px 0 0' })}"><p class="c-muted" style="${css({ margin: 0, color: LIGHT.muted, 'font-size': '12px', 'line-height': '18px', 'overflow-wrap': 'anywhere' })}">` +
    `Sent by ${escapeHtml(brand)}. Acknowledge the incident in the app to stop escalation.` +
    (m.url ? ` <a class="c-muted" href="${escapeHtml(m.url)}" style="${css({ color: LIGHT.muted, 'text-decoration': 'underline' })}">${escapeHtml(m.url)}</a>` : '') +
    `</p></td></tr>`
  const preheader = escapeHtml(oneLine(`${m.status || m.title}`, 140))
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">' +
    `<title>${escapeHtml(subject)}</title>` +
    `<style>:root{color-scheme:light dark;supported-color-schemes:light dark}${FOCUS}${NARROW}${darkBlock()}</style></head>` +
    `<body class="c-bg c-fg" style="${css({ margin: 0, padding: 0, 'background-color': LIGHT.bg, color: LIGHT.fg, 'font-family': FONT, 'font-size': '13px', 'line-height': '19px', '-webkit-text-size-adjust': '100%' })}">` +
    `<div style="${css({ display: 'none', 'max-height': 0, overflow: 'hidden', opacity: 0, 'mso-hide': 'all' })}">${preheader}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="c-bg" bgcolor="${LIGHT.bg}"><tr><td align="center" class="c-bg" style="${css({ 'background-color': LIGHT.bg, padding: '24px 12px' })}">` +
    `<table role="presentation" width="${WIDTH}" cellpadding="0" cellspacing="0" border="0" style="${css({ width: '100%', 'max-width': `${WIDTH}px`, 'text-align': 'left' })}">` +
    `${header}${card}${footer}</table></td></tr></table></body></html>`
  )
}

/** Printable ASCII passes as is; any other character, and "%", becomes UTF-8 percent bytes, so no two tags collide. */
function headerSafe(text: string): string {
  return Array.from(text)
    .map((c) => {
      if (/[\x20-\x7e]/.test(c) && c !== '%') return c
      return Array.from(Buffer.from(c, 'utf8'), (b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('')
    })
    .join('')
}

/**
 * The From header: the config's `from` as written when it names a sender (`EZO Watcher <watch@alerts.example.com>`), else the bare address under the brand's
 * name. The address is the config's either way: the Resend key is scoped to one sending domain.
 */
export function fromHeader(from: string, brand: string): string {
  const address = from.trim()
  if (address.includes('<')) return address
  return `${asciiLine(brand).replace(/["<>,;]/g, '')} <${address}>`
}

function idempotencyKey(msg: Message, nowMs: number): string {
  return `${cut(headerSafe(msg.tag), 180)}-${msg.kind}-${Math.floor(nowMs / 60000)}`
}

export function createEmailChannel(cfg: EmailChannelConfig, deps: ChannelDeps): Channel {
  return {
    id: cfg.id,
    type: 'email',
    send: (msg, signal) =>
      guarded(deps, signal, async (sig) => {
        const key = secret(deps.env, cfg.apiKeyEnv)
        const to = splitList(secret(deps.env, cfg.toEnv))
        if (to.length === 0) return { ok: false, status: 'no recipients' }
        const res = await deps.fetch(`${cfg.baseUrl ?? 'https://api.resend.com'}/emails`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey(msg, deps.now())
          },
          body: JSON.stringify({
            from: fromHeader(cfg.from, brandName(deps)),
            to,
            subject: emailSubject(msg),
            text: emailText(msg, brandName(deps)),
            html: emailHtml(msg, brandName(deps))
          }),
          signal: sig
        })
        await drain(res)
        return httpOutcome(res)
      })
  }
}
