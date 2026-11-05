import { describe, expect, it } from 'vitest'
import { alertKey } from '../src/server/derive.ts'
import { BadPayload, MAX_ALERTS, normalizeWebhook } from '../src/server/sources/webhook.ts'
import type { SourceDeps } from '../src/server/sources/types.ts'

const NOW = '2026-10-15T06:00:00.000Z'

const deps: SourceDeps = {
  fetch: (() => {
    throw new Error('a webhook never fetches')
  }) as unknown as typeof fetch,
  env: {},
  nowIso: () => NOW,
  serviceMap: []
}

function ctx(extra: { headerSource?: string; source?: string } = {}) {
  return { source: extra.source ?? 'webhook', headerSource: extra.headerSource, deps }
}

// Alertmanager webhook v4, the field set of the Prometheus docs (retrieved 2026-10-14).
function amAlert(over: Record<string, unknown> = {}) {
  return {
    status: 'firing',
    labels: { alertname: 'ApiDeployTtftRegression', severity: 'ticket', instance: 'prod' },
    annotations: { summary: 'TTFT p99 is more than twice yesterday', runbook_url: 'https://runbooks.example.com/ttft' },
    startsAt: '2026-10-15T05:08:30.123Z',
    endsAt: '0001-01-01T00:00:00Z',
    generatorURL: 'https://vmalert.example.com/vmalert/alert?group_id=1&alert_id=2',
    fingerprint: 'c4457524ab12cd34',
    ...over
  }
}

function amPayload(alerts: unknown[], over: Record<string, unknown> = {}) {
  return {
    version: '4',
    groupKey: '{}:{alertname="ApiDeployTtftRegression"}',
    truncatedAlerts: 0,
    status: 'firing',
    receiver: 'zulip',
    groupLabels: { alertname: 'ApiDeployTtftRegression' },
    commonLabels: { alertname: 'ApiDeployTtftRegression' },
    commonAnnotations: {},
    externalURL: 'http://alertmanager-0:9093',
    alerts,
    ...over
  }
}

// Grafana webhook: ExtendedData plus the webhook fields (grafana/alerting templates/template_data.go).
function grafanaAlert(over: Record<string, unknown> = {}) {
  return {
    status: 'firing',
    labels: {
      alertname: 'API ClickHouse disk at 80%',
      component: 'clickhouse-disk',
      grafana_folder: 'API alerts',
      severity: 'warn',
      team: 'api'
    },
    annotations: { summary: 'ClickHouse disk default is 77.2% full', runbook_url: 'https://runbooks.example.com/disk' },
    startsAt: '2026-10-15T03:40:20Z',
    endsAt: '0001-01-01T00:00:00Z',
    generatorURL: 'https://grafana.example.com/alerting/grafana/api-disk-80/view?orgId=1',
    fingerprint: 'a1b2c3d4e5f60718',
    silenceURL: 'https://grafana.example.com/alerting/silence/new?alertmanager=grafana&matcher=__alert_rule_uid__%3Dapi-disk-80',
    dashboardURL: 'https://grafana.example.com/d/api-clickhouse?from=1&to=2',
    panelURL: 'https://grafana.example.com/d/api-clickhouse?from=1&to=2&viewPanel=7',
    values: { B: 77.2, C: 1 },
    valueString: '[ var=\'B\' labels={} value=77.2 ]',
    imageURL: 'https://grafana.example.com/render/panel.png',
    ...over
  }
}

function grafanaPayload(alerts: unknown[], over: Record<string, unknown> = {}) {
  return {
    receiver: 'api-pager',
    status: 'firing',
    orgId: 1,
    alerts,
    groupLabels: {},
    commonLabels: {},
    commonAnnotations: {},
    externalURL: 'https://grafana.example.com/',
    version: '1',
    groupKey: '{}/{}:{}',
    truncatedAlerts: 0,
    title: '[FIRING:1]',
    state: 'alerting',
    message: '',
    ...over
  }
}

describe('Alertmanager v4 webhook', () => {
  it('turns firing alerts into firing and resolved alerts into resolved, never complete', () => {
    const obs = normalizeWebhook(
      amPayload([
        amAlert(),
        amAlert({
          status: 'resolved',
          labels: { alertname: 'ApiSliSlowBurn', severity: 'critical' },
          fingerprint: '99aa88bb77cc66dd',
          startsAt: '2026-10-15T04:00:00Z',
          endsAt: '2026-10-15T05:30:00Z'
        })
      ]),
      ctx()
    )
    expect(obs).toMatchObject({ source: 'webhook', kind: 'webhook', at: NOW, complete: false })
    expect(obs.firing).toHaveLength(1)
    expect(obs.resolved).toHaveLength(1)
    expect(obs.firing[0]).toMatchObject({
      key: 'webhook:c4457524',
      origin: 'webhook',
      fingerprint: 'c4457524ab12cd34',
      rule: 'ApiDeployTtftRegression',
      host: 'prod',
      severity: 'warning',
      severityLabel: 'ticket',
      startsAt: '2026-10-15T05:08:30.123Z',
      endsAt: null,
      resolvedAt: null
    })
    expect(obs.firing[0].annotations.summary).toBe('TTFT p99 is more than twice yesterday')
    expect(obs.firing[0].via).toEqual([{ source: 'webhook', kind: 'webhook', lastSeen: NOW }])
    expect(obs.resolved[0]).toMatchObject({
      key: 'webhook:99aa88bb',
      rule: 'ApiSliSlowBurn',
      severity: 'page',
      startsAt: '2026-10-15T04:00:00Z',
      endsAt: '2026-10-15T05:30:00Z',
      resolvedAt: '2026-10-15T05:30:00Z'
    })
  })

  it('takes the origin from X-Alert-Source, and from the source id otherwise', () => {
    const fromHeader = normalizeWebhook(amPayload([amAlert()]), ctx({ headerSource: 'prod' }))
    expect(fromHeader.firing[0].origin).toBe('prod')
    expect(fromHeader.firing[0].key).toBe(alertKey('prod', 'c4457524'))
    // The observation and the via entry still belong to the webhook source.
    expect(fromHeader.source).toBe('webhook')
    expect(fromHeader.firing[0].via[0].source).toBe('webhook')
    expect(normalizeWebhook(amPayload([amAlert()]), ctx({ headerSource: 'dev' })).firing[0].origin).toBe('dev')
    expect(normalizeWebhook(amPayload([amAlert()]), ctx()).firing[0].origin).toBe('webhook')
  })

  it('ignores an X-Alert-Source that is not a plain name', () => {
    for (const headerSource of ['', '   ', 'api prod', 'prod\nX-Injected: 1', 'a'.repeat(80)]) {
      const obs = normalizeWebhook(amPayload([amAlert()]), ctx({ headerSource, source: 'ingest' }))
      expect(obs.firing[0].origin).toBe('ingest')
    }
  })

  it('does not treat Go zero-time endsAt on a firing alert as a resolution', () => {
    const a = normalizeWebhook(amPayload([amAlert()]), ctx()).firing[0]
    expect(a.endsAt).toBeNull()
    expect(a.resolvedAt).toBeNull()
  })

  it('stamps a resolved alert with the observation time when endsAt is the zero time', () => {
    const obs = normalizeWebhook(amPayload([amAlert({ status: 'resolved' })]), ctx())
    expect(obs.resolved[0].resolvedAt).toBe(NOW)
    expect(obs.resolved[0].endsAt).toBe(NOW)
  })

  it('drops the dead-man pings Watchdog and ApiWatchdog', () => {
    const obs = normalizeWebhook(
      amPayload([
        amAlert({ labels: { alertname: 'Watchdog' }, fingerprint: '1111111111111111' }),
        amAlert({ labels: { alertname: 'ApiWatchdog', severity: 'none' }, fingerprint: '2222222222222222' }),
        amAlert()
      ]),
      ctx()
    )
    expect(obs.firing.map((a) => a.rule)).toEqual(['ApiDeployTtftRegression'])
    expect(obs.resolved).toEqual([])
  })

  it('links the runbook, and the generator only when its host has a dot', () => {
    const open = normalizeWebhook(amPayload([amAlert()]), ctx()).firing[0]
    expect(open.links.runbook).toBe('https://runbooks.example.com/ttft')
    expect(open.links.generator).toBe('https://vmalert.example.com/vmalert/alert?group_id=1&alert_id=2')
    const inCluster = normalizeWebhook(
      amPayload([amAlert({ generatorURL: 'http://api-vmalert-6d887fc8b4-qmp95:8880/vmalert/alert?group_id=1' })]),
      ctx()
    ).firing[0]
    expect(inCluster.links.generator).toBeUndefined()
    expect(inCluster.generatorURL).toBe('http://api-vmalert-6d887fc8b4-qmp95:8880/vmalert/alert?group_id=1')
  })

  it('never links a non-http URL', () => {
    const a = normalizeWebhook(
      amPayload([amAlert({ annotations: { runbook_url: 'javascript:alert(1)' }, generatorURL: 'data:text/html,x' })]),
      ctx()
    ).firing[0]
    expect(a.links).toEqual({})
    expect(a.generatorURL).toBeUndefined()
  })

  it('keeps labels as sent and derives the service from the map', () => {
    const map = [{ match: { rule: '^Api' }, service: 'router' }]
    const obs = normalizeWebhook(amPayload([amAlert()]), { ...ctx(), deps: { ...deps, serviceMap: map } })
    expect(obs.firing[0].service).toBe('router')
    expect(obs.firing[0].labels).toEqual({ alertname: 'ApiDeployTtftRegression', severity: 'ticket', instance: 'prod' })
  })

  it('derives a fingerprint from the labels when the alert has none', () => {
    const a = normalizeWebhook(amPayload([amAlert({ fingerprint: undefined })]), ctx()).firing[0]
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(a.key).toBe(`webhook:${a.fingerprint.slice(0, 8)}`)
  })

  it('keeps one alert when a payload lists the same fingerprint twice', () => {
    const obs = normalizeWebhook(amPayload([amAlert(), amAlert()]), ctx())
    expect(obs.firing).toHaveLength(1)
  })

  it('accepts an empty alert list in a payload that is otherwise a valid v4 webhook', () => {
    const obs = normalizeWebhook(amPayload([]), ctx())
    expect(obs.firing).toEqual([])
    expect(obs.resolved).toEqual([])
  })

  it('keeps at most 400 alerts', () => {
    const many = Array.from({ length: 450 }, (_, i) =>
      amAlert({ fingerprint: `${i.toString(16).padStart(8, '0')}00000000`, labels: { alertname: `Rule${i}`, instance: `i${i}` } })
    )
    const obs = normalizeWebhook(amPayload(many), ctx())
    expect(MAX_ALERTS).toBe(400)
    expect(obs.firing).toHaveLength(400)
    expect(obs.firing[0].rule).toBe('Rule0')
  })
})

describe('Grafana webhook', () => {
  it('is told apart by orgId and reads the extras into links and value', () => {
    const obs = normalizeWebhook(grafanaPayload([grafanaAlert()]), ctx({ source: 'grafana' }))
    expect(obs.complete).toBe(false)
    const a = obs.firing[0]
    expect(a).toMatchObject({
      key: 'grafana:a1b2c3d4',
      origin: 'grafana',
      rule: 'API ClickHouse disk at 80%',
      service: 'Clickhouse disk',
      severity: 'warning',
      value: 'B=77.2, C=1'
    })
    expect(a.links).toEqual({
      generator: 'https://grafana.example.com/alerting/grafana/api-disk-80/view?orgId=1',
      runbook: 'https://runbooks.example.com/disk',
      dashboard: 'https://grafana.example.com/d/api-clickhouse?from=1&to=2',
      panel: 'https://grafana.example.com/d/api-clickhouse?from=1&to=2&viewPanel=7',
      silence: 'https://grafana.example.com/alerting/silence/new?alertmanager=grafana&matcher=__alert_rule_uid__%3Dapi-disk-80'
    })
    // AlertLinks has no image slot: the picture stays in the raw payload.
    expect(a.raw).toMatchObject({ imageURL: 'https://grafana.example.com/render/panel.png' })
  })

  it('is also told apart by a silenceURL when orgId is missing', () => {
    const payload = grafanaPayload([grafanaAlert()])
    delete (payload as Record<string, unknown>).orgId
    expect(normalizeWebhook(payload, ctx()).firing).toHaveLength(1)
  })

  it('falls back to valueString when values is empty', () => {
    const a = normalizeWebhook(grafanaPayload([grafanaAlert({ values: {} })]), ctx()).firing[0]
    expect(a.value).toBe("[ var='B' labels={} value=77.2 ]")
    const none = normalizeWebhook(grafanaPayload([grafanaAlert({ values: null, valueString: '' })]), ctx()).firing[0]
    expect(none.value).toBeUndefined()
  })

  it('names a DatasourceNoData alert for the real rule', () => {
    const noData = grafanaAlert({
      labels: {
        alertname: 'DatasourceNoData',
        datasource_uid: 'ch-k8s-prod',
        rulename: 'API probe down (4 min streak)',
        severity: 'page'
      },
      fingerprint: 'ffeeddccbbaa9988'
    })
    const a = normalizeWebhook(grafanaPayload([noData]), ctx()).firing[0]
    expect(a.rule).toBe('API probe down (4 min streak)')
    expect(a.labels.alertname).toBe('DatasourceNoData')
    expect(a.severity).toBe('page')
  })

  it('moves a resolved alert to resolved with resolvedAt from endsAt', () => {
    const obs = normalizeWebhook(
      grafanaPayload([grafanaAlert({ status: 'resolved', endsAt: '2026-10-15T05:51:20Z' })], { status: 'resolved' }),
      ctx()
    )
    expect(obs.firing).toEqual([])
    expect(obs.resolved[0].resolvedAt).toBe('2026-10-15T05:51:20Z')
    expect(obs.resolved[0].key).toBe('webhook:a1b2c3d4')
  })

  it('takes X-Alert-Source for a Grafana payload too', () => {
    const obs = normalizeWebhook(grafanaPayload([grafanaAlert()]), ctx({ headerSource: 'prod' }))
    expect(obs.firing[0].origin).toBe('prod')
  })

  it('drops Watchdog in the Grafana shape as well', () => {
    const obs = normalizeWebhook(grafanaPayload([grafanaAlert({ labels: { alertname: 'Watchdog' } })]), ctx())
    expect(obs.firing).toEqual([])
  })
})

describe('bad payloads', () => {
  function reject(payload: unknown): BadPayload {
    try {
      normalizeWebhook(payload, ctx())
    } catch (e) {
      expect(e).toBeInstanceOf(BadPayload)
      expect((e as Error).name).toBe('BadPayload')
      return e as BadPayload
    }
    throw new Error('payload should have been rejected')
  }

  it('rejects a body that is not an object', () => {
    for (const body of [null, undefined, 'alerts', 7, [], [amAlert()]]) reject(body)
  })

  it('rejects an object with no alerts list', () => {
    reject({})
    reject({ version: '4', groupKey: 'x' })
    reject({ version: '4', groupKey: 'x', alerts: 'many' })
  })

  it('rejects a list of alerts that is neither shape', () => {
    const e = reject({ alerts: [amAlert()], receiver: 'x' })
    expect(e.message).toBe('payload is neither an Alertmanager v4 nor a Grafana webhook')
  })

  it('rejects an alert that is not an object, has a bad status, or has no labels', () => {
    expect(reject(amPayload([3])).message).toBe('alerts[0] must be an object')
    expect(reject(amPayload([amAlert(), amAlert({ status: 'unknown' })])).message).toBe('alerts[1].status must be firing or resolved')
    expect(reject(amPayload([amAlert({ labels: undefined })])).message).toBe('alerts[0].labels must be an object')
  })

  it('carries a safe message: no payload content is echoed back', () => {
    const e = reject(amPayload([amAlert({ status: 'token=hunter2-do-not-echo' })]))
    expect(e.message).not.toContain('hunter2')
    expect(reject({ alerts: [{ labels: { x: 'token=hunter2-do-not-echo' } }] }).message).not.toContain('hunter2')
  })
})
