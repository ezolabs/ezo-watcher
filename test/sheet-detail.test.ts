// The incident sheet's error hero and its Markdown "What happened". The alert shapes are the ones the live /api/state and /api/incidents/<key> returned on
// 2026-10-15 (Grafana regression rules, the node-2 prober, Netdata Cloud, the regression sweep's Sentry record) and the ones the sources write in code (Sentry,
// the Netdata webhook). The markup tests run the real components through react-dom/server: no alert text may ever become markup.
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ErrorHero, Markdown, WhatHappened } from '../src/web/components/SheetDetail.tsx'
import { heroKindOf, heroOf, MAX_FACTS, MAX_LINE, measuredOf } from '../src/web/lib/hero.ts'
import type { HeroSource } from '../src/web/lib/hero.ts'
import { FOLD_AFTER, inlineText, leadEnd, parseInline, parseMarkdown, scanOf, sentencesOf } from '../src/shared/markdown.ts'

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

// ---- the alerts, as the sources send them -----------------------------------------------------------------------------------------

const GRAFANA_BASE = { grafana_folder: 'API alerts', severity: 'warn', team: 'api' }
const typed = "[ var='A' labels={} type='query' value=3 ], [ var='B' labels={} type='reduce' value=3 ], [ var='C' labels={} type='threshold' value=1 ]"

/** Grafana "New error signature at the edge": the signature is the error, the value is how many events. */
const newEdgeError: HeroSource = {
  origin: 'grafana',
  rule: 'New error signature at the edge (first seen, 4 h)',
  labels: { ...GRAFANA_BASE, alertname: 'New error signature at the edge (first seen, 4 h)', component: 'new-errors', first_seen: '10-15 21:01', signature: 'Model API (door) | POST /v1/chat/completions | 503 | server_shutdown', source: 'edge' },
  annotations: { summary: 'New edge error Model API (door) | POST /v1/chat/completions | 503 | server_shutdown: 3 events since 10-15 21:01 UTC', __values__: '{"A":3,"B":3,"C":1}', __value_string__: typed },
  value: 'A=3, B=3, C=1',
  via: [{ kind: 'grafana' }]
}

/** Grafana "Ops errors", as a screenshot showed it. Held open 30 minutes after the last breach, every value 0 now, only a family label. */
const heldOpen: HeroSource = {
  origin: 'grafana',
  rule: 'Error rate stepped up vs usual (3 h, per path)',
  labels: { ...GRAFANA_BASE, alertname: 'Error rate stepped up vs usual (3 h, per path)', component: 'ops-errors', family: 'Model API (door)' },
  annotations: {
    summary: 'Model API (door): the error rate has stepped up and stayed up for hours, real traffic (back under its line now, held open 30 minutes after the last breach)',
    __values__: '{"A":0,"B":0,"C":0}',
    __value_string__: "[ var='A' labels={family=Model API (door)} type='query' value=0 ], [ var='B' labels={family=Model API (door)} type='reduce' value=0 ], [ var='C' labels={family=Model API (door)} type='threshold' value=0 ]"
  },
  // Watch kept the value of the last breach; Grafana's current evaluation says 0
  value: 'A=8.91219, B=8.91219, C=1',
  via: [{ kind: 'grafana' }]
}

/** Grafana "New server error text": a free-text template as the signature. */
const newText: HeroSource = {
  origin: 'grafana',
  rule: 'New server error text (never seen in 14 days)',
  labels: { ...GRAFANA_BASE, alertname: 'New server error text (never seen in 14 days)', component: 'new-errors', first_seen: '10-15 20:03', signature: 'page returned <n>', source: 'request_conversations' },
  annotations: { summary: 'New request_conversations error: page returned <n> (3 events since 10-15 20:03 UTC)', __values__: '{"A":3,"B":3,"C":1}', __value_string__: typed },
  value: 'A=3, B=3, C=1',
  via: [{ kind: 'grafana' }]
}

const backAfterSilence: HeroSource = {
  origin: 'grafana',
  rule: 'Error signature is back after 3+ days of silence',
  labels: { ...GRAFANA_BASE, component: 'new-errors', first_seen: '10-15 21:01', signature: 'Model API pass-through | POST api credits | 503 | server_shutdown', silent_hours: '86', source: 'edge' },
  annotations: { summary: 'Back after 86 h of silence: edge Model API pass-through | POST api credits | 503 | server_shutdown (10 events, back at 10-15 21:01 UTC)', __values__: '{"A":10,"B":10,"C":1}', __value_string__: typed },
  value: 'A=10, B=10, C=1',
  via: [{ kind: 'grafana' }]
}

/** The Envoy regression rule: no label says what failed, and its readings are all 0 while it is held open. */
const gatewayHeld: HeroSource = {
  origin: 'grafana',
  rule: 'Envoy 5xx, connect fails, timeouts 4x baseline',
  labels: { ...GRAFANA_BASE, component: 'gateway' },
  annotations: { summary: 'Gateway Envoy failures at least 4x the same hour of the past week (back under its line now, held open 30 minutes after the last breach)', __values__: '{"A":0,"B":0,"C":0}' },
  value: 'A=22, B=22, C=1',
  via: [{ kind: 'grafana' }]
}

/** A Sentry issue as src/server/sources/sentry.ts writes it, with the payload the detail endpoint carries. */
const sentryIssue: HeroSource = {
  origin: 'sentry',
  rule: 'Sentry: new issue',
  labels: { alertname: 'Sentry: new issue', severity: 'warning', service: 'Helper', instance: 'APP-HELPER-2', project: 'acme-helper', issue_type: 'New issue', level: 'error', release: 'helper@1.0.14', environment: 'production', users: '4', events: '769' },
  annotations: { summary: 'Module._resolveFilename (loader) – Error: Cannot find module ./dist/server', description: 'New issue in acme-helper: 769 events, 4 users' },
  value: '12 in the last hour, 769 events in all',
  via: [{ kind: 'sentry' }],
  raw: { title: 'Error: Cannot find module ./dist/server', culprit: 'Module._resolveFilename (loader)' }
}

const sentryCrashFree: HeroSource = {
  origin: 'sentry',
  rule: 'Sentry: crash-free sessions low',
  labels: { alertname: 'Sentry: crash-free sessions low', service: 'Mobile', instance: '1.0.14+7520', project: 'acme-mobile', issue_type: 'Crash-free sessions', release: '1.0.14+7520', environment: 'production', sessions: '450', crashFree: '98.2%' },
  annotations: { summary: '1.0.14+7520 – 98.2% of 450 sessions crash-free in 24 h' },
  value: '98.2% crash-free of 450 sessions',
  via: [{ kind: 'sentry' }]
}

/** Netdata Cloud, read by Watch: the value text is the live reading. */
const netdataDisk: HeroSource = {
  origin: 'netdata-cloud',
  rule: 'Host disk filling up (node-4)',
  labels: { alertname: 'out_of_disk_space_time', severity: 'warning', netdata_severity: 'warning', host: 'node-4', instance: 'node-4', component: 'host-disk', service: 'Host disks', system: 'Netdata', netdata_instance: 'disk_space./', mountpoint: '/' },
  annotations: { summary: 'node-4 disk filling up (/) is at warning: 86.2% used, 119.6 GiB free of 914.7 GiB', description: 'Netdata projects the filesystem to be full in under 8 hours.' },
  value: '85.8% used, 123.6 GiB free of 914.7 GiB',
  via: [{ kind: 'netdata-cloud' }]
}

/** The Netdata Cloud webhook (ingest/netdata): no value field, the reading is in Netdata's message. */
const netdataWebhook: HeroSource = {
  origin: 'netdata',
  rule: 'Host disk full imminent (node-3)',
  labels: { alertname: 'disk_space_usage', severity: 'critical', netdata_severity: 'critical', host: 'node-3', instance: 'node-3', component: 'host-disk', chart: 'disk_space./', mountpoint: '/' },
  annotations: { summary: 'Disk space usage on node-3 (/) is critical', description: 'disk_space_usage on node-3 is critical: 98.9% used, 3.1 GiB available', duration: '2m' },
  via: [{ kind: 'webhook' }]
}

const netdataNoValue: HeroSource = {
  origin: 'netdata-cloud',
  rule: 'Netdata: OOM kills (node-15)',
  labels: { alertname: 'oom_kill', severity: 'warning', netdata_severity: 'warning', host: 'node-15', instance: 'node-15', component: 'netdata', service: 'Netdata', system: 'Netdata' },
  annotations: { summary: 'node-15 OOM kills is at warning', description: "Netdata's alert oom_kill is at warning. node-15 is not a fleet node, so nothing it reports pages." },
  via: [{ kind: 'netdata-cloud' }]
}

/** The node-2 prober, from /api/incidents/Uptime|ProbeDown|site. */
const probeDown: HeroSource = {
  origin: 'api-uptime',
  rule: 'ProbeDown',
  labels: { alertname: 'ProbeDown', instance: 'site', severity: 'page', component: 'uptime' },
  annotations: {
    summary: 'site failed its node-2 uptime check',
    description:
      'site (https://api.gg/) failed 3 checks in a row, last: no response (curl exit 28: curl: (28) Operation timed out after 10004 milliseconds with 0 bytes received). Probed from node-2 once a minute. DOWN is declared after 3 failed checks.'
  },
  via: [{ kind: 'webhook' }]
}

/** The regression sweep's Sentry record: `source | id | ISO time | title | detail`. */
const sweepSentry: HeroSource = {
  origin: 'sweep',
  rule: 'IntakeSentryMobile',
  labels: { alertname: 'IntakeSentryMobile', severity: 'warning', layer: 'clients', sweep_sev: 'S2', sweep_key: 'intake/sentry_mobile/7739867797', probe: 'intake', source: 'sentry_mobile', service: 'mobile app', env: 'prod' },
  annotations: {
    summary: 'sentry_mobile: cocoa:MXDiskWriteException: x2',
    headline: 'Mobile app error seen 2 times: cocoa:MXDiskWriteException:',
    evidence_output:
      'sentry_mobile | 7739867797 | 2026-10-15T21:17:47.484000Z | cocoa:MXDiskWriteException: | APP-MOBILE-J warning ongoing status=unresolved project=acme-mobile count=2 users=1 v1.0.14+7520 app_build=7520'
  },
  via: [{ kind: 'webhook' }]
}

const sweepBugReport: HeroSource = {
  origin: 'sweep',
  rule: 'IntakeBugReport',
  labels: { alertname: 'IntakeBugReport', sweep_key: 'intake/bug_report/br_mv90r5d4_a152a0f1', source: 'bug_report' },
  annotations: {
    summary: 'bug_report: desktop:1b9aa85f',
    headline: 'Desktop Helper stopped answering its status probe',
    evidence_output: 'exit code: 1\nno response from helper\nprobe timed out after 30s\nlast heartbeat: 2026-10-15T06:14:02Z\nstderr:\n  Error: connect ECONNREFUSED 127.0.0.1:18742'
  }
}

const routerAlert: HeroSource = {
  origin: 'prod',
  rule: 'ApiTokenizationDivergence',
  labels: { alertname: 'ApiTokenizationDivergence', severity: 'ticket', namespace: 'prod' },
  annotations: { summary: "more than half of a backend's cached prompt tokens over 30m were never predicted by the router's mirror" },
  via: [{ kind: 'webhook' }]
}

// ---- heroOf -------------------------------------------------------------------------------------------------------------------

describe('heroOf: the error per source', () => {
  it('Grafana: a signature of the edge request log is read as status and class, the route and family are facts, the real value is the event count', () => {
    const hero = heroOf(newEdgeError)
    expect(hero).toEqual({
      kind: 'grafana',
      line: '503 server_shutdown',
      copy: 'Model API (door) | POST /v1/chat/completions | 503 | server_shutdown',
      facts: [
        { name: 'Route', value: 'POST /v1/chat/completions' },
        { name: 'Family', value: 'Model API (door)' },
        { name: 'Events', value: '3' },
        { name: 'Since', value: '10-15 21:01' }
      ]
    })
  })

  it('Grafana: a free-text template is the line whole; the source and the count stay as facts', () => {
    expect(heroOf(newText)).toEqual({
      kind: 'grafana',
      line: 'page returned <n>',
      copy: 'page returned <n>',
      facts: [
        { name: 'Events', value: '3' },
        { name: 'Since', value: '10-15 20:03' },
        { name: 'Source', value: 'request_conversations' }
      ]
    })
  })

  it('Grafana: a label named template or tpl wins over the signature, and a rule back from silence says for how long', () => {
    expect(heroOf({ ...newText, labels: { ...newText.labels, tpl: 'timeout after <n>s' } })?.line).toBe('timeout after <n>s')
    expect(heroOf({ ...newText, labels: { ...newText.labels, template: 'dial <ip>: connection refused' } })?.line).toBe('dial <ip>: connection refused')
    const back = heroOf(backAfterSilence)
    expect(back?.line).toBe('503 server_shutdown')
    expect(back?.facts.map((f) => f.name)).toEqual(['Route', 'Family', 'Events', 'Silent for'])
    expect(back?.facts[3].value).toBe('86 h')
  })

  it('Grafana: with no signature, status and class and route are the error and its place', () => {
    const hero = heroOf({ ...heldOpen, labels: { ...heldOpen.labels, route: 'POST /v1/messages', status: '502', class: 'upstream_5xx' }, annotations: { ...heldOpen.annotations, __values__: '{"A":8.9,"B":8.9,"C":1}' } })
    expect(hero?.line).toBe('502 upstream_5xx')
    expect(hero?.facts).toEqual([
      { name: 'Route', value: 'POST /v1/messages' },
      { name: 'Family', value: 'Model API (door)' },
      { name: 'Measured', value: '8.9' }
    ])
  })

  it('Sentry: the issue title is the error and the culprit, issue, events and users are the facts', () => {
    expect(heroOf(sentryIssue)).toEqual({
      kind: 'sentry',
      line: 'Error: Cannot find module ./dist/server',
      copy: 'Error: Cannot find module ./dist/server',
      facts: [
        { name: 'Culprit', value: 'Module._resolveFilename (loader)' },
        { name: 'Issue', value: 'APP-HELPER-2' },
        { name: 'Events', value: '769' },
        { name: 'Users', value: '4' }
      ]
    })
  })

  it('Sentry: without the payload the summary is split at the culprit, and a summary with no culprit is the message', () => {
    const noRaw = { ...sentryIssue, raw: undefined }
    expect(heroOf(noRaw)?.line).toBe('Error: Cannot find module ./dist/server')
    expect(heroOf(noRaw)?.facts[0]).toEqual({ name: 'Culprit', value: 'Module._resolveFilename (loader)' })
    const bare = heroOf({ ...noRaw, annotations: { summary: 'TypeError: x is not a function' } })
    expect(bare?.line).toBe('TypeError: x is not a function')
    expect(bare?.facts.some((f) => f.name === 'Culprit')).toBe(false)
  })

  it('Sentry: a crash-free session alert says the rate and how many sessions', () => {
    expect(heroOf(sentryCrashFree)).toEqual({
      kind: 'sentry',
      line: '98.2% crash-free of 450 sessions',
      copy: '98.2% crash-free of 450 sessions',
      facts: [{ name: 'Release', value: '1.0.14+7520 (production)' }]
    })
  })

  it('Netdata: the value text is the line, and the host, mount and level are facts', () => {
    expect(heroOf(netdataDisk)).toEqual({
      kind: 'netdata',
      line: '85.8% used, 123.6 GiB free of 914.7 GiB',
      copy: '85.8% used, 123.6 GiB free of 914.7 GiB',
      facts: [
        { name: 'Host', value: 'node-4' },
        { name: 'Mount', value: '/' },
        { name: 'Level', value: 'warning' }
      ]
    })
  })

  it('Netdata: the webhook has no value field, so the reading is taken from the message after the level', () => {
    const hero = heroOf(netdataWebhook)
    expect(hero?.line).toBe('98.9% used, 3.1 GiB available')
    expect(hero?.facts).toEqual([
      { name: 'Host', value: 'node-3' },
      { name: 'Mount', value: '/' },
      { name: 'Level', value: 'critical' },
      { name: 'Duration', value: '2m' }
    ])
  })

  it('prober: the curl error of the last check is the line; the URL, the streak and the prober are facts', () => {
    expect(heroOf(probeDown)).toEqual({
      kind: 'prober',
      line: 'curl: (28) Operation timed out after 10004 milliseconds with 0 bytes received',
      copy: 'curl: (28) Operation timed out after 10004 milliseconds with 0 bytes received',
      facts: [
        { name: 'URL', value: 'https://api.gg/' },
        { name: 'Failed', value: '3 checks in a row' },
        { name: 'From', value: 'node-2' }
      ]
    })
  })

  it('prober: an HTTP status is the line when there is no curl message', () => {
    const http = { ...probeDown, annotations: { summary: 'chat failed its node-2 uptime check', description: 'chat (https://chat.example.com/api/health) failed 3 checks in a row, last: HTTP 502 Bad Gateway. Probed from node-2 once a minute. DOWN is declared after 3 failed checks.' } }
    expect(heroOf(http)?.line).toBe('HTTP 502 Bad Gateway')
    expect(heroOf(http)?.facts[0]).toEqual({ name: 'URL', value: 'https://chat.example.com/api/health' })
  })

  it('regression sweep: the title of the record it printed is the line, with the issue, events and users as facts', () => {
    expect(heroOf(sweepSentry, 'Mobile app error seen 2 times: cocoa:MXDiskWriteException:')).toEqual({
      kind: 'sweep',
      line: 'cocoa:MXDiskWriteException',
      copy: 'cocoa:MXDiskWriteException',
      facts: [
        { name: 'Issue', value: 'APP-MOBILE-J' },
        { name: 'Events', value: '2' },
        { name: 'Users', value: '1' },
        { name: 'Project', value: 'acme-mobile' }
      ]
    })
  })

  it('regression sweep: a record printed bare, with no detail column, reads as its title too and has no facts', () => {
    const bare: HeroSource = { ...sweepSentry, annotations: { ...sweepSentry.annotations, evidence_output: '!sentry_helper | 7790254085 | 2026-10-15T10:46:35.870000Z | node:Error:Module._resolveFilename(loader)' } }
    expect(heroOf(bare)).toEqual({ kind: 'sweep', line: 'node:Error:Module._resolveFilename(loader)', copy: 'node:Error:Module._resolveFilename(loader)', facts: [] })
  })

  it('regression sweep: captured output gives its first error-looking line, not its preamble; with no output the summary is the line', () => {
    expect(heroOf(sweepBugReport)?.line).toBe('probe timed out after 30s')
    const noOutput: HeroSource = { origin: 'sweep', rule: 'FleetDisk', labels: { sweep_key: 'fleet/node-5/disk//' }, annotations: { summary: 'node-5 disk / 80.4% (183 GB free, full in ~1.3d)', headline: 'Disk on node-5 is filling' } }
    expect(heroOf(noOutput, 'Disk on node-5 is filling')?.line).toBe('node-5 disk / 80.4% (183 GB free, full in ~1.3d)')
  })

  it('a webhook or router alert: the summary is the line only when it says more than the title does', () => {
    expect(heroOf(routerAlert, routerAlert.annotations?.summary)).toBeNull()
    const withHeadline: HeroSource = { ...routerAlert, annotations: { ...routerAlert.annotations, headline: 'Cache hits are being mispriced' }, value: '0.62' }
    expect(heroOf(withHeadline, 'Cache hits are being mispriced')).toEqual({
      kind: 'other',
      line: "more than half of a backend's cached prompt tokens over 30m were never predicted by the router's mirror",
      copy: "more than half of a backend's cached prompt tokens over 30m were never predicted by the router's mirror",
      facts: [{ name: 'Value', value: '0.62' }]
    })
  })
})

describe('heroOf: no hero when the source gave no error', () => {
  it('returns nothing for an alert with no error text at all', () => {
    expect(heroOf({ rule: 'Something', labels: {}, annotations: {} })).toBeNull()
    expect(heroOf({ rule: 'Something' })).toBeNull()
    expect(heroOf(netdataNoValue)).toBeNull()
    expect(heroOf({ ...probeDown, annotations: { summary: 'chat.example.com failed its node-2 uptime check' } })).toBeNull()
    expect(heroOf({ ...sentryIssue, raw: undefined, annotations: {} })).toBeNull()
  })

  it('never shows a cleared value as the error: the Ops screenshot (family only, readings 0) and the held Envoy rule have no hero', () => {
    expect(heroOf(heldOpen)).toBeNull()
    expect(heroOf(gatewayHeld)).toBeNull()
    expect(heroOf({ ...netdataDisk, value: '0' })).toBeNull()
    expect(heroOf({ ...netdataDisk, value: '0%' })).toBeNull()
    expect(heroOf({ ...probeDown, annotations: { description: 'x (https://x.dev/) failed 3 checks in a row, last: 0. Probed from node-2' } })).toBeNull()
  })

  it('keeps the error text of a held rule but drops the measure that is 0 now', () => {
    const held = heroOf({ ...newEdgeError, annotations: { ...newEdgeError.annotations, __values__: '{"A":0,"B":0,"C":0}' } })
    expect(held?.line).toBe('503 server_shutdown')
    expect(held?.facts.map((f) => f.name)).toEqual(['Route', 'Family', 'Since', 'Source'])
  })

  it('does not repeat the title under itself', () => {
    expect(heroOf(newText, 'page returned <n>')).toBeNull()
    expect(heroOf(netdataDisk, '85.8% used, 123.6 GiB free of 914.7 GiB.')).toBeNull()
  })

  it('cuts a very long line on a word, keeps the whole of it for Copy, and shows at most four facts', () => {
    const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ')
    const hero = heroOf({ origin: 'sweep', rule: 'X', labels: { sweep_key: 'k' }, annotations: { evidence_output: `error: ${words}` } })
    expect(hero?.line.length).toBeLessThanOrEqual(MAX_LINE + 3)
    expect(hero?.line.endsWith('...')).toBe(true)
    // cut on a word: what is kept is a prefix of the text that ends where a space follows
    const kept = (hero?.line ?? '').slice(0, -3)
    expect(`error: ${words}`.startsWith(kept)).toBe(true)
    expect(`error: ${words}`[kept.length]).toBe(' ')
    expect(hero?.copy.length).toBeGreaterThan(MAX_LINE)
    expect(MAX_FACTS).toBe(4)
    for (const a of [newEdgeError, sentryIssue, netdataWebhook, probeDown, sweepSentry]) expect(heroOf(a)?.facts.length ?? 0).toBeLessThanOrEqual(MAX_FACTS)
  })
})

describe('measuredOf: a value is real only while the current evaluation says so', () => {
  it('reads Grafana\'s own current values, not the value string kept from the last breach', () => {
    expect(measuredOf(heldOpen)).toBeNull()
    expect(measuredOf({ annotations: { __values__: '{"A":8.91219,"B":8.91219,"C":1}' } })).toBe('8.912')
  })
  it('never takes the threshold variable as the measure', () => {
    expect(measuredOf({ annotations: { __values__: '{"A":0,"B":0,"C":1}', __value_string__: typed } })).toBeNull()
    expect(measuredOf({ annotations: { __values__: '{"A":0,"B":0,"C":1}' } })).toBeNull()
  })
  it('falls back to the value string when Grafana sent no values, and prefers the reduced one', () => {
    expect(measuredOf({ value: 'A=22, B=21, C=1' })).toBe('21')
    expect(measuredOf({ value: 'A=0, B=0, C=0' })).toBeNull()
    expect(measuredOf({ value: '62.9% used' })).toBeNull()
  })
})

describe('heroKindOf', () => {
  it('tells the sources apart by origin, channel and label', () => {
    expect(heroKindOf(newEdgeError)).toBe('grafana')
    expect(heroKindOf(sentryIssue)).toBe('sentry')
    expect(heroKindOf(netdataDisk)).toBe('netdata')
    expect(heroKindOf(netdataWebhook)).toBe('netdata')
    expect(heroKindOf(probeDown)).toBe('prober')
    expect(heroKindOf(sweepSentry)).toBe('sweep')
    expect(heroKindOf(routerAlert)).toBe('other')
    // a Grafana alert that arrived by webhook is still Grafana's
    expect(heroKindOf({ origin: 'webhook', rule: 'x', labels: { grafana_folder: 'API alerts' } })).toBe('grafana')
  })
})

// ---- the Markdown renderer ------------------------------------------------------------------------------------------------------

const html = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }))

describe('Markdown: HTML is never injected', () => {
  it('escapes tags, attributes and entities as the text they are', () => {
    const out = html('<script>alert(1)</script> <img src=x onerror=alert(1)> **ok** &amp; <b>bold</b>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('<b>')
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(out).toContain('<strong>ok</strong>')
    expect(out).toContain('&amp;amp;')
  })

  it('links only http(s): a script, data or relative address stays as the text it was written as', () => {
    const out = html('[click](javascript:alert(1)) and [data](data:text/html,x) and [rel](/admin) and [ok](https://watch.example.com/#/i/Disk)')
    expect(out.match(/<a /g)?.length).toBe(1)
    expect(out).toContain('[click](javascript:alert(1))')
    expect(out).toContain('href="https://watch.example.com/#/i/Disk"')
    expect(out).not.toContain('href="javascript')
  })

  it('opens every link in a new tab with noopener noreferrer, and bare addresses are links without the sentence\'s full stop', () => {
    const out = html('See https://grafana.example.com/d/x?viewPanel=7. Then [the runbook](https://wiki.example.com/r).')
    expect(out).toContain('href="https://grafana.example.com/d/x?viewPanel=7"')
    expect(out.match(/rel="noopener noreferrer"/g)?.length).toBe(2)
    expect(out.match(/target="_blank"/g)?.length).toBe(2)
    expect(out).toContain('viewPanel=7<span class="sr-only"> (opens in a new tab)</span></a>. Then')
  })

  it('is written with React elements: no raw-HTML setter exists in the files that draw an alert', () => {
    for (const file of ['../src/web/components/SheetDetail.tsx', '../src/shared/markdown.ts', '../src/web/lib/hero.ts']) {
      expect(read(file)).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML/)
    }
  })
})

describe('Markdown: the subset', () => {
  it('draws bullets, numbers, bold, italics, inline code and fenced blocks as such', () => {
    const out = html('Errors:\n- one **bold** item\n- two with `code` and *italic*\n\n1. first\n2) second\n\n```\nline 1\n<b>raw</b>\n```')
    expect(out).toContain('<ul class="md__list"><li>one <strong>bold</strong> item</li><li>two with <code>code</code> and <em>italic</em></li></ul>')
    expect(out).toContain('<ol class="md__list" data-ordered=""><li>first</li><li>second</li></ol>')
    expect(out).toContain('<pre class="md__code" tabindex="0"><code>line 1\n&lt;b&gt;raw&lt;/b&gt;</code></pre>')
  })

  it('a heading is a bold line, a single line break is kept as one, and a blank line starts a paragraph', () => {
    const out = html('## Why\nit failed\nagain\n\nsecond')
    expect(out).toContain('<p class="md__h">Why</p>')
    expect(out).toContain('<p class="md__p">it failed<br/>again</p>')
    expect(out).toContain('<p class="md__p">second</p>')
  })

  it('leaves snake_case names, stars between spaces and a lone asterisk alone', () => {
    expect(inlineText(parseInline('envoy_http_downstream_rq_xx and 2 * 3 * 4 and 5xx*'))).toBe('envoy_http_downstream_rq_xx and 2 * 3 * 4 and 5xx*')
    expect(parseInline('envoy_http_downstream_rq_xx').every((n) => n.t === 'text')).toBe(true)
    expect(parseInline('https://x.dev/_next/__static__/a').filter((n) => n.t === 'em' || n.t === 'strong')).toEqual([])
  })

  it('reads backslash escapes, unclosed delimiters and nested emphasis without losing text', () => {
    expect(inlineText(parseInline('\\*not italic\\* and **bold *and italic* inside** and `unclosed'))).toBe('*not italic* and bold and italic inside and `unclosed')
  })

  it('bounds the work on hostile text: ten thousand asterisks and brackets read in one pass each', () => {
    const start = Date.now()
    const parsed = parseMarkdown(`${'*a '.repeat(5000)}\n\n${'[x'.repeat(5000)}`)
    expect(parsed.length).toBe(2)
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it('keeps the whole text: the words of every block come back in order', () => {
    const src = 'Lead sentence here. More words follow.\n\n- a\n- b\n\n```\ncode\n```\n\nend'
    const words = parseMarkdown(src).flatMap((b) => (b.t === 'p' || b.t === 'h' ? [inlineText(b.c)] : b.t === 'code' ? [b.v] : b.items.map((i) => inlineText(i.c))))
    expect(words).toEqual(['Lead sentence here. More words follow.', 'a', 'b', 'code', 'end'])
  })
})

// ---- the lead line and the fold ------------------------------------------------------------------------------------------------

/** The description that screenshot shows (Grafana, Ops errors): one 1500 character paragraph. */
const WALL_OF_TEXT =
  'A sustained step in the error rate of one family (owner `ours` of the ops board (scripts/ops/issue-sql.mjs eventsSql: a 5xx that is not a designed answer, a failed turn behind an HTTP 200, a stream cut by a shutdown, a dial that ended in a network error, an upstream 5xx or an empty completion)), real traffic only (the team and test accounts of test-accounts.json and every bench device are out; anonymous devices count as people), over the last 3 hours against the same 3 hours on each of the past 7 days. ' +
  'Fires when the Wilson lower bound (z 1.96) of the 3 hour rate AND of the last hour\'s rate (so it resets within an hour of the end) is at least the largest of 3x the baseline rate (median of the 7 same-clock rates, floored by the rule of three), 0.5x the family\'s SLO error budget and median + 3.5 x 1.4826 x MAD of the 7 rates (Iglewicz and Hoaglin\'s modified z, NIST handbook 1.3.5.17: error rates are not normal, so no plain z-score), with 8+ failures and 200+ requests in the 3 hours (3+ in the last hour) from 2+ people, for 30 minutes. ' +
  'The slow, low-floor sibling of reg-user-error-spike: it sees a mild but lasting step that the page rule\'s volume floors do not. ' +
  'Where to look: the panel "Worst family: error rate vs usual (3 h)" of the Regressions board, then The ops board (/d/api-ops/?var-traffic=real: Scoreboard and Issues) lists the same failures with route, class and sample request id.'

describe('scanOf: a lead line and the rest behind "More"', () => {
  it('takes the first sentence as the lead and keeps a short text open', () => {
    const scan = scanOf('The helper stopped answering. Nothing was lost. Restart it.')
    expect(scan.fold).toBe(false)
    expect(scan.lead && scan.lead.t === 'p' ? inlineText(scan.lead.c) : '').toBe('The helper stopped answering.')
    expect(scan.rest.map((b) => (b.t === 'p' ? inlineText(b.c) : ''))).toEqual(['Nothing was lost. Restart it.'])
  })

  it('folds the rest exactly past the threshold: 280 characters stay open, 281 fold', () => {
    const body = (n: number): string => `First sentence here. ${'X'.repeat(n - 'First sentence here. '.length - 1)}.`
    expect(body(FOLD_AFTER).length).toBe(FOLD_AFTER)
    expect(scanOf(body(FOLD_AFTER)).fold).toBe(false)
    expect(scanOf(body(FOLD_AFTER + 1)).fold).toBe(true)
  })

  it('folded, the rest is one sentence to a line and nothing is dropped or reworded', () => {
    const scan = scanOf(WALL_OF_TEXT)
    expect(scan.fold).toBe(true)
    const lead = scan.lead && scan.lead.t === 'p' ? inlineText(scan.lead.c) : ''
    const rest = scan.rest.map((b) => (b.t === 'p' ? inlineText(b.c) : ''))
    expect(rest.length).toBeGreaterThan(3)
    expect(rest.every((s) => s !== '')).toBe(true)
    expect(`${lead} ${rest.join(' ')}`.replace(/\s+/g, ' ')).toBe(inlineText(parseMarkdown(WALL_OF_TEXT).flatMap((b) => (b.t === 'p' ? b.c : []))).replace(/\s+/g, ' '))
  })

  it('cuts a lead that runs past a glance at its first clause: a real description leads with its subject', () => {
    const scan = scanOf(WALL_OF_TEXT)
    expect(scan.lead && scan.lead.t === 'p' ? inlineText(scan.lead.c) : '').toBe('A sustained step in the error rate of one family')
  })

  it('does not end a sentence at e.g., a version, a path or a decimal', () => {
    const raw = 'Check the panel, e.g. the Regressions board at v1.0.14 or scripts/ops/issue-sql.mjs: 4.5 failures an hour. Then ack it.'
    expect(raw.slice(0, leadEnd(raw)).trim()).toBe('Check the panel, e.g. the Regressions board at v1.0.14 or scripts/ops/issue-sql.mjs: 4.5 failures an hour.')
    expect(sentencesOf(raw)).toHaveLength(2)
  })

  it('treats a line break as the end of a lead, and a text that starts with a list as already scannable', () => {
    const lines = scanOf('Disk is full on node-4\nIt fills at 5 GiB an hour\nRestart nothing.')
    expect(lines.lead && lines.lead.t === 'p' ? inlineText(lines.lead.c) : '').toBe('Disk is full on node-4')
    const list = scanOf('- one\n- two\n- three')
    expect(list.lead).toBeNull()
    expect(list.fold).toBe(false)
    expect(list.rest).toHaveLength(1)
    expect(scanOf('')).toEqual({ lead: null, rest: [], fold: false })
  })

  it('a short Markdown text keeps its bullets open under the lead; a long one folds them', () => {
    const short = scanOf('**Errors up for hours.**\n- 503 on /v1/messages\n- 3 events')
    expect(short.fold).toBe(false)
    expect(short.rest[0].t).toBe('list')
    const long = scanOf(`**Errors up for hours.** ${'More detail. '.repeat(30)}\n- 503 on /v1/messages`)
    expect(long.fold).toBe(true)
  })
})

describe('the sheet parts as markup', () => {
  it('WhatHappened draws the lead, then "More" as a native disclosure for a long text, and no disclosure for a short one', () => {
    const long = renderToStaticMarkup(createElement(WhatHappened, { text: WALL_OF_TEXT }))
    expect(long).toContain('<p class="md__lead">A sustained step in the error rate of one family</p>')
    expect(long).toContain('<details class="md__more"><summary>')
    expect(long).toContain('More<span class="sr-only"> of what happened</span>')
    expect(long).not.toContain('<details class="md__more" open')
    const short = renderToStaticMarkup(createElement(WhatHappened, { text: 'The source sent no description. Everything it did send is under Labels and Raw below.' }))
    expect(short).toContain('<p class="md__lead">The source sent no description.</p>')
    expect(short).not.toContain('<details')
  })

  it('WhatHappened escapes alert HTML in the lead and in the folded rest', () => {
    const out = renderToStaticMarkup(createElement(WhatHappened, { text: `<img src=x onerror=alert(1)> broke. ${'<script>x</script> more. '.repeat(20)}` }))
    expect(out).not.toMatch(/<img|<script/)
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('ErrorHero draws the error, its facts as one list and a Copy control, and escapes the text', () => {
    const hero = heroOf(newEdgeError)
    if (!hero) throw new Error('no hero')
    const out = renderToStaticMarkup(createElement(ErrorHero, { hero, severity: 'warning' }))
    expect(out).toContain('<p class="hero__line">503 server_shutdown</p>')
    expect(out).toContain('data-tone="warning"')
    expect(out).toContain('<dt>Route</dt><dd>POST /v1/chat/completions</dd>')
    expect(out).toContain('Copy')
    const hostile = renderToStaticMarkup(createElement(ErrorHero, { hero: { ...hero, line: '<script>alert(1)</script>', facts: [{ name: '<b>', value: '<i>' }] }, severity: 'page' }))
    expect(hostile).not.toMatch(/<script|<b>|<i>/)
  })
})

describe('the look: the sheet stays on its tokens', () => {
  const css = read('../src/web/styles/sheet-detail.css')
  it('declares no hex literal and no number that is not a token, a zero or a full width', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[a-z-]+:[^;{}]+;/g) ?? []
    for (const d of declarations) {
      const value = d.slice(d.indexOf(':') + 1)
      const bare = value.replace(/var\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '')
      // a zero, a flex factor of 1 and a full width are not sizes
      expect((bare.match(/\d+(?:\.\d+)?(?:px|rem|em|ms|s|%|deg)?/g) ?? []).filter((n) => !['0', '1', '100%'].includes(n)), d).toEqual([])
    }
  })
  it('uses the two radii and nothing else, and no shadow, gradient, blur or uppercase', () => {
    const radii = [...css.matchAll(/border-radius:\s*([^;]+);/g)].map((m) => m[1].trim())
    expect([...new Set(radii)].sort()).toEqual(['var(--radius-16)', 'var(--radius-8)'])
    expect(css).not.toMatch(/box-shadow|gradient|blur\(|backdrop-filter|text-transform|border-left|border-inline-start/)
  })
  it('guards its one transition for reduced motion, in its own file', () => {
    expect(css).toMatch(/transition:/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none/)
  })
  it('has no em dash in its copy, its comments or its code', () => {
    for (const file of ['../src/web/styles/sheet-detail.css', '../src/web/components/SheetDetail.tsx', '../src/web/lib/hero.ts', '../src/shared/markdown.ts']) {
      expect(read(file).includes('—'), file).toBe(false)
    }
  })
  it('wires the hero under the title and actions and What happened through the Markdown scan', () => {
    const sheets = read('../src/web/components/Sheets.tsx')
    expect(sheets).toMatch(/heroOf\(lead, title\)/)
    expect(sheets).toMatch(/<ErrorHero hero=\{hero\}/)
    expect(read('../src/web/components/StorySheet.tsx')).toMatch(/<WhatHappened text=/)
    expect(read('../src/web/styles/index.css')).toContain("@import './sheet-detail.css';")
  })
})
