// What a user relies on, pinned on the tier rule (src/shared/layout.ts, docs/design.md "The wall"): tile area follows severity, so a page is larger than a
// warning and a warning larger than a healthy service; warnings are compact and sit several to a row; every healthy service is a small cell that keeps its
// dots and its summary; a wall with more tiles than it has room for grows instead of shrinking a tile. The cases are the ones a live wall met:
// (a) 4 warnings and 35 healthy services, (b) 1 page, 3 warnings and 35 healthy, (c) 1 warning and 35 healthy, (d) 10 warnings and 35 healthy.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { allotWall, footprintOf, gridColumns, healthySpan, layoutWall, pageColumns, wallHeight } from '../src/shared/layout.ts'
import type { LayoutItem, LayoutOptions, Placed, TierRule } from '../src/shared/layout.ts'
import { linesHeld, titleShown, warningTitleLines, wrapLines } from '../src/shared/title-room.ts'
import type { RuleCell } from '../src/shared/types.ts'
import { NBSP } from '../src/web/lib/format.ts'
import { ServiceTile } from '../src/web/components/Wall.tsx'

// The tier rule's numbers are the tokens of src/web/styles/tokens.css, resolved: --wall-cell-min-w 128 and -min-h 74, -max-h 1.25 x that, -chrome-w 18,
// -dot-w 16, -ok-w 72, -dot-rows 2, -max-span 3; --wall-warning-cols and -rows 2; --wall-page-rows 3 (attended 2), -share 0.5, -min-cols 3.
const RULE: TierRule = {
  cell: { w: 128, h: 74 },
  cellMaxH: 92.5,
  chromeW: 18,
  dotW: 16,
  okW: 72,
  dotRows: 2,
  maxSpan: 3,
  warning: { cols: 2, rows: 2 },
  page: { rows: 3, rowsAttended: 2, share: 0.5, minCols: 3 }
}
const base = { gap: 8, firingMin: { w: 160, h: 120 }, quietMin: { w: 120, h: 96 }, tier: RULE }
// What the wall measures in the app under the header and the Fleet strip: 1440 x 900 leaves 1152 x 583, 1300 x 900 leaves 1012 x 583, 1024 x 768 leaves 736 x 433.
const W1440 = { width: 1152, height: 583 }
const W1300 = { width: 1012, height: 583 }
const W1024 = { width: 736, height: 433 }
// The old layout's flaw: four warning tiles of about 530 x 290 took 70% of the wall. A warning is now about a quarter of that.
const COMPLAINED_WARNING_AREA = 530 * 290

/** `warnings` unattended warnings, `pages` pages, and `healthy` services: the first needs 16 dots (a wider cell), some need a look, the rest are all ok. */
function wall(warnings: number, pages = 0, healthy = 35): LayoutItem[] {
  const items: LayoutItem[] = []
  for (let i = 0; i < pages; i++) items.push({ id: `p${i}`, tier: 'page', R: 8, firing: true })
  for (let i = 0; i < warnings; i++) items.push({ id: `w${i}`, tier: 'warning', R: 4 + (i % 3), firing: true })
  for (let i = 0; i < healthy; i++) {
    const marks = i === 0 ? 16 : i % 9 === 3 ? 1 : 0
    items.push({ id: `s${i}`, tier: 'quiet', R: 1 + (i % 5), firing: false, look: marks > 0, marks })
  }
  return items
}

const area = (b: { w: number; h: number }): number => b.w * b.h
const of = (out: Placed[], prefix: string): Placed[] => out.filter((p) => p.id.startsWith(prefix))

function run(items: LayoutItem[], size: { width: number; height: number }) {
  const opt: LayoutOptions = { ...size, ...base }
  const height = wallHeight(items, opt)
  const grown = { ...opt, height }
  return { opt: grown, height, out: layoutWall(items, grown), allot: allotWall(items, grown) }
}

const CASES: Array<[string, LayoutItem[]]> = [
  ['(a) 4 warnings', wall(4)],
  ['(b) 1 page and 3 warnings', wall(3, 1)],
  ['(c) 1 warning', wall(1)],
  ['(d) 10 warnings', wall(10)]
]

describe('the tier rule on the four cases, at 1440, 1300 and 1024 wide', () => {
  for (const [label, items] of CASES) {
    for (const [width, size] of [['1440 x 900', W1440], ['1300 x 900', W1300], ['1024 x 768', W1024]] as const) {
      describe(`${label}, ${width}`, () => {
        const r = run(items, size)

        it('places every tile, each inside the wall and none over another, and every tile holds its minimum', () => {
          expect(r.out).toHaveLength(items.length)
          expect(r.allot.holds).toBe(true)
          for (const p of r.out) {
            expect(p.x).toBeGreaterThanOrEqual(-0.001)
            expect(p.x + p.w).toBeLessThanOrEqual(size.width + 0.001)
            expect(p.y + p.h).toBeLessThanOrEqual(r.height + 0.001)
          }
          for (let i = 0; i < r.out.length; i++) {
            for (let j = i + 1; j < r.out.length; j++) {
              const a = r.out[i]
              const b = r.out[j]
              expect(a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01).toBe(false)
            }
          }
        })

        it('keeps the order of severity in area: a page is larger than a warning, a warning larger than a healthy service', () => {
          const smallest = (tiles: Placed[]): number => Math.min(...tiles.map(area))
          const largest = (tiles: Placed[]): number => Math.max(...tiles.map(area))
          const warnings = of(r.out, 'w')
          const healthy = of(r.out, 's')
          if (warnings.length && healthy.length) expect(smallest(warnings)).toBeGreaterThan(largest(healthy))
          const pages = of(r.out, 'p')
          if (pages.length && warnings.length) expect(smallest(pages)).toBeGreaterThan(largest(warnings))
        })

        it('is compact: a warning is about a quarter of the old warning area, and no warning is wider than the cells it spans', () => {
          for (const p of of(r.out, 'w')) {
            expect(area(p)).toBeLessThanOrEqual(COMPLAINED_WARNING_AREA * 0.4)
            expect(p.w).toBeLessThanOrEqual(RULE.warning.cols * (size.width / gridColumns(size.width, base.gap, RULE.cell)) + base.gap)
          }
        })

        it('lets no warning title be clipped to fewer than two lines: the tile holds two lines under its other rows, and the title is allowed two or three', () => {
          const chromeH = 94 // --wall-warning-chrome-h
          for (const p of of(r.out, 'w')) expect(linesHeld(p.h, chromeH, 20)).toBeGreaterThanOrEqual(2)
          expect(warningTitleLines(false, { lines: 3, attendedLines: 2 })).toBe(3)
          expect(warningTitleLines(true, { lines: 3, attendedLines: 2 })).toBe(2)
        })
      })
    }
  }
})

describe('(a) 4 warnings and 35 healthy services, the live state, at 1440 x 900', () => {
  const items = wall(4)
  const r = run(items, W1440)

  it('takes at most about 40% of the wall for the warnings, and every healthy service shows without the page scrolling', () => {
    expect(r.allot.warningShare).toBeLessThanOrEqual(0.4)
    expect(r.allot.warningShare).toBeGreaterThan(0.1)
    expect(r.height).toBe(W1440.height)
    expect(r.allot.rows * RULE.cell.h + (r.allot.rows - 1) * base.gap).toBeLessThanOrEqual(W1440.height)
    expect(of(r.out, 's')).toHaveLength(35)
  })

  it('puts the four warnings side by side in one row, above every healthy service', () => {
    const warnings = of(r.out, 'w')
    expect(new Set(warnings.map((p) => Math.round(p.y))).size).toBe(1)
    expect(warnings.map((p) => p.y)).toEqual([0, 0, 0, 0])
    const rowBottom = Math.max(...warnings.map((p) => p.y + p.h))
    // the healthy services that share the warnings' rows sit beside them, never above
    for (const p of of(r.out, 's')) expect(p.y + p.h).toBeGreaterThan(warnings[0].y + warnings[0].h / 2)
    expect(Math.min(...of(r.out, 's').map((p) => p.y))).toBeGreaterThanOrEqual(0)
    expect(rowBottom).toBeLessThan(W1440.height / 2)
  })

  it('gives a healthy service a cell about half the area of the quiet tile it was before, and a service with many dots a wider one', () => {
    const quietTile = 187 * 95 // the roomy quiet tile of the earlier wall
    for (const p of of(r.out, 's')) expect(area(p)).toBeLessThanOrEqual(quietTile * 0.5 * 1.7 * (p.w > RULE.cell.w * 1.5 ? 2.2 : 1))
    const first = r.out.find((p) => p.id === 's0') as Placed
    const second = r.out.find((p) => p.id === 's1') as Placed
    expect(first.w).toBeGreaterThan(second.w * 1.8)
  })
})

describe('(b) 1 page, 3 warnings and 35 healthy services, at 1440 x 900', () => {
  const r = run(wall(3, 1), W1440)
  const page = r.out.find((p) => p.id === 'p0') as Placed

  it('lets the page dominate: top-left, half the columns wide, at least twice the area of any warning and 4 times any healthy cell, a wide one too', () => {
    expect(page.x).toBe(0)
    expect(page.y).toBe(0)
    expect(page.w).toBeGreaterThan(W1440.width * 0.45)
    for (const p of of(r.out, 'w')) expect(area(page)).toBeGreaterThanOrEqual(2 * area(p))
    for (const p of of(r.out, 's')) expect(area(page)).toBeGreaterThanOrEqual(4 * area(p))
  })

  it('keeps the warnings compact beside the page, and the page the largest single tile', () => {
    for (const p of of(r.out, 'w')) expect(area(p)).toBeLessThanOrEqual(COMPLAINED_WARNING_AREA * 0.4)
    expect(Math.max(...r.out.map(area))).toBe(area(page))
    expect(r.allot.pageShare).toBeGreaterThan(r.allot.warningShare)
  })
})

describe('(c) 1 warning and 35 healthy services, at 1440 x 900', () => {
  const r = run(wall(1), W1440)
  it('is one compact warning at the top-left over a dense grid of healthy cells that fills the wall without scrolling', () => {
    const w = of(r.out, 'w')[0]
    expect([w.x, w.y]).toEqual([0, 0])
    expect(area(w)).toBeLessThanOrEqual(COMPLAINED_WARNING_AREA * 0.4)
    expect(r.height).toBe(W1440.height)
    expect(r.allot.warningShare).toBeLessThan(0.15)
  })
})

describe('(d) 10 warnings and 35 healthy services', () => {
  const items = wall(10)
  const r = run(items, W1440)

  it('grows the wall rather than shrinking a tile, and the growth is the smallest that holds them', () => {
    expect(r.height).toBeGreaterThan(W1440.height)
    expect(allotWall(items, { ...W1440, ...base, height: r.height }).holds).toBe(true)
    expect(allotWall(items, { ...W1440, ...base, height: r.height - (RULE.cell.h + base.gap) }).holds).toBe(false)
    for (const p of r.out) expect(p.h).toBeGreaterThanOrEqual(RULE.cell.h - 0.001)
  })

  it('keeps every warning the same compact size as with four, four to a row', () => {
    const four = of(run(wall(4), W1440).out, 'w')
    for (const p of of(r.out, 'w')) {
      expect(p.w).toBeCloseTo(four[0].w, 3)
      expect(p.h).toBeCloseTo(RULE.cell.h * RULE.warning.rows + base.gap * (RULE.warning.rows - 1), 3)
    }
    const rows = new Map<number, number>()
    for (const p of of(r.out, 'w')) rows.set(p.y, (rows.get(p.y) ?? 0) + 1)
    expect([...rows.values()].sort()).toEqual([2, 4, 4])
  })
})

describe('the tier rule as a pure function', () => {
  const colW = 137
  const warning: LayoutItem = { id: 'w', tier: 'warning', R: 4, firing: true }
  const page: LayoutItem = { id: 'p', tier: 'page', R: 4, firing: true }
  const cell: LayoutItem = { id: 's', tier: 'quiet', R: 2, firing: false }

  it('gives a page a block half the columns wide and three rows tall, a warning two by two, a healthy service one cell', () => {
    expect(footprintOf(page, 8, colW, 8, RULE)).toEqual({ cols: 4, rows: 3 })
    expect(footprintOf(warning, 8, colW, 8, RULE)).toEqual({ cols: 2, rows: 2 })
    expect(footprintOf(cell, 8, colW, 8, RULE)).toEqual({ cols: 1, rows: 1 })
  })

  it('keeps page > warning > healthy in area at every width, whatever the reach or the age', () => {
    for (const cols of [4, 5, 6, 7, 8, 9, 12]) {
      for (const R of [1, 4, 24]) {
        const area = (it: LayoutItem): number => {
          const f = footprintOf({ ...it, R }, cols, colW, 8, RULE)
          return f.cols * f.rows
        }
        expect(area(page)).toBeGreaterThan(area(warning))
        expect(area(warning)).toBeGreaterThan(area(cell))
      }
    }
  })

  it('makes an acknowledged page shorter than an unattended one, and still larger than a warning', () => {
    const acked = footprintOf({ ...page, attended: true }, 8, colW, 8, RULE)
    expect(acked.rows).toBeLessThan(footprintOf(page, 8, colW, 8, RULE).rows)
    expect(acked.cols * acked.rows).toBeGreaterThan(RULE.warning.cols * RULE.warning.rows)
  })

  it('treats an acknowledged or a silenced incident as a warning, never as a healthy service', () => {
    const silenced: LayoutItem = { id: 'q', tier: 'quiet', R: 1, firing: true }
    expect(footprintOf(silenced, 8, colW, 8, RULE)).toEqual({ cols: 2, rows: 2 })
    expect(footprintOf({ ...warning, attended: true }, 8, colW, 8, RULE)).toEqual({ cols: 2, rows: 2 })
  })

  it('widens a healthy cell only when its dots do not fit one column: one column holds 9, two hold 27, never more than three', () => {
    expect([0, 1, 9].map((m) => healthySpan(m, colW, 8, RULE))).toEqual([1, 1, 1])
    expect([10, 16, 27].map((m) => healthySpan(m, colW, 8, RULE))).toEqual([2, 2, 2])
    expect([28, 200].map((m) => healthySpan(m, colW, 8, RULE))).toEqual([3, 3])
  })

  it('counts the columns the width holds, and spans a page over half of them', () => {
    expect([1152, 1012, 736, 640].map((w) => gridColumns(w, 8, RULE.cell))).toEqual([8, 7, 5, 4])
    expect([8, 7, 5, 4].map((c) => pageColumns(c, RULE))).toEqual([4, 4, 3, 3])
  })
})

describe('what stays', () => {
  const opt = { ...W1440, ...base }

  it('puts an acknowledged or silenced incident after the unattended ones of its tier, whatever its weight, above the healthy cells', () => {
    const items: LayoutItem[] = [
      { id: 'i-acked', tier: 'warning', R: 12, attended: true, firing: true },
      { id: 'i-unattended', tier: 'warning', R: 2, firing: true },
      { id: 'i-silenced', tier: 'quiet', R: 1, firing: true },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, tier: 'quiet' as const, R: 1, firing: false }))
    ]
    const ids = layoutWall(items, opt).map((p) => p.id)
    expect(ids.indexOf('i-unattended')).toBe(0)
    expect(ids.slice(1, 3)).toEqual(['i-acked', 'i-silenced'])
    const out = layoutWall(items, opt)
    const silenced = out.find((p) => p.id === 'i-silenced') as Placed
    for (const p of of(out, 's')) expect(p.y + p.h).toBeGreaterThan(silenced.y)
  })

  it('leads the healthy cells with the services that need a look', () => {
    const items: LayoutItem[] = [
      { id: 'i0', tier: 'warning', R: 4, firing: true },
      ...Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, tier: 'quiet' as const, R: 5 - (i % 5), firing: false, look: i === 9, marks: i === 9 ? 2 : 0 }))
    ]
    const cells = of(layoutWall(items, opt), 's')
    const first = cells.reduce((a, b) => (b.y < a.y || (b.y === a.y && b.x < a.x) ? b : a))
    expect(first.id).toBe('s9')
  })

  it('lays a wall of healthy services alone out as the same cells (calm, top-left, never larger than the cap), and a wall of incidents alone on the grid too', () => {
    const quiet: LayoutItem[] = Array.from({ length: 36 }, (_, i) => ({ id: `s${i}`, tier: 'quiet', R: 1 + (i % 3), firing: false, marks: i === 0 ? 16 : 0, look: i === 0 }))
    const r = run(quiet, W1440)
    expect(r.out).toHaveLength(36)
    expect(r.allot.rows).toBeLessThanOrEqual(5)
    expect(r.height).toBe(W1440.height)
    for (const p of r.out) {
      expect(p.w).toBeGreaterThanOrEqual(base.tier.cell.w - 0.001)
      expect(p.h).toBeLessThanOrEqual(RULE.cellMaxH + 0.001)
    }
    expect(r.allot.healthyShare).toBeGreaterThan(0.6)
    const loud: LayoutItem[] = [
      { id: 'i0', tier: 'page', R: 8, firing: true },
      { id: 'i1', tier: 'warning', R: 4, firing: true }
    ]
    expect(allotWall(loud, opt).healthyShare).toBe(0)
    expect(allotWall(loud, opt).cols).toBeGreaterThan(0)
  })

  it('lays the healthy services out as a treemap when no tier rule is given, as before', () => {
    const { tier, ...plain } = opt
    void tier
    expect(allotWall(wall(4), plain).cols).toBe(0)
  })

  it('is stable: the same wall in another order is the same layout', () => {
    const items = wall(4)
    expect(layoutWall([...items].reverse(), opt)).toEqual(layoutWall(items, opt))
  })
})

describe('a healthy cell keeps its dots and its summary', () => {
  const cellOf = (state: RuleCell['state'], i: number): RuleCell => ({ id: `${state}-${i}`, source: 'grafana', name: `${state} ${i}`, service: 'Svc', state, evaluatedAt: '2026-10-15T16:39:00.000Z' })
  const tile = (cells: RuleCell[], wide = false): string =>
    renderToStaticMarkup(
      createElement(ServiceTile, {
        tile: { id: 's:Svc', tier: 'quiet', R: cells.length, kind: 'service' },
        health: { service: 'Svc', cells, firing: 0 },
        wide,
        style: undefined,
        active: true,
        onFocus: () => undefined,
        kinds: { grafana: 'grafana' }
      })
    )

  it('shows the name, one dot for each rule that is not ok (worst first), and "All 70 ok" or "107 ok" for the rest', () => {
    const allOk = tile(Array.from({ length: 70 }, (_, i) => cellOf('ok', i)))
    expect(allOk).toContain('data-size="cell"')
    expect(allOk).toContain('Svc')
    expect(allOk).toContain(`All 70${NBSP}ok`)
    expect(allOk).toContain('data-state="ok"')
    const look = tile([...Array.from({ length: 3 }, (_, i) => cellOf('pending', i)), cellOf('nodata', 0), ...Array.from({ length: 107 }, (_, i) => cellOf('ok', i))])
    expect(look).toContain(`107${NBSP}ok`)
    expect(look.match(/data-state="pending"/g)).toHaveLength(3)
    expect(look).toContain('data-state="nodata"')
    expect(look).toContain('data-look="true"')
    expect(allOk).not.toContain('data-look')
  })

  it('names the shapes in words: each dot has the rule and its state as its accessible name', () => {
    const html = tile([cellOf('pending', 0), cellOf('ok', 0)])
    expect(html).toMatch(/aria-label="pending 0: [^"]+"/)
  })
})

describe('a long warning title', () => {
  const measure = (text: string): number => text.length * 8
  const long = 'Gateway Envoy failures (own 5xx, connect fails, timeouts) at least 4x the same hour of the past week (back under its line now, held open 30 minutes after the last breach)'

  it('shows three lines of a title that needs more, two once the tile also says who has it, and says it is not whole', () => {
    const w = 282
    expect(wrapLines(long, w - 28, measure)).toBeGreaterThan(3)
    expect(titleShown(long, w, 28, measure, warningTitleLines(false, { lines: 3, attendedLines: 2 }))).toEqual({ lines: 3, whole: false })
    expect(titleShown(long, w, 28, measure, warningTitleLines(true, { lines: 3, attendedLines: 2 }))).toEqual({ lines: 2, whole: false })
  })

  it('shows a short title whole in the lines it needs, never fewer than one', () => {
    expect(titleShown('Replica pg-node-13 is 74 s behind', 282, 28, measure, 3)).toEqual({ lines: 2, whole: true })
    expect(titleShown('Disk on node-13 is 64% full, filling 5 GB/h', 282, 28, measure, 3).whole).toBe(true)
  })
})
