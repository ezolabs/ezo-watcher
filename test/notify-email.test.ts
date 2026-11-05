import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { emailHtml, emailSubject, emailText } from '../src/server/notify/channels/email.ts'
import { buildMessage } from '../src/server/notify/message.ts'
import type { Subject } from '../src/server/notify/plan.ts'
import type { InstanceView, NotifyView } from '../src/server/notify/types.ts'

// The FleetDisk incident of 2026-10-15, as the notifier sees it: the sweep lists the hosts in name order, node-4 first,
// but node-5 is full in about 8 h while node-4 has 1.9 days. The email must lead with node-5.
const TOPIC = 'https://chat.example.com/#narrow/channel/8-triage/topic/sweep.202026-10-15'
const START = '2026-10-15T06:16:13.161Z'
const NOW = Date.parse('2026-10-15T07:16:30Z')

function inst(host: string, summary: string, extra: Partial<InstanceView> = {}): InstanceView {
  return {
    fingerprint: `fp-${host}`,
    name: host,
    startsAt: START,
    severity: 'page',
    summary,
    annotations: { summary, report_url: `${TOPIC}/near/${host === 'node-4' ? 81 : host === 'node-5' ? 82 : 83}`, evidence: `ssh ${host} 'df -h /; du -xh --max-depth=1 / | sort -h | tail'` },
    ...extra
  }
}

const node4 = inst('node-4', 'node-4 disk / 89.3% (100 GB free, full in ~1.9d)')
const node5 = inst('node-5', 'node-5 disk / 81% (175 GB free, full in ~8h)', { annotations: { summary: 'node-5 disk / 81% (175 GB free, full in ~8h)', report_url: `${TOPIC}/near/82`, evidence: "ssh node-5 'df -h /; du -xh --max-depth=1 / | sort -h | tail'", evidence_url: 'https://chat.example.com/user_uploads/2/ab/df-node-5.txt', runbook_url: 'https://wiki.example.com/runbooks/disk-fill' } })
const node6 = inst('node-6', 'node-6 disk / 88.1% (111 GB free, full in ~1.1d)')

function view(over: Partial<NotifyView> = {}): NotifyView {
  return {
    key: 'sweep|FleetDisk',
    service: 'sweep',
    rule: 'FleetDisk',
    summary: node4.summary as string,
    severity: 'page',
    severityLabel: 'page',
    origin: 'sweep',
    labels: { alertname: 'FleetDisk' },
    instances: [node4, node5, node6],
    startsAt: START,
    firstSeen: START,
    attention: 'none',
    unattendedSec: 3600,
    flapping: false,
    links: {},
    ...over
  }
}

const ctx = { baseUrl: 'https://watch.example.com', ackSecret: 'secret', nowMs: NOW }
const subject = (kind: 'alert' | 'escalation' | 'flapping', v: NotifyView = view()): Subject => ({ type: 'firing', kind, view: v })
const escalation = () => buildMessage(subject('escalation'), ctx)

describe('email subject and title name the worst instance', () => {
  it('leads with node-5 and counts the rest, with no middle dot and no em dash', () => {
    const msg = escalation()
    expect(emailSubject(msg)).toBe('Escalated page: node-5 disk / 81% (175 GB free, full in ~8h), and 2 more hosts')
    expect(emailSubject(buildMessage(subject('alert'), ctx))).toBe('Page: node-5 disk / 81% (175 GB free, full in ~8h), and 2 more hosts')
    expect(emailSubject(msg)).not.toMatch(/[·—–]/)
  })

  it('also fixes the title every other channel reads', () => {
    expect(escalation().title).toBe('Escalated page: node-5 disk / 81% (175 GB free, full in ~8h)')
  })

  it('says "and 1 more host", "instances" for a rule-named instance, and nothing for a single instance', () => {
    expect(emailSubject(buildMessage(subject('alert', view({ instances: [node4, node5] })), ctx))).toBe('Page: node-5 disk / 81% (175 GB free, full in ~8h), and 1 more host')
    const one = view({ instances: [node5] })
    expect(emailSubject(buildMessage(subject('alert', one), ctx))).toBe('Page: node-5 disk / 81% (175 GB free, full in ~8h)')
    const byRule = view({ instances: [{ ...node4, name: 'FleetDisk' }, { ...node6, name: 'FleetDisk' }] })
    expect(emailSubject(buildMessage(subject('alert', byRule), ctx))).toMatch(/, and 1 more instance$/)
  })

  it('names a warning "Warning" and a flapping incident "Flapping"', () => {
    const warn = view({ severity: 'warning', instances: [{ ...node4, severity: 'warning' }, { ...node6, severity: 'warning' }] })
    expect(emailSubject(buildMessage(subject('alert', warn), ctx))).toBe('Warning: node-6 disk / 88.1% (111 GB free, full in ~1.1d), and 1 more host')
    expect(emailSubject(buildMessage(subject('flapping'), ctx))).toMatch(/^Flapping: node-5 disk/)
  })

  it('leaves a message with no incident behind it exactly as titled', () => {
    expect(emailSubject({ kind: 'test', title: 'EZO Watcher test', body: 'x', severity: 'info', tag: 't', url: 'https://watch.example.com/' })).toBe('EZO Watcher test')
  })
})

describe('email html', () => {
  const html = emailHtml(escalation())

  it('puts the severity band first, in the tokens danger red for a page and warning amber for a warning', () => {
    expect(html.indexOf('c-band-page')).toBeGreaterThan(0)
    expect(html).toContain('background-color:#a84f4f') // --color-danger, light
    expect(html).toContain('#f23f42') // --color-danger, in the dark block
    const warn = emailHtml(buildMessage(subject('alert', view({ severity: 'warning', instances: [{ ...node6, severity: 'warning' }] })), ctx))
    expect(warn).toContain('<td class="c-band-warn px" bgcolor="#806218"')
    expect(warn).not.toContain('<td class="c-band-page')
  })

  it('titles with the worst instance, then one status sentence, then the table worst first', () => {
    const h1 = /<h1[^>]*>([^<]*)<\/h1>/.exec(html)?.[1]
    expect(h1).toBe('node-5 disk / 81% (175 GB free, full in ~8h)')
    expect(html).toContain('Nobody has acknowledged this for 1h, so it escalated.')
    const order = ['>node-5<', '>node-6<', '>node-4<'].map((x) => html.indexOf(x))
    expect(order.every((i) => i > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('takes each row value from the instance own summary and gives each row its report and evidence', () => {
    expect(html).toContain('anywhere">disk / 81% (175 GB free, full in ~8h)</div>')
    expect(html).toContain('anywhere">disk / 88.1% (111 GB free, full in ~1.1d)</div>')
    for (const n of [81, 82, 83]) expect(html).toContain(`href="${TOPIC}/near/${n}"`)
    expect(html).toContain('Report in #triage')
    expect(html).toContain('ssh node-5 &#39;df -h /; du -xh --max-depth=1 / | sort -h | tail&#39;')
    expect(html).toContain('href="https://chat.example.com/user_uploads/2/ab/df-node-5.txt"')
  })

  it('has a bulletproof table button to the incident, then the source and runbook links', () => {
    const button = /<table role="presentation"[^>]*><tr><td class="c-btn"[^>]*>(<a [^>]*>Open in EZO Watcher<\/a>)<\/td><\/tr><\/table>/.exec(html)
    expect(button).not.toBeNull()
    expect(button?.[1]).toContain('href="https://watch.example.com/#/i/sweep%7CFleetDisk"')
    expect(html.indexOf('Open in EZO Watcher</a>')).toBeLessThan(html.indexOf('>Runbook</a>'))
    expect(html).toContain('href="https://wiki.example.com/runbooks/disk-fill"')
  })

  it('draws the brand mark as the favicon small cut: a bar, a pupil between two short bars, a bar', () => {
    const widths = [...html.matchAll(/<td class="c-mark" width="(\d+)" height="(\d+)"/g)].map((m) => `${m[1]}x${m[2]}`)
    expect(widths).toEqual(['17x3', '5x3', '6x6', '5x3', '17x3'])
    expect(readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8')).toContain('<circle cx="32" cy="32" r="8"')
  })

  it('is table markup with inline styles, 600 px, both color-scheme metas, no external CSS, no images, under 100 KB', () => {
    expect(html).toContain('<meta name="color-scheme" content="light dark">')
    expect(html).toContain('<meta name="supported-color-schemes" content="light dark">')
    expect(html).toContain('prefers-color-scheme: dark')
    expect(html).toContain('max-width:600px')
    expect(html).toContain('font-family:SF Pro Rounded,ui-rounded,Inter,system-ui,sans-serif')
    expect(html).not.toMatch(/<link|<img|<script|@import|url\(|https?:\/\/[^"' ]*\.(?:png|jpg|gif|svg|css)/i)
    expect(Buffer.byteLength(html)).toBeLessThan(100_000)
    expect(html.match(/<table/g)?.length).toBeGreaterThan(5)
  })

  it('has no em dash, no middle dot and no arrow in the copy', () => {
    expect(html).not.toMatch(/[—·→]/)
    expect(emailText(escalation())).not.toMatch(/[—·→]/)
  })

  it('uses only hex values that are in the tokens file, and only its two radii and the pill', () => {
    const tokens = readFileSync(new URL('../src/web/styles/tokens.css', import.meta.url), 'utf8')
    const known = new Set(tokens.match(/#[0-9a-f]{6}\b/gi)?.map((h) => h.toLowerCase()))
    const source = readFileSync(new URL('../src/server/notify/channels/email.ts', import.meta.url), 'utf8')
    for (const text of [source, html]) {
      const used = [...new Set(text.match(/#[0-9a-f]{6}\b/gi)?.map((h) => h.toLowerCase()))]
      expect(used.filter((h) => !known.has(h))).toEqual([])
    }
    const radii = new Set(html.match(/border-radius:[^;"]+/g))
    expect([...radii].sort()).toEqual(['border-radius:16px 16px 0 0', 'border-radius:16px', 'border-radius:8px', 'border-radius:9999px'].sort())
  })

  it('caps a long incident at ten rows with a count of the rest, and stays under the clip limit', () => {
    const many = Array.from({ length: 40 }, (_, i) => inst(`host-${String(i).padStart(2, '0')}`, `host-${i} disk / 90% (full in ~${i + 2}h)`))
    const big = emailHtml(buildMessage(subject('alert', view({ instances: many })), ctx))
    expect(big.match(/>host-\d\d</g)).toHaveLength(10)
    expect(big).toContain('and 30 more, listed in EZO Watcher')
    expect(Buffer.byteLength(big)).toBeLessThan(100_000)
  })

  it('leaves a name that is only the summary out of the name column, so no row repeats its own text', () => {
    const finding = (summary: string, near: number): InstanceView => ({ fingerprint: `fp${near}`, name: summary, nameSource: 'summary', startsAt: START, severity: 'page', summary, annotations: { summary, report_url: `${TOPIC}/near/${near}` } })
    const out = emailHtml(buildMessage(subject('alert', view({ rule: 'IntakeSinkStale', instances: [finding('ClickHouse tables unread/stale: 0 unread, 1 stale', 90), finding('sink_stale: x302', 91)] })), ctx))
    // each summary appears once in the table body (the first is also the title), as the value, and no mono name div holds it
    expect(out.match(/sink_stale: x302/g)).toHaveLength(1)
    expect(out).not.toMatch(/font-family:ui-monospace[^"]*">ClickHouse tables/)
    expect(out).toContain('anywhere">sink_stale: x302</div>')
    const text = emailText(buildMessage(subject('alert', view({ rule: 'IntakeSinkStale', instances: [finding('sink_stale: x302', 91)] })), ctx))
    expect(text).toContain('\nPage\n  sink_stale: x302\n')
    expect(text).not.toContain('IntakeSinkStale')
  })

  it('offers a Grafana alert its source and runbook as secondary links after the button, not in the rows', () => {
    const g = view({
      instances: [{ ...node5, annotations: { summary: node5.summary as string }, links: { panel: 'https://grafana.example.com/d/abc?viewPanel=2', explore: 'https://grafana.example.com/explore?x=1', runbook: 'https://wiki.example.com/rb/edge' } }]
    })
    const out = emailHtml(buildMessage(subject('alert', g), ctx))
    const button = out.indexOf('>Open in EZO Watcher</a>')
    for (const label of ['Grafana panel', 'Explore in Grafana', 'Runbook']) expect(out.indexOf(`>${label}</a>`)).toBeGreaterThan(button)
    expect(out).toContain('href="https://grafana.example.com/d/abc?viewPanel=2"')
    // no report or command on the instance: its row is the value alone
    expect(out).not.toContain('Report in #')
    expect(out).not.toContain('<code')
  })

  it('drops a link that is not http(s) and renders a message with no incident as a plain card', () => {
    const odd = view({ instances: [{ ...node5, annotations: { summary: node5.summary as string, report_url: 'javascript:alert(1)', evidence: '<img src=x onerror=1>' } }] })
    const out = emailHtml(buildMessage(subject('alert', odd), ctx))
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img src=x onerror=1&gt;')
    const resolved = emailHtml({ kind: 'resolved', title: 'Resolved: FleetDisk', body: 'sweep, resolved at 08:00 UTC after 1h 40m.', severity: 'page', tag: 't', url: 'https://watch.example.com/#/i/x' })
    expect(resolved).toContain('c-band-calm')
    expect(resolved).toContain('sweep, resolved at 08:00 UTC after 1h 40m.')
  })
})

describe('email text', () => {
  const text = emailText(escalation())

  it('mirrors the html: band, title, status, rows worst first, full URLs, the button link', () => {
    expect(text.split('\n')[0]).toBe('Page, 3 hosts firing')
    expect(text).toContain('node-5 disk / 81% (175 GB free, full in ~8h)')
    expect(text).toContain('Nobody has acknowledged this for 1h, so it escalated.')
    expect(text.indexOf('node-5 (Page)')).toBeLessThan(text.indexOf('node-6 (Page)'))
    expect(text.indexOf('node-6 (Page)')).toBeLessThan(text.indexOf('node-4 (Page)'))
    expect(text).toContain(`Report in #triage: ${TOPIC}/near/82`)
    expect(text).toContain("Evidence command: ssh node-5 'df -h /; du -xh --max-depth=1 / | sort -h | tail'")
    expect(text).toContain('Open in EZO Watcher: https://watch.example.com/#/i/sweep%7CFleetDisk')
    expect(text).toContain('Runbook: https://wiki.example.com/runbooks/disk-fill')
  })
})
