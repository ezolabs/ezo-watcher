import { describe, expect, it } from 'vitest'
import { compareWorst, etaSeconds, evidenceLinks, incidentEvidence, instanceLabel, instanceLabels, instanceName, statusText, webUrl, worstFirst } from '../src/shared/evidence-links.ts'
import type { EvidenceSource, LabelInput, RankInput } from '../src/shared/evidence-links.ts'

// Fixtures modelled on the real FleetDisk incident of 2026-10-15: the regression sweep pushes one alert per host,
// and the Zulip #triage topic is its generatorURL.
const TOPIC = 'https://chat.example.com/#narrow/channel/8-triage/topic/sweep.202026-10-15'
const MESSAGE = `${TOPIC}/near/82`

const node4 = {
  host: 'node-4',
  severity: 'warning' as const,
  startsAt: '2026-10-15T06:16:13.161Z',
  generatorURL: TOPIC,
  links: { generator: TOPIC },
  annotations: {
    summary: 'node-4 disk / 89.3% (100 GB free, full in ~1.9d)',
    probe: "ssh node-4 'df -h /; du -xh --max-depth=1 / | sort -h | tail'",
    triage: TOPIC
  }
}
const node5 = {
  host: 'node-5',
  severity: 'page' as const,
  startsAt: '2026-10-15T06:16:13.161Z',
  generatorURL: MESSAGE,
  links: { generator: MESSAGE },
  annotations: {
    summary: 'node-5 disk / 81% (175 GB free, full in ~8h)',
    evidence: "ssh node-5 'df -h /; du -xh --max-depth=1 / | sort -h | tail'",
    report_url: MESSAGE,
    evidence_url: 'https://chat.example.com/user_uploads/2/ab/df-node-5.txt'
  }
}
const node6 = {
  host: 'node-6',
  severity: 'warning' as const,
  startsAt: '2026-10-15T06:16:13.161Z',
  annotations: { summary: 'node-6 disk / 88.1% (111 GB free, full in ~1.1d)' }
}

describe('evidenceLinks: kinds, labels and order', () => {
  it('reads a sweep alert: the report from report_url and generatorURL once, the command as a chip', () => {
    const links = evidenceLinks(node5)
    expect(links.map((l) => [l.kind, l.label])).toEqual([
      ['report', 'Report in #triage'],
      ['evidence', 'Open the evidence'],
      ['evidence', 'Evidence command']
    ])
    expect(links[0].url).toBe(MESSAGE)
    expect(links[2].text).toBe("ssh node-5 'df -h /; du -xh --max-depth=1 / | sort -h | tail'")
    expect(links[2].url).toBeUndefined()
  })

  it('reads the legacy keys live alerts still hold: triage is a report, probe is a command, never the probe label', () => {
    const links = evidenceLinks({ ...node4, annotations: { ...node4.annotations } })
    expect(links.map((l) => [l.kind, l.label])).toEqual([
      ['report', 'Topic in #triage'],
      ['evidence', 'Probe command']
    ])
  })

  it('orders source, report, runbook, evidence, reference whatever the input order', () => {
    const links = evidenceLinks({
      annotations: { evidence: 'kubectl get pods', runbook_url: 'https://wiki.example.com/rb/edge', report_url: MESSAGE },
      links: {
        silence: 'https://grafana.example.com/alerting/silence/new?matcher=alertname%3DX',
        panel: 'https://grafana.example.com/d/abc?viewPanel=4',
        explore: 'https://grafana.example.com/explore?schemaVersion=1',
        rule: 'https://grafana.example.com/alerting/grafana/uid1/view'
      },
      generatorURL: 'https://grafana.example.com/alerting/grafana/uid1/view?orgId=1'
    })
    expect(links.map((l) => l.kind)).toEqual(['source', 'source', 'source', 'report', 'runbook', 'evidence', 'reference'])
    expect(links.map((l) => l.label)).toEqual(['Grafana panel', 'Explore in Grafana', 'Alert rule in Grafana', 'Report in #triage', 'Runbook', 'Evidence command', 'Silence in Grafana'])
  })

  it('drops the dashboard when the panel is there, and a generator that is the rule under another orgId spelling', () => {
    const links = evidenceLinks({
      links: { panel: 'https://g.example.com/d/abc?viewPanel=4', dashboard: 'https://g.example.com/d/abc', rule: 'https://g.example.com/alerting/grafana/u/view' },
      generatorURL: 'https://g.example.com/alerting/grafana/u/view?orgId=1'
    })
    expect(links.map((l) => l.label)).toEqual(['Grafana panel', 'Alert rule in Grafana'])
  })

  it('names a generatorURL by what it is: Grafana, vmalert, Alertmanager, Prometheus, Zulip, or an unknown source', () => {
    const label = (generatorURL: string) => evidenceLinks({ generatorURL })[0]
    expect(label('https://grafana.example.com/alerting/grafana/u/view')).toMatchObject({ kind: 'source', label: 'Open in Grafana' })
    expect(label('https://vm.example.com/vmalert/alert?group_id=1&alert_id=2')).toMatchObject({ kind: 'source', label: 'Open in vmalert' })
    expect(label('https://alertmanager.example.com/#/alerts?silenced=false')).toMatchObject({ kind: 'source', label: 'Open in Alertmanager' })
    expect(label('http://prom.example.com:9090/graph?g0.expr=up')).toMatchObject({ kind: 'source', label: 'Open in Prometheus' })
    expect(label(TOPIC)).toMatchObject({ kind: 'report', label: 'Topic in #triage' })
    expect(label('https://chat.example.com/#narrow/channel/4-alerts/topic/x/near/9')).toMatchObject({ kind: 'report', label: 'Report in #alerts' })
    expect(label('https://ops.example.com/alert/17')).toMatchObject({ kind: 'source', label: 'Open the source' })
    expect(label('https://app.netdata.cloud/spaces/the operator-space/rooms/all-nodes/alerts/abc')).toMatchObject({ kind: 'source', label: 'Open in Netdata Cloud' })
  })

  it('reads a Grafana panel or dashboard that arrives as an annotation URL', () => {
    const links = evidenceLinks({ annotations: { panel_url: 'https://g.example.com/d/abc?viewPanel=2', dashboard_url: 'https://g.example.com/d/abc' } })
    expect(links.map((l) => l.label)).toEqual(['Grafana panel'])
    expect(evidenceLinks({ annotations: { dashboard_url: 'https://g.example.com/d/abc' } })[0].label).toBe('Grafana dashboard')
  })

  it('keeps any other annotation URL as a reference, labelled by its key, and ignores plain text annotations', () => {
    const links = evidenceLinks({ annotations: { sentry_issue_url: 'https://sentry.io/issues/1', description: 'tags security', summary: 'x' } })
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ kind: 'reference', label: 'Sentry issue', host: 'sentry.io' })
  })

  it('treats an evidence annotation that is a URL as a link, and one that is text as a chip', () => {
    expect(evidenceLinks({ annotations: { evidence: 'https://logs.example.com/q/1' } })[0]).toMatchObject({ kind: 'evidence', url: 'https://logs.example.com/q/1' })
    expect(evidenceLinks({ annotations: { evidence: 'df -h /' } })[0]).toMatchObject({ kind: 'evidence', text: 'df -h /' })
  })
})

describe('evidenceLinks: the three alert shapes', () => {
  it('Grafana: panel, explore and rule from the adapter, the runbook, and the silence as a reference', () => {
    const links = evidenceLinks({
      annotations: { summary: 'x', runbook_url: 'https://wiki.example.com/rb/edge' },
      links: {
        generator: 'https://grafana.example.com/alerting/grafana/u1/view?orgId=1',
        rule: 'https://grafana.example.com/alerting/grafana/u1/view',
        panel: 'https://grafana.example.com/d/abc?viewPanel=2',
        dashboard: 'https://grafana.example.com/d/abc',
        explore: 'https://grafana.example.com/explore?schemaVersion=1',
        runbook: 'https://wiki.example.com/rb/edge',
        silence: 'https://grafana.example.com/alerting/silence/new?matcher=alertname%3DX'
      }
    })
    expect(links.map((l) => [l.kind, l.label])).toEqual([
      ['source', 'Grafana panel'],
      ['source', 'Explore in Grafana'],
      ['source', 'Alert rule in Grafana'],
      ['runbook', 'Runbook'],
      ['reference', 'Silence in Grafana']
    ])
  })

  it('router (Alertmanager v4): an in-cluster generatorURL is dropped, a reachable one is kept, the runbook stays', () => {
    const router: EvidenceSource = { annotations: { summary: 'wedge', runbook_url: 'https://wiki.example.com/rb/router' }, generatorURL: 'http://prometheus-0:9090/graph?g0.expr=up' }
    expect(evidenceLinks(router).map((l) => l.label)).toEqual(['Runbook'])
    expect(evidenceLinks({ generatorURL: 'https://prom.example.com/graph?g0.expr=up' })[0].label).toBe('Open in Prometheus')
  })

  it('prober (component=uptime): a down alert with only a summary has no links, so the sheet offers the raw payload', () => {
    expect(evidenceLinks({ annotations: { summary: 'edge.example.com is down' } })).toEqual([])
  })
})

describe('evidenceLinks: one link per label', () => {
  it('keeps the explicit report_url and drops the generatorURL message under the same label, keeping the topic as its own link', () => {
    // a live sweep alert: report_url is the finding, generatorURL the older anchor message, triage the thread
    const links = evidenceLinks({
      generatorURL: `${TOPIC}/near/82`,
      links: { generator: `${TOPIC}/near/82` },
      annotations: { report_url: `${TOPIC}/near/90`, triage: TOPIC }
    })
    expect(links.map((l) => [l.label, l.url])).toEqual([
      ['Report in #triage', `${TOPIC}/near/90`],
      ['Topic in #triage', TOPIC]
    ])
  })
})

describe('evidenceLinks: dedupe and empties', () => {
  it('lists a URL once however many keys carry it, trailing slash and host case aside', () => {
    const links = evidenceLinks({
      generatorURL: 'https://Chat.example.com/#narrow/channel/8-triage/topic/t/',
      links: { generator: 'https://chat.example.com/#narrow/channel/8-triage/topic/t' },
      annotations: { report_url: 'https://chat.example.com/#narrow/channel/8-triage/topic/t', triage: 'https://chat.example.com/#narrow/channel/8-triage/topic/t' }
    })
    expect(links).toHaveLength(1)
  })

  it('lists the same command once', () => {
    const links = evidenceLinks({ annotations: { evidence: 'df -h', probe: 'df -h', command: ' df -h ' } })
    expect(links.filter((l) => l.text)).toHaveLength(1)
  })

  it('drops empty, blank and non-http(s) values: javascript, data and file URLs never reach a href', () => {
    const links = evidenceLinks({
      annotations: { runbook_url: '   ', report_url: 'javascript:alert(1)', evidence: '', evidence_url: 'data:text/html,hi', probe: '\u0007' },
      links: { panel: 'file:///etc/passwd', runbook: '', explore: 'ftp://x' },
      generatorURL: 'not a url'
    })
    expect(links).toEqual([])
    expect(evidenceLinks({})).toEqual([])
  })

  it('caps a very long command and strips control characters from it', () => {
    const [chip] = evidenceLinks({ annotations: { evidence: `echo \u0000${'x'.repeat(900)}` } })
    expect((chip.text ?? '').length).toBeLessThanOrEqual(600)
    expect(chip.text).not.toContain('\u0000')
  })

  it('webUrl accepts http and https only', () => {
    expect(webUrl('https://a.example/x')).toBe('https://a.example/x')
    expect(webUrl(' http://a.example ')).toBe('http://a.example')
    expect(webUrl('mailto:a@b.example')).toBeUndefined()
    expect(webUrl(undefined)).toBeUndefined()
  })
})

describe('worst first', () => {
  const rank = (a: (typeof node4) | (typeof node5) | (typeof node6)): RankInput => ({ severity: a.severity, startsAt: a.startsAt, summary: a.annotations.summary, name: a.host })

  it('reads the ETA out of a summary in every unit the sweep and Grafana use', () => {
    expect(etaSeconds('node-4 disk / 89.3% (100 GB free, full in ~1.9d)')).toBeCloseTo(1.9 * 86400)
    expect(etaSeconds('node-5 disk / 81% (175 GB free, full in ~8h)')).toBe(8 * 3600)
    expect(etaSeconds('queue full in 45 min')).toBe(45 * 60)
    expect(etaSeconds('cert expires in 3 days')).toBe(3 * 86400)
    expect(etaSeconds('quota runs out in ~30s')).toBe(30)
    expect(etaSeconds('edge dead for 5 minutes')).toBeNull()
    expect(etaSeconds(undefined)).toBeNull()
  })

  it('puts node-5 first: a page beats a warning whatever the ETA, then the shortest ETA, then the oldest', () => {
    expect(worstFirst([node4, node6, node5], rank).map((a) => a.host)).toEqual(['node-5', 'node-6', 'node-4'])
    // same severity: node-6 (1.1d) before node-4 (1.9d)
    expect(worstFirst([node4, node6], rank).map((a) => a.host)).toEqual(['node-6', 'node-4'])
  })

  it('puts a page with a long ETA before a warning with a short one', () => {
    const page: RankInput = { severity: 'page', startsAt: '2026-10-15T06:00:00Z', summary: 'full in ~30d' }
    const warning: RankInput = { severity: 'warning', startsAt: '2026-10-15T06:00:00Z', summary: 'full in ~1h' }
    expect(compareWorst(page, warning)).toBeLessThan(0)
  })

  it('ranks an instance that names an ETA before one that does not, then by age, then by name', () => {
    const none: RankInput = { severity: 'warning', startsAt: '2026-10-15T01:00:00Z', summary: 'high latency', name: 'a' }
    const eta: RankInput = { severity: 'warning', startsAt: '2026-10-15T05:00:00Z', summary: 'full in ~5d', name: 'b' }
    const older: RankInput = { severity: 'warning', startsAt: '2026-10-15T02:00:00Z', summary: 'slow', name: 'c' }
    const sameAge: RankInput = { severity: 'warning', startsAt: '2026-10-15T02:00:00Z', summary: 'slow', name: 'a' }
    expect(worstFirst([none, eta], (x) => x)[0]).toBe(eta)
    expect(worstFirst([older, none], (x) => x)[0]).toBe(none)
    expect(worstFirst([older, sameAge], (x) => x)[0]).toBe(sameAge)
  })

  it('does not reorder equal instances and does not mutate its input', () => {
    const a: RankInput = { severity: 'page', startsAt: '2026-10-15T06:00:00Z', name: 'x' }
    const b: RankInput = { severity: 'page', startsAt: '2026-10-15T06:00:00Z', name: 'x' }
    const input = [b, a]
    expect(worstFirst(input, (x) => x)).toEqual([b, a])
    expect(input[0]).toBe(b)
  })
})

describe('instance text', () => {
  it('names an instance by host, then instance label, then rule', () => {
    expect(instanceName({ host: 'node-5', rule: 'FleetDisk' })).toBe('node-5')
    expect(instanceName({ host: '', labels: { instance: 'edge-1' }, rule: 'EdgeDead' })).toBe('edge-1')
    expect(instanceName({ rule: 'EdgeDead' })).toBe('EdgeDead')
  })

  // The three live shapes. The incident's title on the wall is the alertname, so no label may equal it.
  describe('the label of an instance', () => {
    const sweep = (summary: string, source: string): LabelInput => ({
      host: '',
      rule: source === 'sink_stale' ? 'IntakeSinkStale' : 'IntakeBugReport',
      labels: { alertname: 'x', probe: 'intake', source, sweep_key: `intake/${source}/${summary.length}` },
      annotations: { summary }
    })

    it('sweep with no host: the summary, never the alertname and never the sweep_key', () => {
      const one = instanceLabel(sweep('bug_report: desktop:1b9aa85f', 'bug_report'))
      expect(one).toEqual({ text: 'bug_report: desktop:1b9aa85f', source: 'summary' })
      // two findings with identical labels are told apart by their own summaries
      const two = instanceLabels([sweep('ClickHouse tables unread/stale: 0 unread, 1 stale', 'sink_stale'), sweep('sink_stale: sink_stale/app_telemetry.engine_events x302', 'sink_stale')])
      expect(two.map((l) => l.text)).toEqual(['ClickHouse tables unread/stale: 0 unread, 1 stale', 'sink_stale: sink_stale/app_telemetry.engine_events x302'])
      expect(two.every((l) => l.source === 'summary')).toBe(true)
      expect(two.some((l) => l.text === 'IntakeSinkStale')).toBe(false)
    })

    it('Grafana with an instance label: the host, and the instance label without its port when no host was derived', () => {
      expect(instanceLabel({ host: 'edge-1', rule: 'EdgeDead', labels: { instance: 'edge-1:9100', component: 'edge' }, annotations: { summary: 'No http_events for 5 minutes' } })).toEqual({ text: 'edge-1', source: 'host' })
      expect(instanceLabel({ rule: 'EdgeDead', labels: { instance: 'edge-1:9100' }, annotations: { summary: 'x' } })).toEqual({ text: 'edge-1', source: 'instance' })
    })

    it('prober (component uptime, instance label): the target', () => {
      const probe = (target: string): LabelInput => ({ host: target, rule: 'ProbeDown', labels: { alertname: 'ProbeDown', component: 'uptime', instance: target }, annotations: { summary: `${target} is down` } })
      expect(instanceLabels([probe('edge.example.com'), probe('watch.example.com')]).map((l) => l.text)).toEqual(['edge.example.com', 'watch.example.com'])
      expect(instanceLabel({ rule: 'ProbeDown', labels: { instance: 'edge.example.com:443', component: 'uptime' } }).text).toBe('edge.example.com')
    })

    it('falls from host to instance to service to namespace and workload to summary to the alertname', () => {
      const base = { rule: 'Zombies' }
      expect(instanceLabel({ ...base, host: 'n1', labels: { service: 'prod/scraper' } }).source).toBe('host')
      expect(instanceLabel({ ...base, labels: { service: 'prod/scraper', namespace: 'prod' } })).toEqual({ text: 'prod/scraper', source: 'service' })
      expect(instanceLabel({ ...base, labels: { namespace: 'prod', deployment: 'scraper' } })).toEqual({ text: 'prod/scraper', source: 'workload' })
      expect(instanceLabel({ ...base, labels: { namespace: 'prod' } })).toEqual({ text: 'prod', source: 'workload' })
      expect(instanceLabel({ ...base, annotations: { summary: 'prod/scraper: 1006 zombie processes' } }).source).toBe('summary')
      expect(instanceLabel({ ...base })).toEqual({ text: 'Zombies', source: 'rule' })
    })

    it('never renders the incident title: a host, service or summary that is the alertname or the avoid list is skipped', () => {
      expect(instanceLabel({ host: 'FleetDisk', rule: 'FleetDisk', annotations: { summary: 'node-5 disk 81%' } }).text).toBe('node-5 disk 81%')
      expect(instanceLabel({ rule: 'X', labels: { service: 'edge' }, annotations: { summary: 'edge is slow' } }, ['Edge']).text).toBe('edge is slow')
    })

    it('tells instances of one service apart: a shared service label is not a name, the host or summary is', () => {
      const shared = (host: string, summary: string): LabelInput => ({ host, rule: 'R', labels: { service: 'edge' }, annotations: { summary } })
      expect(instanceLabels([shared('', 'a is slow'), shared('', 'b is slow')]).map((l) => l.text)).toEqual(['a is slow', 'b is slow'])
      expect(instanceLabels([shared('h1', 'x'), shared('h2', 'y')]).map((l) => l.text)).toEqual(['h1', 'h2'])
      // a mix: the two with hosts keep them, the one without is its summary
      expect(instanceLabels([shared('h1', 'x'), shared('', 'no host here'), shared('h2', 'y')]).map((l) => l.text)).toEqual(['h1', 'no host here', 'h2'])
    })

    it('keeps two identical alerts apart by the only thing left, and never drops the alertname as a last resort', () => {
      const twin: LabelInput = { rule: 'Same', annotations: { summary: 'same words' } }
      expect(instanceLabels([twin, twin]).map((l) => l.source)).toEqual(['rule', 'rule'])
      expect(instanceLabels([])).toEqual([])
    })
  })

  it('drops the instance name from the front of its own summary, and keeps a summary that does not start with it', () => {
    expect(statusText('node-5', 'node-5 disk / 81% (175 GB free, full in ~8h)')).toBe('disk / 81% (175 GB free, full in ~8h)')
    expect(statusText('node-5', 'disk is filling on node-5')).toBe('disk is filling on node-5')
    expect(statusText('node-5', 'node-5')).toBe('node-5')
    expect(statusText('node-5', undefined, '81')).toBe('81')
    expect(statusText('node-5', '')).toBe('')
  })
})

describe('incidentEvidence', () => {
  const ranked: EvidenceSource[] = [node5, node6, node4]

  it('is the worst instance links, once, with the other instances commands left to their own rows', () => {
    const links = incidentEvidence(ranked)
    expect(links.map((l) => l.label)).toEqual(['Report in #triage', 'Open the evidence', 'Evidence command'])
    expect(links.filter((l) => l.text)).toHaveLength(1)
    expect(links.find((l) => l.text)?.text).toContain('ssh node-5')
  })

  it('adds a link only another instance has, under a label the worst one lacks', () => {
    const withRunbook: EvidenceSource = { annotations: { runbook_url: 'https://wiki.example.com/rb/disk' } }
    const links = incidentEvidence([node5, withRunbook, withRunbook])
    expect(links.map((l) => l.label)).toEqual(['Report in #triage', 'Runbook', 'Open the evidence', 'Evidence command'])
    expect(incidentEvidence([])).toEqual([])
  })
})
