import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CellState, RuleCell, SourceKind, SourceStatus } from '../src/shared/types.ts'
import { ServiceSheet } from '../src/web/components/Sheets.tsx'
import { Cells } from '../src/web/components/ui.tsx'
import {
  CELL_LEGEND,
  cellLine,
  cellOrigin,
  cellShort,
  cellWords,
  legendText,
  okText,
  openText,
  orderCells,
  sourceKinds,
  splitCells
} from '../src/web/lib/cells.ts'
import type { CellOrigin } from '../src/web/lib/cells.ts'
import { NBSP } from '../src/web/lib/format.ts'
import { KIND_LABEL, kindLabel } from '../src/web/lib/sources.ts'
import { Sources } from '../src/web/views/Sources.tsx'

const NOW = Date.parse('2026-10-15T16:40:00.000Z')
const ISO = '2026-10-15T16:39:00.000Z'

function cell(over: Partial<RuleCell> & { id: string }): RuleCell {
  return { source: 'grafana', name: over.id, service: 'Svc', state: 'ok', evaluatedAt: ISO, ...over }
}
/** n cells of one state, named `${state}-${i}`. */
const many = (state: CellState, n: number, over: Partial<RuleCell> = {}): RuleCell[] =>
  Array.from({ length: n }, (_, i) => cell({ id: `${state}-${i}`, name: `${state}-${i}`, state, ...over }))

const SOURCES: Array<Pick<SourceStatus, 'id' | 'kind'>> = [
  { id: 'grafana', kind: 'grafana' },
  { id: 'vmalert', kind: 'vmalert' },
  { id: 'netdata-cloud', kind: 'netdata-cloud' },
  { id: 'sweep', kind: 'webhook' },
  { id: 'webhook', kind: 'webhook' }
]
const kinds = sourceKinds(SOURCES)

const sweepCell = (over: Partial<RuleCell> = {}): RuleCell => cell({ id: 'check:sweep:Regression sweep/IntakeCfEdge5xx', source: 'sweep', name: 'IntakeCfEdge5xx', checkId: 'IntakeCfEdge5xx', staleAfterSec: 36000, ...over })
const proberCell = (over: Partial<RuleCell> = {}): RuleCell => cell({ id: 'check:api-uptime:Uptime/ProbeDown/api-rooms', source: 'api-uptime', name: 'api-rooms', checkId: 'ProbeDown', staleAfterSec: 300, ...over })

describe('the summary split: every non-ok cell, then one count for the rest', () => {
  it('keeps every non-ok cell, worst first, and counts the ok ones', () => {
    const cells = [...many('ok', 99), ...many('pending', 11), ...many('nodata', 5), ...many('firing', 7)]
    const s = splitCells(cells)
    expect(s.total).toBe(122)
    expect(s.ok).toBe(99)
    expect(s.open).toHaveLength(23)
    expect(s.open.slice(0, 7).every((c) => c.state === 'firing')).toBe(true)
    expect(s.open.slice(7, 12).every((c) => c.state === 'nodata')).toBe(true)
    expect(s.open.slice(12).every((c) => c.state === 'pending')).toBe(true)
  })

  it('ranks firing, error, stale, no data, pending, then history-only, and keeps the order inside one state', () => {
    const cells = [cell({ id: 'i', state: 'inferred' }), cell({ id: 'p', state: 'pending' }), cell({ id: 'n2', state: 'nodata' }), cell({ id: 'n1', state: 'nodata' }), cell({ id: 's', state: 'stale' }), cell({ id: 'e', state: 'error' }), cell({ id: 'f', state: 'firing' }), cell({ id: 'o', state: 'ok' })]
    expect(splitCells(cells).open.map((c) => c.id)).toEqual(['f', 'e', 's', 'n2', 'n1', 'p', 'i'])
  })

  it('counts a history-only cell as non-ok: it is drawn, never folded into the count', () => {
    const s = splitCells([...many('ok', 3), ...many('inferred', 2)])
    expect(s.open).toHaveLength(2)
    expect(s.ok).toBe(3)
  })

  it('does not touch its input', () => {
    const cells = [...many('ok', 2), ...many('firing', 1)]
    const before = cells.map((c) => c.id)
    splitCells(cells)
    expect(cells.map((c) => c.id)).toEqual(before)
  })

  it('says "N ok" for the rest, with the number and its unit held together', () => {
    expect(okText(splitCells([...many('ok', 99), ...many('pending', 1)]))).toBe(`99${NBSP}ok`)
    expect(okText(splitCells([...many('ok', 1), ...many('firing', 4)]))).toBe(`1${NBSP}ok`)
  })

  it('says "All N ok" when every cell is ok, and plain "1 ok" for a lone cell', () => {
    expect(okText(splitCells(many('ok', 15)))).toBe(`All 15${NBSP}ok`)
    expect(okText(splitCells(many('ok', 70)))).toBe(`All 70${NBSP}ok`)
    expect(okText(splitCells(many('ok', 2)))).toBe(`All 2${NBSP}ok`)
    expect(okText(splitCells(many('ok', 1)))).toBe(`1${NBSP}ok`)
  })

  it('says nothing about ok when none is ok, and nothing at all for no cells', () => {
    expect(okText(splitCells(many('nodata', 3)))).toBeNull()
    expect(okText(splitCells([]))).toBeNull()
  })

  it('has a one-line count of the non-ok cells for a tile too small to draw them', () => {
    expect(openText(splitCells([...many('ok', 99), ...many('pending', 23)]))).toBe(`23${NBSP}not${NBSP}ok`)
    expect(openText(splitCells(many('ok', 3)))).toBe(`0${NBSP}not${NBSP}ok`)
  })

  it('orders a whole list for the sheet: the non-ok cells first, then the ok ones in their own order', () => {
    const cells = [cell({ id: 'a', state: 'ok' }), cell({ id: 'b', state: 'pending' }), cell({ id: 'c', state: 'ok' }), cell({ id: 'd', state: 'firing' })]
    expect(orderCells(cells).map((c) => c.id)).toEqual(['d', 'b', 'a', 'c'])
  })
})

describe('state in words, per source', () => {
  it('finds the source of a cell from its check list, else from the source kind', () => {
    expect(cellOrigin(proberCell(), kinds)).toBe('prober')
    expect(cellOrigin(sweepCell(), kinds)).toBe('sweep')
    expect(cellOrigin(cell({ id: 'g' }), kinds)).toBe('grafana')
    expect(cellOrigin(cell({ id: 'v', source: 'vmalert' }), kinds)).toBe('vmalert')
    expect(cellOrigin(cell({ id: 'n', source: 'netdata-cloud' }), kinds)).toBe('netdata-cloud')
    expect(cellOrigin(cell({ id: 'x', source: 'somewhere-else' }), kinds)).toBe('other')
    // a check list from a sender this page has never heard of is still a check, not a rule
    expect(cellOrigin(cell({ id: 'c', source: 'new-sender', checkId: 'X' }), kinds)).toBe('check')
  })

  it('words "pending" for each source in its own terms', () => {
    expect(cellWords(cell({ id: 'g', state: 'pending' }), 'grafana')).toBe('pending, inside its for-window')
    expect(cellWords(sweepCell({ state: 'pending' }), 'sweep')).toContain('read in part')
    expect(cellWords(proberCell({ state: 'pending' }), 'prober')).toContain('waiting before declaring down')
    expect(cellWords(cell({ id: 'n', state: 'pending', source: 'netdata-cloud' }), 'netdata-cloud')).toContain('pending')
  })

  it('says "skipped" for a check that could not run, and "no data" for a rule with none', () => {
    expect(cellWords(sweepCell({ state: 'nodata' }), 'sweep')).toBe('skipped')
    expect(cellWords(proberCell({ state: 'nodata' }), 'prober')).toBe('skipped')
    expect(cellWords(cell({ id: 'g', state: 'nodata' }), 'grafana')).toBe('no data')
    expect(cellShort(sweepCell({ state: 'nodata' }), 'sweep')).toBe('skipped')
    expect(cellShort(cell({ id: 'g', state: 'nodata' }), 'grafana')).toBe('no data')
  })

  it('gives the reason after the state when the source sent one', () => {
    const c = sweepCell({ state: 'nodata', detail: 'no credential for Cloudflare analytics' })
    expect(cellLine(c, 'sweep')).toBe('skipped: no credential for Cloudflare analytics')
    expect(cellLine(sweepCell({ state: 'pending', detail: '9 yellow, not an alert' }), 'sweep')).toBe('pending, read in part: 9 yellow, not an alert')
    expect(cellLine(proberCell({ detail: 'HTTP 200 in 48ms' }), 'prober')).toContain(': HTTP 200 in 48ms')
  })

  it('gives no trailing colon when there is no detail', () => {
    expect(cellLine(sweepCell({ state: 'nodata' }), 'sweep')).toBe('skipped')
    expect(cellLine(cell({ id: 'g' }), 'grafana')).toBe('evaluating normally')
  })

  it('says how long a check may be silent when its cell has gone stale', () => {
    expect(cellWords(sweepCell({ state: 'stale' }), 'sweep').replace(NBSP, ' ')).toBe('not run in the last 10 h')
    expect(cellWords(proberCell({ state: 'stale' }), 'prober').replace(NBSP, ' ')).toContain('5 min')
    expect(cellWords(cell({ id: 'g', state: 'stale' }), 'grafana')).toBe('not evaluated recently')
    expect(cellWords(sweepCell({ state: 'stale', staleAfterSec: undefined }), 'sweep')).toBe('not run recently')
  })

  const STATES: CellState[] = ['ok', 'pending', 'firing', 'nodata', 'error', 'stale', 'inferred']
  const ORIGINS: CellOrigin[] = ['grafana', 'vmalert', 'netdata-cloud', 'prober', 'sweep', 'check', 'other']
  it.each(ORIGINS)('has words for every state of %s, with no em dash and no empty string', (origin) => {
    for (const state of STATES) {
      const c = cell({ id: 'x', state, staleAfterSec: 300 })
      const words = cellWords(c, origin)
      expect(words, `${origin} ${state}`).not.toBe('')
      expect(words).not.toContain('\u2014')
      expect(cellShort(c, origin), `${origin} ${state}`).not.toBe('')
    }
  })

  it('words a history-only cell the same everywhere: an alert seen in the history, no rule behind it', () => {
    for (const origin of ORIGINS) expect(cellWords(cell({ id: 'h', state: 'inferred' }), origin)).toBe('seen in the alert history only')
  })
})

describe('the label map of the Sources page', () => {
  it('gives vmalert and Netdata Cloud human labels', () => {
    expect(kindLabel('vmalert')).toBe('Alert rules (vmalert)')
    expect(kindLabel('netdata-cloud')).toBe('Netdata Cloud, polled every minute')
  })

  it('keeps the labels the page already had', () => {
    expect(kindLabel('grafana')).toBe('Grafana alerting')
    expect(kindLabel('zulip')).toBe('Retired alert bridge poll (history only)')
    expect(kindLabel('webhook')).toBe('Webhook receiver')
    expect(kindLabel('self')).toBe('EZO Watcher')
  })

  it('labels every source kind in words, never by its raw name, and never with an em dash', () => {
    const all: SourceKind[] = ['grafana', 'zulip', 'webhook', 'self', 'vmalert', 'netdata-cloud', 'netdata-fleet', 'sentry', 'http-probe', 'tcp-probe', 'domain-expiry', 'feed', 'heartbeat', 'host']
    expect(Object.keys(KIND_LABEL).sort()).toEqual([...all].sort())
    for (const k of all) {
      expect(kindLabel(k)).not.toBe(k)
      expect(kindLabel(k)).not.toContain('\u2014')
    }
  })

  it('falls back to the raw name for a kind a newer server sends', () => {
    expect(kindLabel('brand-new' as SourceKind)).toBe('brand-new')
  })

  it('is what the Sources page prints for the two polled kinds', () => {
    const src = (id: string, kind: SourceKind, rules: number, firing: number): SourceStatus => ({ id, kind, name: id, state: 'ok', lastOk: ISO, lastAttempt: ISO, error: null, firing, rules, misses: 0 })
    const state = { generatedAt: ISO, header: {}, sources: [src('vmalert', 'vmalert', 70, 0), src('netdata-cloud', 'netdata-cloud', 7, 4)], incidents: [], health: [], channels: [] } as never
    const html = renderToStaticMarkup(createElement(Sources, { state, nowMs: NOW }))
    expect(html).toContain('Alert rules (vmalert). 70 rules, 0 firing.')
    expect(html).toContain('Netdata Cloud, polled every minute. 7 rules, 4 firing.')
  })
})

describe('the legend', () => {
  it('is the four shapes in one sentence each, solid, half, dashed and dotted', () => {
    expect(CELL_LEGEND.map((l) => l.state)).toEqual(['ok', 'pending', 'nodata', 'inferred'])
    const text = legendText()
    expect(text.startsWith('Solid: evaluating. Half: pending. Dashed: no data, error or stale. Dotted: ')).toBe(true)
    expect(text.replace(NBSP, ' ')).toContain('fired in the last 30 days')
    expect(text).toContain('no rule reports on it now')
  })

  it('has no em dash and keeps the number and its unit together', () => {
    expect(legendText()).not.toContain('\u2014')
    expect(legendText()).toContain(`30${NBSP}days`)
  })
})

describe('the strip a tile draws', () => {
  const dots = (html: string): number => (html.match(/class="cell"/g) ?? []).length
  const render = (cells: RuleCell[]): string => renderToStaticMarkup(createElement(Cells, { cells, kinds }))

  it('draws the 23 non-ok cells of a 122-cell tile and one count, never 122 cells', () => {
    const html = render([...many('ok', 99), ...many('pending', 11), ...many('nodata', 5), ...many('firing', 7)])
    // 23 cells for the non-ok rules and one solid marker beside the count
    expect(dots(html)).toBe(23 + 1)
    expect(html).toContain(`99${NBSP}ok`)
    expect(html).not.toContain('All ')
  })

  it('says "All 15 ok" for a tile whose rules are all ok, with one marker and no strip of dots', () => {
    const html = render(many('ok', 15))
    expect(dots(html)).toBe(1)
    expect(html).toContain(`All 15${NBSP}ok`)
  })

  it('draws every cell and no count when none is ok', () => {
    const html = render(many('nodata', 4))
    expect(dots(html)).toBe(4)
    expect(html).not.toMatch(new RegExp(`\\d${NBSP}ok`))
    expect(html).not.toContain('cells__ok')
  })

  it('names each drawn cell in the words of its source, with the reason', () => {
    const html = render([sweepCell({ state: 'nodata', detail: 'no credential for Cloudflare analytics' }), ...many('ok', 3)])
    expect(html).toContain('IntakeCfEdge5xx: skipped: no credential for Cloudflare analytics')
  })

  it('carries the text a tile falls back to when it cannot hold the cells', () => {
    const html = render([...many('ok', 4), ...many('pending', 3)])
    expect(html).toContain(`3${NBSP}not${NBSP}ok`)
  })
})

describe('the service sheet', () => {
  const health = {
    service: 'Regression sweep',
    firing: 0,
    cells: [
      sweepCell({ state: 'nodata', detail: 'no credential for Cloudflare analytics' }),
      sweepCell({ id: 'check:sweep:Regression sweep/FleetDisk', name: 'FleetDisk', checkId: 'FleetDisk', state: 'pending', detail: '2 yellow, not an alert: node-4 disk / 89.3%' }),
      cell({ id: 'grafana:disk', name: 'Host disk filling up (node-1)', state: 'pending' }),
      proberCell({ state: 'pending', detail: 'HTTP 503 in 31ms' }),
      cell({ id: 'ok-1', name: 'Fine rule' })
    ]
  }
  const html = renderToStaticMarkup(createElement(ServiceSheet, { health, from: { view: 'wall' }, nowMs: NOW, sources: SOURCES as SourceStatus[] }))

  it('says why a skipped check was skipped', () => {
    expect(html).toContain('skipped: no credential for Cloudflare analytics')
  })

  it('words pending per source and keeps the detail after it', () => {
    expect(html).toContain('pending, read in part: 2 yellow, not an alert: node-4 disk / 89.3%')
    expect(html).toContain('pending, inside its for-window')
    expect(html).toContain('pending, waiting before declaring down: HTTP 503 in 31ms')
  })

  it('lists the rows that need a look before the ones that are fine', () => {
    expect(html.indexOf('IntakeCfEdge5xx')).toBeLessThan(html.indexOf('Fine rule'))
    expect(html.indexOf('FleetDisk')).toBeLessThan(html.indexOf('Fine rule'))
    expect(html).toContain('evaluating normally')
  })

  it('has no em dash', () => {
    expect(html).not.toContain('\u2014')
  })

  it('says so, with one action, when no rule reports on the service now', () => {
    const empty = renderToStaticMarkup(createElement(ServiceSheet, { health: { service: 'Gone', cells: [], firing: 0 }, from: { view: 'wall' }, nowMs: NOW, sources: [] }))
    expect(empty).toContain('No rule or check reports on this service now.')
    expect(empty).toContain('Back to the wall')
    // the sheet's own Close is the only other control
    expect((empty.match(/class="btn"/g) ?? []).length).toBe(2)
  })
})
