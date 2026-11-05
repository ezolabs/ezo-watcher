import { describe, expect, it } from 'vitest'
import { MAX_OUTPUT_CHARS, cleanOutput, humanizeName, shortHost, stepsOf, storyOf, tileStory } from '../src/shared/story.ts'
import type { StorySource } from '../src/shared/story.ts'
import { descriptionLead } from '../src/shared/markdown.ts'
import { parseSweepRecord } from '../src/shared/sweep-record.ts'

const TOPIC = 'https://chat.example.com/#narrow/channel/8-triage/topic/sweep.202026-10-15'

/** The regression sweep as it sends today: no headline, no where, no evidence_output, no action. */
const sweepToday: StorySource = {
  origin: 'sweep',
  rule: 'IntakeBugReport',
  service: 'sweep',
  host: '',
  labels: { alertname: 'IntakeBugReport', severity: 'warning', layer: 'feedback', sweep_sev: 'S2', probe: 'intake', source: 'bug_report' },
  annotations: {
    summary: 'bug_report: desktop:1b9aa85f',
    description: 'agent_group=auto:helper-wedged:status-probe-unresponsive:unexpected_error pending=1/5 source=desktop v1.0.12 win32 commit=52741e5b8',
    probe: 'read-one.sh br_mv90r5d4_a152a0f1',
    triage: TOPIC,
    report_url: `${TOPIC}/near/90`,
    evidence: 'read-one.sh br_mv90r5d4_a152a0f1',
    source: 'sweep (Mac LaunchAgent, 4 runs a day)'
  }
}

/** The same finding once the sweep sends everything the story reads. */
const sweepFull: StorySource = {
  origin: 'sweep',
  rule: 'IntakeBugReport',
  service: 'Acme desktop app',
  host: 'desktop',
  labels: { alertname: 'IntakeBugReport', severity: 'warning', layer: 'feedback', host: 'desktop', service: 'Acme desktop app', env: 'prod' },
  annotations: {
    headline: 'Desktop Helper stopped answering its status probe',
    summary: 'bug_report: desktop:1b9aa85f',
    what_happened: 'The Desktop Helper stopped answering its status probe.\n\nThe helper process did not respond in time and was marked unhealthy.',
    description: 'agent_group=auto:helper-wedged pending=1/5',
    where: 'acme desktop app v1.0.12, Windows, commit 52741e5',
    evidence: 'read-one.sh br_mv90r5d4_a152a0f1',
    evidence_output: 'exit code: 1\nno response from helper\nprobe timed out after 30s\n',
    action: '1. Restart the Desktop Helper.\n2) If it keeps failing, check recent logs for errors.\n- Ack when it is fixed.',
    runbook_url: 'https://wiki.example.com/runbooks/desktop-helper',
    report_url: `${TOPIC}/near/90`
  }
}

/** A Grafana alert: values, a generatorURL, an instance with a port, a job and a component. */
const grafana: StorySource = {
  origin: 'grafana',
  rule: 'API ClickHouse disk at 80%',
  service: 'ClickHouse',
  host: 'prod-node-2',
  value: 'B=77.2, C=1',
  generatorURL: 'https://grafana.example.com/alerting/grafana/api-disk-80/view?orgId=1',
  labels: { alertname: 'API ClickHouse disk at 80%', component: 'clickhouse-disk', disk: 'default', instance: 'prod-node-2:9363', severity: 'warn', job: 'clickhouse' },
  annotations: {
    summary: 'ClickHouse disk default is 77.2% full',
    description: 'system.disks reports at least 80% used on default.',
    runbook_url: 'https://runbooks.example.com/clickhouse-disk',
    __values__: '{"B":77.2,"C":1}'
  }
}

/** A router Alertmanager v4 alert: summary, description, runbook_url, a label-set for an instance, an in-cluster generatorURL. */
const router: StorySource = {
  origin: 'prod',
  rule: 'ApiTokenizationDivergence',
  service: 'API router',
  host: '',
  labels: { alertname: 'ApiTokenizationDivergence', severity: 'ticket', instance: 'backend=di9-dev, model_version=deepseek-v4', namespace: 'prod', backend: 'di9-dev' },
  generatorURL: 'http://api-vmalert-5d6d58b7f8-pntzl:8880/vmalert/alert?group_id=1&alert_id=2',
  annotations: {
    summary: "more than half of a backend's cached prompt tokens were never predicted by the router's mirror",
    description: "The router's page chain is not the engine's.",
    runbook_url: 'https://wiki.example.com/runbooks/tokenization'
  }
}

/** The node-2 prober: component uptime, the target as the instance, one summary sentence. */
const prober: StorySource = {
  origin: 'api-uptime',
  rule: 'ProbeDown',
  service: 'Uptime',
  host: 'chat.example.com',
  labels: { alertname: 'ProbeDown', instance: 'chat.example.com', severity: 'page', component: 'uptime' },
  annotations: { summary: 'chat.example.com failed its node-2 uptime check' }
}

describe('a sweep alert as it sends today', () => {
  const s = storyOf(sweepToday)

  it('titles the tile with the summary, because no headline came, and keeps the alertname as the caption', () => {
    expect(s.headline).toBe('bug_report: desktop:1b9aa85f')
    expect(s.headlineFrom).toBe('summary')
    expect(s.caption).toBe('IntakeBugReport')
  })

  it('badges the source system when there is no host, env or namespace, and the layer is the breadcrumb', () => {
    expect(s.badge).toEqual({ text: 'sweep', kind: 'system' })
    expect(s.crumbs).toEqual([{ part: 'component', text: 'feedback' }])
  })

  it('tells what happened with the description, whole', () => {
    expect(s.what.from).toBe('description')
    expect(s.what.paragraphs).toEqual([sweepToday.annotations?.description])
  })

  it('builds the location line from the labels when the sender gave no where', () => {
    expect(s.where).toBe('Layer feedback. Raised by sweep.')
    expect(s.chips.map((c) => [c.kind, c.text])).toEqual([['component', 'feedback'], ['source', 'sweep']])
  })

  it('shows the command, no output, and the command as the tile line because the summary is the headline', () => {
    expect(s.evidence.command).toBe('read-one.sh br_mv90r5d4_a152a0f1')
    expect(s.evidence.output).toBeUndefined()
    expect(s.line).toEqual({ text: 'read-one.sh br_mv90r5d4_a152a0f1', kind: 'command' })
  })

  it('has no steps, no runbook, and sends both chat links to the bottom line, never to a button section', () => {
    expect(s.steps).toEqual([])
    expect(s.links.runbook).toEqual([])
    expect(s.links.chat.map((l) => l.label)).toEqual(['Report in #triage', 'Topic in #triage'])
    expect(s.links.source).toEqual([])
  })
})

describe('a sweep alert with every new field', () => {
  const s = storyOf(sweepFull)

  it('uses the headline as the title and keeps the summary as the tile line when no output came', () => {
    expect(s.headline).toBe('Desktop Helper stopped answering its status probe')
    expect(s.headlineFrom).toBe('headline')
    expect(storyOf({ ...sweepFull, annotations: { ...sweepFull.annotations, evidence_output: '' } }).line).toEqual({ text: 'bug_report: desktop:1b9aa85f', kind: 'summary' })
  })

  it('uses what_happened in paragraphs, not the description', () => {
    expect(s.what.from).toBe('what_happened')
    expect(s.what.paragraphs).toEqual(['The Desktop Helper stopped answering its status probe.', 'The helper process did not respond in time and was marked unhealthy.'])
  })

  it('badges the host, then system / service / component, once each', () => {
    expect(s.badge).toEqual({ text: 'desktop', kind: 'host' })
    expect(s.crumbs).toEqual([
      { part: 'system', text: 'sweep' },
      { part: 'service', text: 'Acme desktop app' },
      { part: 'component', text: 'feedback' }
    ])
    expect(s.chips.map((c) => [c.kind, c.text])).toEqual([['host', 'desktop'], ['service', 'Acme desktop app'], ['env', 'prod'], ['component', 'feedback'], ['source', 'sweep']])
  })

  it('says where in the sender words', () => {
    expect(s.where).toBe('acme desktop app v1.0.12, Windows, commit 52741e5')
  })

  it('shows the command and the captured output, and the first output line is the tile line', () => {
    expect(s.evidence.command).toBe('read-one.sh br_mv90r5d4_a152a0f1')
    expect(s.evidence.output).toBe('exit code: 1\nno response from helper\nprobe timed out after 30s')
    expect(s.evidence.clipped).toBe(false)
    expect(s.line).toEqual({ text: 'exit code: 1', kind: 'output' })
  })

  it('numbers the steps itself, so a leading number or bullet is dropped', () => {
    expect(s.steps).toEqual(['Restart the Desktop Helper.', 'If it keeps failing, check recent logs for errors.', 'Ack when it is fixed.'])
    expect(s.links.runbook.map((l) => l.label)).toEqual(['Runbook'])
    expect(s.links.chat.map((l) => l.label)).toEqual(['Report in #triage'])
  })
})

describe('a Grafana alert', () => {
  const s = storyOf(grafana)

  it('shows the firing values and the threshold the rule text states', () => {
    expect(s.evidence.values).toEqual([{ name: 'B', value: '77.2' }, { name: 'C', value: '1' }])
    expect(s.evidence.threshold).toBe('at least 80%')
    // the summary is the headline, so the tile line is the rule's own sentence, then the values when there is none
    expect(s.line).toEqual({ text: 'system.disks reports at least 80% used on default.', kind: 'description' })
    expect(storyOf({ ...grafana, annotations: { ...grafana.annotations, description: '' } }).line).toEqual({ text: 'B=77.2, C=1', kind: 'value' })
  })

  it('opens the source as a secondary link inside Evidence and keeps the runbook for What to do', () => {
    expect(s.links.source.map((l) => l.label)).toEqual(['Open in Grafana'])
    expect(s.links.runbook.map((l) => l.url)).toEqual(['https://runbooks.example.com/clickhouse-disk'])
  })

  it('badges the host without its port, the service group and the component', () => {
    expect(s.badge).toEqual({ text: 'prod-node-2', kind: 'host' })
    expect(s.crumbs).toEqual([
      { part: 'system', text: 'Grafana' },
      { part: 'service', text: 'ClickHouse' },
      { part: 'component', text: 'clickhouse-disk' }
    ])
    expect(s.where).toBe('ClickHouse, component clickhouse-disk, host prod-node-2. Raised by Grafana.')
  })

  it('reads the values from the value string when the annotation is absent, and takes an explicit threshold over the rule text', () => {
    const bare = storyOf({ ...grafana, annotations: { summary: 'x', threshold: '> 90' } })
    expect(bare.evidence.values).toEqual([{ name: 'B', value: '77.2' }, { name: 'C', value: '1' }])
    expect(bare.evidence.threshold).toBe('> 90')
    expect(storyOf({ ...grafana, value: '81%', annotations: { summary: 'x' } }).evidence.values).toEqual([{ name: 'Value', value: '81%' }])
  })
})

describe('a router Alertmanager v4 alert', () => {
  const s = storyOf(router)

  it('does not mistake a label set for a hostname, so it badges the namespace', () => {
    expect(s.badge).toEqual({ text: 'prod', kind: 'env' })
    expect(s.where).toBe("API router, instance backend=di9-dev, model_version=deepseek-v4, namespace prod. Raised by prod.")
  })

  it('tells what happened with the description and shows the runbook as a What to do control, with no evidence invented', () => {
    expect(s.headlineFrom).toBe('summary')
    expect(s.what.from).toBe('description')
    expect(s.links.runbook.map((l) => l.label)).toEqual(['Runbook'])
    expect(s.evidence.command).toBeUndefined()
    expect(s.evidence.values).toEqual([])
    // an in-cluster generatorURL (no dot in its host) is not a link nobody can open
    expect(s.links.source).toEqual([])
  })

  it('uses the description as the tile line, since the summary is the headline and there is no command', () => {
    expect(s.line).toEqual({ text: "The router's page chain is not the engine's.", kind: 'description' })
  })
})

describe('an node-2 prober alert', () => {
  const s = storyOf(prober)

  it('badges the target and leads the breadcrumb with the prober, with the component folded into the service it equals', () => {
    expect(s.headline).toBe('chat.example.com failed its node-2 uptime check')
    expect(s.badge).toEqual({ text: 'chat.example.com', kind: 'host' })
    expect(s.crumbs).toEqual([{ part: 'system', text: 'api-uptime' }, { part: 'service', text: 'Uptime' }])
  })

  it('still tells a story with nothing but a summary: a sentence that says so, a location, no empty evidence', () => {
    expect(s.what.from).toBe('none')
    expect(s.what.paragraphs[0]).toContain('no description')
    expect(s.where).toBe('Uptime, host chat.example.com. Raised by api-uptime.')
    expect(s.evidence).toEqual({ command: undefined, output: undefined, clipped: false, values: [], threshold: undefined })
    expect(s.line).toBeNull()
    expect(s.steps).toEqual([])
  })
})

describe('a sweep alert whose runbook and evidence are one URL (a Sentry issue)', () => {
  const sentry: StorySource = {
    origin: 'sweep',
    rule: 'IntakeSentryHelper',
    service: 'Helper',
    labels: { alertname: 'IntakeSentryHelper', layer: 'helper', service: 'helper', env: 'prod' },
    annotations: {
      summary: 'sentry_helper: node:Error:Module._resolveFilename(loader) x819',
      headline: 'Helper error seen 819 times: node:Error:Module._resolveFilename(loader)',
      action: 'Read the stack trace and the affected releases on the Sentry issue (link under Evidence).',
      runbook_url: 'https://example.sentry.io/issues/7790254085/',
      evidence_url: 'https://example.sentry.io/issues/7790254085/',
      evidence_output: '!sentry_helper | 7790254085 | 2026-10-15T10:46:35.870000Z | node:Error:Module._resolveFilename(loader)'
    }
  }

  it('shows the URL once, under Evidence, as the action says, and leaves What to do with its steps and no runbook control', () => {
    const s = storyOf(sentry)
    expect(s.links.evidence.map((l) => [l.label, l.url])).toEqual([['Open the evidence', 'https://example.sentry.io/issues/7790254085/']])
    expect(s.links.runbook).toEqual([])
    expect(s.steps).toHaveLength(1)
    expect(s.evidence.command).toBeUndefined()
    expect(s.line?.kind).toBe('output')
  })

  it('keeps a different runbook where it was', () => {
    const s = storyOf({ ...sentry, annotations: { ...sentry.annotations, runbook_url: 'https://wiki.example.com/runbooks/helper' } })
    expect(s.links.runbook.map((l) => l.label)).toEqual(['Runbook'])
    expect(s.links.evidence.map((l) => l.label)).toEqual(['Open the evidence'])
  })
})

describe('an alert with nothing but an alertname', () => {
  it('reads the alertname as words and names the host when it has one', () => {
    expect(storyOf({ rule: 'HostDiskFull' }).headline).toBe('Host disk full')
    expect(storyOf({ rule: 'HostDiskFull', host: 'node-5' }).headline).toBe('Host disk full on node-5')
  })
  it('still has a badge, a location and a sentence', () => {
    const s = storyOf({ rule: 'x' })
    expect(s.badge.kind).toBe('system')
    expect(s.where).toBe('Raised by an unnamed source.')
    expect(s.what.paragraphs).toHaveLength(1)
  })
})

describe('the tile of one incident', () => {
  it('names the worst instance, leaves the count to the tile, and counts hosts when they differ', () => {
    const t = tileStory([{ ...grafana, host: 'node-5' }, { ...grafana, host: 'node-6' }, { ...grafana, host: 'node-4' }], { rule: 'FleetDisk' })
    expect(t.headline).toBe('ClickHouse disk default is 77.2% full')
    expect(t.badge).toEqual({ text: '3 hosts', kind: 'host' })
    expect(t.more).toBe(2)
  })

  it('leads a split incident that has only an alertname with its target', () => {
    const t = tileStory([{ origin: 'api-uptime', rule: 'ProbeDown', labels: { instance: 'chat.example.com' } }], { rule: 'ProbeDown', instance: 'chat.example.com' })
    expect(t.headline).toBe('chat.example.com: probe down')
    expect(t.badge.text).toBe('chat.example.com')
  })

  it('keeps the sender summary for a split incident, which already leads with its target', () => {
    expect(tileStory([prober], { rule: 'ProbeDown', instance: 'chat.example.com' }).headline).toBe('chat.example.com failed its node-2 uptime check')
  })
})

describe('the small readers', () => {
  it('reads an alertname as words', () => {
    expect(humanizeName('IntakeBugReport')).toBe('Intake bug report')
    expect(humanizeName('ProbeDown')).toBe('Probe down')
    expect(humanizeName('HTTPErrorRate')).toBe('HTTP error rate')
    expect(humanizeName('node_disk_high')).toBe('Node disk high')
    expect(humanizeName('API ClickHouse disk at 80%')).toBe('API ClickHouse disk at 80%')
  })

  it('reads a pod name as its workload and leaves a hostname whole', () => {
    expect(shortHost('api-router-7f9c8d6b5-xk2lp')).toBe('api-router')
    expect(shortHost('node-exporter-x7k9z')).toBe('node-exporter')
    expect(shortHost('prod-node-2')).toBe('prod-node-2')
    expect(shortHost('chat.example.com')).toBe('chat.example.com')
    expect(shortHost('prometheus-0')).toBe('prometheus-0')
  })

  it('splits steps one per line and drops bullets and numbers', () => {
    expect(stepsOf('1. a\n2) b\n- c\n\n  * d\n•  e')).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(stepsOf(undefined)).toEqual([])
  })

  it('cuts output at 4 KB on a line end and strips control characters', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n')
    const cut = cleanOutput(lines)
    expect(cut.clipped).toBe(true)
    expect(cut.text.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS)
    expect(lines.startsWith(cut.text)).toBe(true)
    expect(lines.charAt(cut.text.length)).toBe('\n')
    expect(cleanOutput('a\u0000b\r\nc\u001b[0m').text).toBe('ab\nc[0m')
  })
})

// The two regression rules as Grafana sends them on watch.example.com (2026-10-15, release 20261016T002254Z-27b2971): a bold lead, a list, one more paragraph.
const NEW_EDGE_ERROR =
  '**New edge error `Model API (door) | POST /v1/chat/completions | 503 | server_shutdown`, first seen 10-15 21:01 UTC**\n\n- **Changed:** this failure class had no event in the 14 days before the last 4 h and has some now.\n- **Affected:** ours (5xx, a failed turn behind a 200): 3+ events from 2+ requests. Caller 4xx and auth: 5+ events from 2+ people.\n- **Look:** Regressions board panel "New error signatures: first seen in this range" (the alert link opens it), or the Ops issues table at state NEW.\n\nHow it decides: a never-seen failure class (family | METHOD route | status | class) clears the floors, and the alert lasts 4 h from its first event.'
const BACK_AFTER_SILENCE =
  '**Error back after 86 h of silence: edge `Model API pass-through | POST api credits | 503 | server_shutdown`**\n\n- **Changed:** it had events in the 14 days before, was silent 72+ h, and came back at 10-15 21:01 UTC.\n- **Affected:** 3+ real events from 2+ requests (edge classes: only ours).\n- **Look:** Regressions board panel "Error signatures that came back after 3+ days of silence", or the Ops issues table at state REGRESSED.\n\nHow it decides: a known signature silent for 72+ h clears the same floors as a new one, and the alert lasts 4 h.'

/** A Grafana regression alert: the summary is the headline, nothing else speaks, so the tile line is the description. */
const regression = (summary: string, description: string): StorySource => ({
  origin: 'grafana',
  rule: 'New error signature at the edge (first seen, 4 h)',
  labels: { alertname: 'New error signature at the edge (first seen, 4 h)', severity: 'warn' },
  annotations: { summary, description }
})

describe('the lead of a Markdown description', () => {
  it('is the first block as plain text: the bold lead of a regression rule with its code span, no marks and none of the list', () => {
    expect(descriptionLead(NEW_EDGE_ERROR)).toBe('New edge error Model API (door) | POST /v1/chat/completions | 503 | server_shutdown, first seen 10-15 21:01 UTC')
    expect(descriptionLead(BACK_AFTER_SILENCE)).toBe('Error back after 86 h of silence: edge Model API pass-through | POST api credits | 503 | server_shutdown')
  })

  it('is the first list item when the text opens with a list, a heading\'s words or the first line of code when it opens with those', () => {
    expect(descriptionLead('- **Changed:** the pager stopped.\n- **Affected:** all of it.\n\nHow it decides: x')).toBe('Changed: the pager stopped.')
    expect(descriptionLead('1. first step\n2. second step')).toBe('first step')
    expect(descriptionLead('## Disk full\nfree some space')).toBe('Disk full')
    expect(descriptionLead('```\n\nexit code: 1\nmore\n```\nafter')).toBe('exit code: 1')
  })

  it('takes the markup off inline code, links, bold, italics and escapes, keeps the words of a link, and joins a wrapped block with spaces', () => {
    expect(descriptionLead('See [the board](https://grafana.example.com/d/x?viewPanel=7) for `edge_5xx` and **bold** and _it_ and \\*star\\*. More text follows.')).toBe(
      'See the board for edge_5xx and bold and it and *star*. More text follows.'
    )
    expect(descriptionLead('Disk full on node-4\nfree some space\n\nsecond paragraph')).toBe('Disk full on node-4 free some space')
  })

  it('is empty for an empty description, whitespace or a missing one', () => {
    expect(descriptionLead('')).toBe('')
    expect(descriptionLead('  \n\n \t')).toBe('')
  })
})

describe('the tile line of a Markdown description', () => {
  const headline = 'New edge error Model API (door) | POST /v1/chat/completions | 503 | server_shutdown: 3 events since 10-15 21:01 UTC'

  it('reads the real regression descriptions as their lead, not as raw Markdown with the list flattened after it', () => {
    expect(storyOf(regression(headline, NEW_EDGE_ERROR)).line).toEqual({
      text: 'New edge error Model API (door) | POST /v1/chat/completions | 503 | server_shutdown, first seen 10-15 21:01 UTC',
      kind: 'description'
    })
    expect(storyOf(regression('Back after 86 h of silence: edge Model API pass-through (10 events)', BACK_AFTER_SILENCE)).line).toEqual({
      text: 'Error back after 86 h of silence: edge Model API pass-through | POST api credits | 503 | server_shutdown',
      kind: 'description'
    })
    const tile = tileStory([regression(headline, NEW_EDGE_ERROR)], { rule: 'x' })
    expect(tile.line?.text).not.toMatch(/\*\*|`|Changed|Affected/)
  })

  it('keeps plain prose as it was: the first sentence, and a wrapped or two-line description joined', () => {
    expect(storyOf(regression('Disk full on node-4', 'Disk is full on node-4. Free some space.')).line?.text).toBe('Disk is full on node-4.')
    expect(storyOf(regression('Disk full on node-4', 'system.disks reports at least 80% used\non default. Check the cron.')).line?.text).toBe('system.disks reports at least 80% used on default.')
    expect(storyOf(regression('Disk full on node-4', 'no full stop here')).line?.text).toBe('no full stop here')
  })

  it('cuts the first sentence of a lead that opens a list, and of an inline-code lead', () => {
    expect(storyOf(regression('Disk full on node-4', '- **Changed:** the pager stopped. It is back.\n- **Affected:** all')).line?.text).toBe('Changed: the pager stopped.')
    expect(storyOf(regression('Disk full on node-4', 'The `edge_5xx` rate is up. Look at [the board](https://grafana.example.com/d/x).')).line?.text).toBe('The edge_5xx rate is up.')
  })

  it('still clips a long lead at the same limit, on a word, with no mark in it', () => {
    const long = `**${'a stretch of words '.repeat(30).trim()}**\n\n- more`
    const line = storyOf(regression('Disk full on node-4', long)).line
    expect(line?.kind).toBe('description')
    expect(line!.text.length).toBeLessThanOrEqual(203)
    expect(line!.text.endsWith('...')).toBe(true)
    expect(line!.text).not.toContain('*')
  })

  it('shows no description line when the lead is the headline, or the description is empty: the value, else nothing', () => {
    expect(storyOf(regression('Disk full on node-4', '**Disk full on node-4**\n\n- **Changed:** x')).line).toBeNull()
    expect(storyOf({ ...regression('Disk full on node-4', ''), value: 'B=77.2' }).line).toEqual({ text: 'B=77.2', kind: 'value' })
    expect(storyOf(regression('Disk full on node-4', '  \n ')).line).toBeNull()
  })
})

// The regression sweep's Sentry record as the live mobile alert carries it (watch.example.com, 2026-10-15): the first line of its captured output.
const MOBILE_RECORD =
  'sentry_mobile | 7739867797 | 2026-10-15T21:17:47.484000Z | cocoa:MXDiskWriteException: | APP-MOBILE-J warning ongoing status=unresolved project=acme-mobile count=2 users=1 v1.0.14+7520 app_build=7520 lastSeen=2026-10-15T21:17:47.484000Z release_last_seen=2026-10-15T21:17:47Z build=e858e261~ built=2026-10-15 behind=77'

const sweepMobile = (over: Record<string, string> = {}): StorySource => ({
  origin: 'sweep',
  rule: 'IntakeSentryMobile',
  labels: { alertname: 'IntakeSentryMobile', severity: 'warning', layer: 'clients', sweep_key: 'intake/sentry_mobile/7739867797', source: 'sentry_mobile', service: 'mobile app' },
  annotations: {
    summary: 'sentry_mobile: cocoa:MXDiskWriteException: x2',
    headline: 'Mobile app error seen 2 times: cocoa:MXDiskWriteException:',
    evidence_output: MOBILE_RECORD,
    ...over
  }
})

describe('the sweep record reader', () => {
  it('splits source, id, time, title and detail, and takes the colon the sweep leaves off the title', () => {
    expect(parseSweepRecord(MOBILE_RECORD)).toMatchObject({ source: 'sentry_mobile', id: '7739867797', at: '2026-10-15T21:17:47.484000Z', title: 'cocoa:MXDiskWriteException' })
    expect(parseSweepRecord(MOBILE_RECORD)?.detail.startsWith('APP-MOBILE-J warning ongoing status=unresolved')).toBe(true)
    expect(parseSweepRecord('!sentry_helper | 7790254085 | 2026-10-15T10:46:35.870000Z | node:Error:Module._resolveFilename(loader)')).toEqual({
      source: '!sentry_helper',
      id: '7790254085',
      at: '2026-10-15T10:46:35.870000Z',
      title: 'node:Error:Module._resolveFilename(loader)',
      detail: ''
    })
  })

  it('is null for any other line: no ISO time in the third column, too few columns, an empty title', () => {
    expect(parseSweepRecord('exit code: 1')).toBeNull()
    expect(parseSweepRecord('cpu | load | high | alert | x')).toBeNull()
    expect(parseSweepRecord('a | b | 2026-10-15T10:46:35Z')).toBeNull()
    expect(parseSweepRecord('a | b | 2026-10-15T10:46:35Z | : | x')).toBeNull()
  })
})

describe('the tile line of a sweep record', () => {
  it('is the title of the live mobile record: no pipes, no id, no time stamp, none of the detail', () => {
    const line = storyOf(sweepMobile()).line
    expect(line).toEqual({ text: 'cocoa:MXDiskWriteException', kind: 'output' })
    expect(line!.text).not.toMatch(/\||7739867797|2026-|APP-MOBILE/)
    expect(tileStory([sweepMobile()], { rule: 'IntakeSentryMobile' }).line).toEqual({ text: 'cocoa:MXDiskWriteException', kind: 'output' })
  })

  it('adds the detail only when it has words of its own, never its id, level, status, version or key=value pairs', () => {
    const prose = MOBILE_RECORD.replace('APP-MOBILE-J warning ongoing', 'APP-MOBILE-J the volume is read-only')
    expect(storyOf(sweepMobile({ evidence_output: prose })).line?.text).toBe('cocoa:MXDiskWriteException: the volume is read-only')
    const repeated = MOBILE_RECORD.replace('APP-MOBILE-J warning ongoing', 'APP-MOBILE-J MXDiskWriteException')
    expect(storyOf(sweepMobile({ evidence_output: repeated })).line?.text).toBe('cocoa:MXDiskWriteException')
  })

  it('reads a bare record, with no detail column, as its title too', () => {
    const bare = '!sentry_helper | 7790254085 | 2026-10-15T10:46:35.870000Z | node:Error:Module._resolveFilename(loader)'
    expect(storyOf(sweepMobile({ evidence_output: bare })).line).toEqual({ text: 'node:Error:Module._resolveFilename(loader)', kind: 'output' })
  })

  it('leaves an output line that is not a record exactly as it was, pipes and all', () => {
    expect(storyOf(sweepMobile({ evidence_output: 'exit code: 1\nno response from helper' })).line).toEqual({ text: 'exit code: 1', kind: 'output' })
    expect(storyOf(sweepMobile({ evidence_output: 'cpu | load | high | alert | x' })).line).toEqual({ text: 'cpu | load | high | alert | x', kind: 'output' })
    expect(storyOf(sweepMobile({ evidence_output: 'a | b | not-a-time | title | detail' })).line?.text).toBe('a | b | not-a-time | title | detail')
  })

  it('moves to the next evidence branch when the record title is the headline: the summary, else nothing', () => {
    expect(storyOf(sweepMobile({ headline: 'cocoa:MXDiskWriteException' })).line).toEqual({ text: 'sentry_mobile: cocoa:MXDiskWriteException: x2', kind: 'summary' })
    expect(storyOf(sweepMobile({ headline: '', summary: 'cocoa:MXDiskWriteException' })).line).toBeNull()
  })
})
