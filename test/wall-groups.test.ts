// Wall groups (docs/design.md, "Wall groups"): the category grouping is for the FIRING tiles. The incidents sit in a section per group that has one, each under a heading
// with its counts and every tile naming its group; the healthy services are ONE flat grid below them, in the order they had before there were groups, with no heading
// between them. A Group toggle (stored in localStorage, on by default) turns the sections off: the band is flat as it was, the tiles still name their group.
// What a user relies on, pinned: the groups are defined once in config/watch.example.json and every live service is in exactly one of them; the validation catches a service listed
// twice, a reserved name and (against a roster) a name no service has; a service no group lists falls into Other; the layout's sections run worst first, each on a fresh row
// under a full-width heading of its own height; the healthy cells are one grid below the last section, identical to the ungrouped wall when nothing fires; the stored choice
// defaults on and survives; a stacked page tile has a share-of-height cap and a dense form; the markup has a real h2 per group.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { checkWallGroups, configServiceNames, loadConfig } from '../src/server/config.ts'
import type { WatchConfig } from '../src/server/config.ts'
import { makeAlert } from '../src/server/derive.ts'
import { openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'
import { allotWall, groupHeadId, incidentGroupOrder, layoutWall, wallHeight } from '../src/shared/layout.ts'
import type { LayoutItem, LayoutOptions, TierRule } from '../src/shared/layout.ts'
import { OTHER_GROUP, groupLookup, groupsInOrder, serviceKey, wallGroupProblems } from '../src/shared/wall-groups.ts'
import type { WallGroupDef } from '../src/shared/wall-groups.ts'
import { NBSP } from '../src/web/lib/format.ts'
import { GROUPED_KEY, readGrouped, writeGrouped } from '../src/web/lib/wall-prefs.ts'
import { GroupHead, IncidentTile, ServiceTile, groupCountText, wallEntries } from '../src/web/components/Wall.tsx'
import type { Tile } from '../src/web/components/Wall.tsx'

/** The categories an operator would write: one per kind of thing, each naming its services. */
const GROUPS: WallGroupDef[] = [
  { id: 'product', label: 'Product', services: ['Web', 'Worker'] },
  { id: 'reliability', label: 'Reliability signals', services: ['Sweep'] },
  { id: 'infrastructure', label: 'Infrastructure', services: ['Host disks', 'ClickHouse'] },
  { id: 'external', label: 'External and vendors', services: ['Status page'] }
]
const roster = GROUPS.flatMap((g) => g.services)
const baseCfg: WatchConfig = {
  baseUrl: 'https://watch.example.com',
  dataDir: ':memory:',
  historyHours: 24,
  staleAfterMisses: 3,
  sources: [],
  serviceMap: [{ match: { labels: { component: '^host-disk$' } }, service: 'Host disks' }],
  channels: [],
  routes: [],
  quietHours: null,
  wallGroups: GROUPS
}
const cfg = baseCfg
const groups = GROUPS
const tokens = readFileSync('src/web/styles/tokens.css', 'utf8')

describe('config: the groups are defined once and every live service is in exactly one', () => {
  it('defines the categories in order, Other not among them', () => {
    expect(groups.map((g) => g.label)).toEqual(['Product', 'Reliability signals', 'Infrastructure', 'External and vendors'])
    expect(groupsInOrder(groups).map((g) => g.label)).toEqual(['Product', 'Reliability signals', 'Infrastructure', 'External and vendors', 'Other'])
  })

  it('files every live service in a group of its own (nothing falls into Other today)', () => {
    const lookup = groupLookup(groups)
    expect(roster.length).toBeGreaterThan(0)
    const strays = roster.filter((s) => lookup(s).id === OTHER_GROUP.id)
    expect(strays).toEqual([])
  })

  it('files a tile by the service label or by the source id, whichever names it', () => {
    const lookup = groupLookup(groups)
    expect(lookup('Host disks').id).toBe('infrastructure')
    expect(lookup('Sweep').id).toBe('reliability')
  })

  it('lists no service twice, across groups or inside one, and every listed name is a service the wall has', () => {
    expect(wallGroupProblems(groups)).toEqual([])
    const known = new Set([...roster, ...configServiceNames(baseCfg), 'Watcher self-test'])
    expect(wallGroupProblems(groups, known)).toEqual([])
  })

  it('is read without regard to case or separators, so a history row and a tile of one service are one', () => {
    const lookup = groupLookup(groups)
    expect(serviceKey('Node-disk')).toBe(serviceKey('node disk'))
    expect(lookup('host disks').id).toBe('infrastructure')
    expect(lookup('sweep').id).toBe('reliability')
    expect(lookup('clickhouse').id).toBe('infrastructure')
    expect(lookup('Clickhouse').id).toBe('infrastructure')
    expect(lookup('Something new').id).toBe('other')
    expect(lookup('Something new').order).toBe(groups.length)
  })
})

describe('validation: a bad list of groups fails the load, naming what to change', () => {
  const g = (id: string, services: string[], label = id): WallGroupDef => ({ id, label, services })
  it('catches a service in two groups, twice in one group, and names both places', () => {
    expect(wallGroupProblems([g('a', ['Host disks']), g('b', ['host disks'])]).join(' ')).toMatch(/"host disks" is in two places: a and b/)
    expect(wallGroupProblems([g('a', ['Host disks', 'Host-disks'])]).join(' ')).toMatch(/in two places: a and a/)
    expect(() => checkWallGroups([g('a', ['Host disks']), g('b', ['Host disks'])])).toThrow(/config: .*two places/)
  })
  it('catches a service the wall does not have (against a roster), the reserved Other, an empty group and a malformed list', () => {
    const known = new Set(['Host disks'])
    expect(wallGroupProblems([g('a', ['Host disks', 'Host disk'])], known).join(' ')).toMatch(/lists "Host disk", which is not a service the wall has/)
    expect(wallGroupProblems([g('other', ['Host disks'])]).join(' ')).toMatch(/"other" is reserved/)
    expect(wallGroupProblems([g('a', ['Host disks'], 'Other')]).join(' ')).toMatch(/"Other" is reserved/)
    expect(wallGroupProblems([g('a', [])]).join(' ')).toMatch(/needs services/)
    expect(wallGroupProblems([g('a', ['x']), g('a', ['y'])]).join(' ')).toMatch(/duplicate group id a/)
    expect(wallGroupProblems([g('A b', ['x'])]).join(' ')).toMatch(/needs an id/)
    expect(wallGroupProblems('nope')).toEqual(['wallGroups must be a list of groups'])
    expect(wallGroupProblems(undefined)).toEqual([])
  })
  it('loadConfig refuses a config file whose groups list one service twice', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wall-groups-'))
    const file = join(dir, 'watch.json')
    const raw = JSON.parse(readFileSync('config/watch.example.json', 'utf8')) as unknown as { wallGroups: WallGroupDef[]; [k: string]: unknown }
    raw.wallGroups = [{ id: 'a', label: 'A', services: ['Host disks'] }, { id: 'b', label: 'B', services: ['host disks'] }]
    writeFileSync(file, JSON.stringify(raw))
    expect(() => loadConfig(file)).toThrow(/"host disks" is in two places: a and b/)
  })
  it('a service no group lists is not an error: the wall files it under Other', () => {
    expect(wallGroupProblems([g('a', ['Host disks'])])).toEqual([])
    expect(groupLookup([g('a', ['Host disks'])])('Backups')).toMatchObject({ id: 'other', label: 'Other', order: 1 })
  })
})

describe('the state carries the groups from the config', () => {
  it('wall() answers config wallGroups, and a config with none answers none', () => {
    const e = new Engine(openDb(':memory:'), cfg)
    expect(e.wall().wallGroups).toEqual(cfg.wallGroups)
    const bare = new Engine(openDb(':memory:'), { ...cfg, wallGroups: undefined })
    expect('wallGroups' in bare.wall()).toBe(false)
  })
})

// ---- the layout ---------------------------------------------------------------------------------------------------------------

const RULE: TierRule = {
  cell: { w: 128, h: 74 },
  cellMaxH: 92.5,
  chromeW: 18,
  dotW: 16,
  okW: 72,
  dotRows: 2,
  maxSpan: 3,
  warning: { cols: 2, rows: 2 },
  page: { rows: 3, rowsAttended: 2, share: 0.5, minCols: 3 },
  head: 40
}
const IDS = ['product', 'reliability', 'infrastructure', 'external']
const base = { gap: 8, firingMin: { w: 160, h: 120 }, quietMin: { w: 120, h: 96 }, tier: RULE }
const { tier: _tier, ...geometry } = base

/**
 * The incidents a live wall met, across three groups: a page and a warning in infrastructure, a page in reliability, an acknowledged warning in product, a silenced one in
 * external; and 25 healthy cells (none filed in a group: the cells are one grid), two of them needing a look.
 */
function wall(withIncidents = true): LayoutItem[] {
  const items: LayoutItem[] = []
  if (withIncidents) {
    items.push({ id: 'p-infra', tier: 'page', R: 8, firing: true, group: 'infrastructure' })
    items.push({ id: 'p-rel', tier: 'page', R: 8, firing: true, group: 'reliability' })
    items.push({ id: 'w-infra', tier: 'warning', R: 4, firing: true, group: 'infrastructure' })
    items.push({ id: 'w-prod', tier: 'warning', R: 2, firing: true, attended: true, group: 'product' })
    items.push({ id: 'w-ext', tier: 'quiet', R: 1, firing: true, attended: true, group: 'external' })
  }
  for (let i = 0; i < 25; i++) items.push({ id: `s${String(i).padStart(2, '0')}`, tier: 'quiet', R: 1 + (i % 5), firing: false, look: i === 3 || i === 11, marks: i === 3 ? 16 : i === 11 ? 1 : 0 })
  return items
}

function run(items: LayoutItem[], width: number, height: number, groups: string[] | null = IDS) {
  const opt: LayoutOptions = { width, height, ...geometry, tier: RULE, groups: groups ?? undefined }
  const h = wallHeight(items, opt)
  const full = { ...opt, height: h }
  return { out: layoutWall(items, full), allot: allotWall(items, full), height: h, opt: full }
}

const isCell = (id: string): boolean => /^s\d/.test(id)
const isHead = (id: string): boolean => id.startsWith('group:')
type P = ReturnType<typeof run>['out'][number]
const byReading = (a: P, b: P): number => a.y - b.y || a.x - b.x

describe('the layout: the incidents in a section per group, the healthy cells one grid below', () => {
  for (const [name, width, height] of [['1440', 1152, 583], ['1024', 736, 433], ['a panel of 700', 676, 700]] as const) {
    it(`at ${name}: a heading for each group that has an incident, worst first, each a full-width row of --wall-group-head-h, and none for a group with none`, () => {
      const { out, allot } = run(wall(), width, height)
      const heads = out.filter((p) => isHead(p.id))
      // the pages first (reliability and infrastructure, in the config's order), then the warnings (product), then the silenced one (external)
      expect(heads.map((h) => h.id)).toEqual(['reliability', 'infrastructure', 'product', 'external'].map(groupHeadId))
      for (const h of heads) {
        expect(h.w).toBe(width)
        expect(h.h).toBe(RULE.head)
        expect(h.x).toBe(0)
      }
      expect(allot.heads).toBe(4)
      expect(out.filter((p) => !isHead(p.id) && !isCell(p.id))).toHaveLength(5)
    })

    it(`at ${name}: an incident sits under its own group's heading and above the next one, so no row is shared by two sections`, () => {
      const { out } = run(wall(), width, height)
      const head = (g: string): P => out.find((p) => p.id === groupHeadId(g)) as P
      const sections: Array<[string, string[]]> = [['reliability', ['p-rel']], ['infrastructure', ['p-infra', 'w-infra']], ['product', ['w-prod']], ['external', ['w-ext']]]
      sections.forEach(([g, ids], k) => {
        const top = head(g).y + head(g).h
        const next = sections[k + 1] ? head(sections[k + 1][0]).y : Number.POSITIVE_INFINITY
        for (const id of ids) {
          const p = out.find((x) => x.id === id) as P
          expect(p.y, `${id} under ${g}`).toBeGreaterThanOrEqual(top)
          expect(p.y + p.h, `${id} above the next heading`).toBeLessThanOrEqual(next + 0.001)
        }
        // the first row of a section is the row right under its heading
        expect(Math.min(...ids.map((id) => (out.find((x) => x.id === id) as P).y))).toBeCloseTo(top + base.gap, 3)
      })
    })

    it(`at ${name}: the healthy cells are one grid on the rows below the last section, with no heading among them`, () => {
      const { out } = run(wall(), width, height)
      const cells = out.filter((p) => isCell(p.id))
      expect(cells).toHaveLength(25)
      const sectionsBottom = Math.max(...out.filter((p) => !isCell(p.id)).map((p) => p.y + p.h))
      expect(Math.min(...cells.map((c) => c.y))).toBeGreaterThanOrEqual(sectionsBottom + base.gap - 0.001)
      // no heading's row is between two cells
      const heads = out.filter((p) => isHead(p.id))
      for (const h of heads) expect(cells.every((c) => c.y > h.y), `a cell above ${h.id}`).toBe(true)
      // and the cells share rows: more than one column is used
      expect(new Set(cells.map((c) => c.x)).size).toBeGreaterThan(1)
    })

    it(`at ${name}: nothing overlaps, and the wall is as tall as its rows need`, () => {
      const { out, height: h } = run(wall(), width, height)
      for (let a = 0; a < out.length; a++) {
        expect(out[a].x).toBeGreaterThanOrEqual(0)
        expect(out[a].x + out[a].w).toBeLessThanOrEqual(width + 0.001)
        expect(out[a].y + out[a].h).toBeLessThanOrEqual(h + 0.001)
        for (let b = a + 1; b < out.length; b++) {
          const p = out[a]
          const q = out[b]
          const apart = p.x + p.w <= q.x + 0.001 || q.x + q.w <= p.x + 0.001 || p.y + p.h <= q.y + 0.001 || q.y + q.h <= p.y + 0.001
          expect(apart, `${p.id} and ${q.id} overlap`).toBe(true)
        }
      }
    })

    it(`at ${name}: the healthy cells keep the order they had before groups (the ones needing a look first, then by weight, then by name), the same grouped or not`, () => {
      const on = run(wall(), width, height).out.filter((p) => isCell(p.id)).sort(byReading).map((p) => p.id)
      const off = run(wall(), width, height, null).out.filter((p) => isCell(p.id)).sort(byReading).map((p) => p.id)
      expect(on).toEqual(off)
    })
  }

  it('a wall with nothing firing is the ungrouped wall, to the pixel, whatever the toggle says', () => {
    const items = wall(false)
    const on = run(items, 1152, 583)
    const off = run(items, 1152, 583, null)
    expect(on.out).toEqual(off.out)
    expect(on.height).toBe(off.height)
    expect(on.allot.heads).toBe(0)
    expect(Math.min(...on.out.map((p) => p.y))).toBe(0)
  })

  it('with the toggle off (no groups) there are no headings and the cells pack around the incidents, as before there were groups', () => {
    const { out, allot } = run(wall(), 1152, 583, null)
    expect(out.some((p) => isHead(p.id))).toBe(false)
    expect(allot.heads).toBe(0)
    // a healthy cell sits beside the incidents of the first rows, in the space they leave
    const firstCellY = Math.min(...out.filter((p) => isCell(p.id)).map((p) => p.y))
    const lastIncidentBottom = Math.max(...out.filter((p) => !isCell(p.id)).map((p) => p.y + p.h))
    expect(firstCellY).toBeLessThan(lastIncidentBottom)
  })

  it('keeps the tier rule inside a section: a page is larger than a warning, a warning larger than a cell', () => {
    const { out } = run(wall(), 1152, 583)
    const area = (id: string): number => {
      const p = out.find((x) => x.id === id) as P
      return p.w * p.h
    }
    expect(area('p-infra')).toBeGreaterThan(area('w-infra'))
    expect(area('w-infra')).toBeGreaterThan(area('s00'))
  })

  it('a heading row keeps its own height whatever the cell rows stretch to', () => {
    const { out, allot } = run(wall(), 1152, 1400)
    for (const h of out.filter((p) => isHead(p.id))) expect(h.h).toBe(RULE.head)
    expect(allot.rowH).toBeLessThanOrEqual(RULE.cellMaxH)
  })

  it('an incident whose group the list does not know follows the listed groups under its own heading, never dropped', () => {
    const items: LayoutItem[] = [...wall(), { id: 'w-new', tier: 'warning', R: 1, firing: true, group: 'other' }]
    const { out } = run(items, 1152, 583)
    expect(out.filter((p) => isHead(p.id)).map((p) => p.id)).toContain(groupHeadId('other'))
    expect(out.some((p) => p.id === 'w-new')).toBe(true)
  })

  it('orders the sections by their worst incident, then by the config order', () => {
    const it = (id: string, tier: 'page' | 'warning' | 'quiet', group: string, attended = false): LayoutItem => ({ id, tier, R: 5, firing: true, group, attended })
    expect(incidentGroupOrder([it('a', 'warning', 'product'), it('b', 'page', 'external'), it('c', 'warning', 'reliability', true)], IDS)).toEqual(['external', 'product', 'reliability'])
    // alike in severity: the config's order, whatever the weights or ids
    expect(incidentGroupOrder([it('z', 'page', 'infrastructure'), it('a', 'page', 'product')], IDS)).toEqual(['product', 'infrastructure'])
    // a group the list does not know after the listed ones of its severity; healthy cells never make a section
    expect(incidentGroupOrder([it('a', 'warning', 'mystery'), it('b', 'warning', 'external'), { id: 'c', tier: 'quiet', R: 1, firing: false, group: 'product' }], IDS)).toEqual(['external', 'mystery'])
    expect(incidentGroupOrder([it('a', 'page', 'mystery'), it('b', 'warning', 'external')], IDS)).toEqual(['mystery', 'external'])
  })
})

describe('the Group toggle: stored in localStorage, on by default', () => {
  const store = (initial?: string): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; data: Map<string, string> } => {
    const data = new Map<string, string>(initial === undefined ? [] : [[GROUPED_KEY, initial]])
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
  }
  it('is on with nothing stored, off only when stored as 0, and survives a reload', () => {
    expect(readGrouped(store())).toBe(true)
    expect(readGrouped(store('1'))).toBe(true)
    expect(readGrouped(store('0'))).toBe(false)
    expect(readGrouped(store('garbage'))).toBe(true)
    const s = store()
    writeGrouped(false, s)
    expect(s.data.get(GROUPED_KEY)).toBe('0')
    expect(readGrouped(s)).toBe(false)
    writeGrouped(true, s)
    expect(s.data.get(GROUPED_KEY)).toBe('1')
    expect(readGrouped(s)).toBe(true)
  })
  it('is on, and does not throw, with no storage at all or storage that refuses', () => {
    expect(readGrouped(null)).toBe(true)
    expect(() => writeGrouped(false, null)).not.toThrow()
    const hostile = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(readGrouped(hostile)).toBe(true)
    expect(() => writeGrouped(false, hostile)).not.toThrow()
  })
  it('is one key, not the By service or By host choice, so a person can have either with or without headings', () => {
    expect(GROUPED_KEY).toBe('watch-grouped')
    expect(readFileSync('src/web/App.tsx', 'utf8')).toContain("localStorage.getItem('watch-group')")
  })
  it('has a button in the toolbar by the By service and By host buttons (By service only), a C key that flips it, and a line in the footer hint', () => {
    const app = readFileSync('src/web/App.tsx', 'utf8')
    expect(app).toMatch(/aria-label="Group by"[\s\S]*By host[\s\S]*group === 'service' && \([\s\S]*aria-pressed=\{groupOn\}[\s\S]*Group\s*<\/button>/)
    expect(app).toMatch(/e\.key === 'c' && route\.view === 'wall' && group === 'service'\) setGroupOn\(!groupOn\)/)
    expect(app).toContain('C turns the category headings on or off.')
    // the keys already taken are untouched: g flips the grouping, the views keep theirs, Enter, A and S are the wall's
    expect(app).toMatch(/const go: Record<string, View> = \{ w: 'wall', f: 'fleet', h: 'history', n: 'notifications', o: 'sources' \}/)
    expect(Object.keys({ w: 1, f: 1, h: 1, n: 1, o: 1, g: 1, a: 1, s: 1 })).not.toContain('c')
  })
  it('the embed draws no toolbar: the panel follows the stored choice through the wall itself (the wall reads it, so Embed.tsx passes nothing)', () => {
    expect(readFileSync('src/web/components/Wall.tsx', 'utf8')).toMatch(/const \[groupOn\] = useGrouped\(\)/)
    expect(readFileSync('src/web/views/Embed.tsx', 'utf8')).toMatch(/<Wall state=\{state\} nowMs=\{nowMs\} group="service" onReload=\{reload\} \/>/)
  })
})

describe('the narrow wall (a phone, the chat panel): a page tile follows the visible height, so the first healthy row is in the first screen', () => {
  const token = (name: string): string => (tokens.match(new RegExp(`${name}:\\s*([^;]+);`)) as RegExpMatchArray)[1].trim()
  const css = readFileSync('src/web/styles/wall.css', 'utf8')
  const share = Number(token('--stack-page-share'))
  const floor = 160 // --stack-page-floor = spacing-40 x 4
  const roomy = 212 // --stack-page-roomy-h = spacing-48 x 4 + spacing-20
  const cap = (viewport: number): number => Math.max(floor, share * viewport)

  it('is capped by tokens: a share of the visible height under the 30% the judge asked for, never under the dense page, and a heading is one tile step', () => {
    expect(share).toBeGreaterThan(0)
    expect(share).toBeLessThanOrEqual(0.3)
    expect(token('--stack-page-floor')).toBe('calc(var(--spacing-40) * 4)')
    expect(token('--stack-page-max-h')).toBe('max(var(--stack-page-floor), calc(var(--stack-page-share) * 100dvh))')
    expect(token('--stack-page-roomy-h')).toBe('calc(var(--spacing-48) * 4 + var(--spacing-20))')
    expect(token('--wall-group-head-h')).toBe('var(--tile-step)')
    // the page has no min-height of its own on the stacked wall: it is as tall as its rows, up to the cap
    expect(css).toMatch(/\.wall\[data-stack='true'\] \.tile\[data-tier='page'\] \{[^}]*max-height: var\(--stack-page-max-h\)/)
    expect(css).not.toMatch(/\.wall\[data-stack='true'\] \.tile\[data-tier='page'\] \{[^}]*min-height/)
  })

  it('titles a stacked page at the title step in three lines, two in the dense form, and the dense form shares the age with its word on one row', () => {
    expect(token('--stack-page-title-lines')).toBe('3')
    expect(token('--stack-page-title-lines-dense')).toBe('2')
    expect(css).toMatch(/\.wall\[data-stack='true'\] \.tile\[data-tier='page'\] \{[^}]*--title-lines: var\(--stack-page-title-lines\)/)
    expect(css).toMatch(/\[data-dense='true'\] \.tile\[data-tier='page'\] \{[^}]*--title-lines: var\(--stack-page-title-lines-dense\)/)
    expect(css).toMatch(/\[data-dense='true'\] \.tile\[data-tier='page'\] \.tile__hero \{[^}]*flex-direction: row/)
    expect(css).toMatch(/\[data-dense='true'\] \.tile\[data-size='cell'\] \{[^}]*min-height: 0/)
    expect(css).toMatch(/\[data-dense='true'\] \.wall__group \{[^}]*min-height: 0/)
    const wall = readFileSync('src/web/components/Wall.tsx', 'utf8')
    expect(wall).toMatch(/metrics && !\(stack && t\.tier === 'page'\) \? titleStyleOf/)
    expect(wall).toMatch(/dense = stack && !!metrics && metrics\.stackPageMaxH < metrics\.stackPageRoomyH/)
  })

  it('at 600, 700 and 835 px tall, with the bar and the Fleet strip above (129 px) and two unattended pages in two groups, the first row of healthy cells fits', () => {
    const above = 129 // the status bar 31 + the strip 72 + the panel's padding and gaps, measured in the panel
    const gap = 8
    // the page the wall makes in the panel, measured: 156 at 600 px tall (the rule class line is shed), 178 at 700, 220 at 835 (the roomy form)
    const measured: Record<number, number> = { 600: 156, 700: 178, 835: 220 }
    for (const viewport of [600, 700, 835]) {
      const dense = cap(viewport) < roomy
      const page = measured[viewport]
      expect(page).toBeLessThanOrEqual(Math.max(cap(viewport), roomy + 12))
      const head = dense ? 25 : 40 // a dense heading is its own line (20 + the padding 4 + the hairline 1); the grid's --wall-group-head-h otherwise
      const cell = 69 // a cell with its name and its strip
      const bottom = above + 2 * (head + gap + page + gap) + cell
      expect(bottom, `${viewport}: ${bottom}`).toBeLessThanOrEqual(viewport)
      expect(page / viewport).toBeLessThanOrEqual(0.36)
    }
  })
})

// ---- the markup ---------------------------------------------------------------------------------------------------------------

describe('the markup: a real h2 per group with its counts, tiles under it in h3, and an incident tile that names its group', () => {
  it('the heading says the group and its incident counts: how many fire, and of those how many are acknowledged or silenced', () => {
    expect(groupCountText({ firing: 1, acknowledged: 0, silenced: 0 })).toBe('1 firing')
    expect(groupCountText({ firing: 3, acknowledged: 1, silenced: 0 })).toBe('3 firing, 1 acknowledged')
    expect(groupCountText({ firing: 4, acknowledged: 1, silenced: 2 })).toBe('4 firing, 1 acknowledged, 2 silenced')
    const html = renderToStaticMarkup(createElement(GroupHead, { group: { id: 'infrastructure', label: 'Infrastructure', order: 2 }, counts: { firing: 2, acknowledged: 1, silenced: 0 }, style: undefined }))
    expect(html).toMatch(/<h2 class="wall__group-title">/)
    expect(html).toContain('Infrastructure</span> <span class="wall__group-count">2 firing, 1 acknowledged</span>')
  })

  const incident = (id: string, tier: Tile['tier'], group: string, attention: 'none' | 'acked' | 'silenced' = 'none'): Tile =>
    ({ id, tier, R: 5, kind: 'incident', attended: attention === 'acked', incident: { state: { attention } } as unknown as Tile['incident'], wallGroup: { id, label: group, order: 0 } }) as Tile
  const cell = (id: string, R: number, look = false): Tile => ({ id, tier: 'quiet', R, kind: 'service', look })
  const grp = (id: string, label: string, order: number) => ({ id, label, order })
  const defs = [grp('product', 'Product', 0), grp('reliability', 'Reliability signals', 1), grp('infrastructure', 'Infrastructure', 2), grp('external', 'External and vendors', 3)]
  const withGroup = (t: Tile, g: string): Tile => ({ ...t, wallGroup: defs.find((d) => d.id === g) })

  it('reads the wall in order: each section (its heading, then its incidents), then a screen-reader heading for the healthy cells, then the cells needing a look first, then by weight and name', () => {
    const order: Tile[] = [
      withGroup(incident('i:a', 'page', 'x'), 'infrastructure'),
      withGroup(incident('i:b', 'page', 'x'), 'reliability'),
      withGroup(incident('i:c', 'warning', 'x'), 'infrastructure'),
      withGroup(incident('i:d', 'quiet', 'x', 'silenced'), 'external'),
      cell('s:z', 3),
      cell('s:a', 1),
      cell('s:m', 1, true),
      cell('s:b', 3)
    ]
    const entries = wallEntries(order, ['reliability', 'infrastructure', 'external'], defs)
    const read = entries.map((e) => (e.kind === 'head' ? `# ${e.group.label}: ${e.counts.firing}/${e.counts.acknowledged}/${e.counts.silenced}` : e.kind === 'cells' ? `## cells ${e.count}` : e.tile.id))
    expect(read).toEqual(['# Reliability signals: 1/0/0', 'i:b', '# Infrastructure: 2/0/0', 'i:a', 'i:c', '# External and vendors: 1/0/1', 'i:d', '## cells 4', 's:m', 's:b', 's:z', 's:a'])
  })

  it('draws no section for a group with no incident, and no cells heading when nothing is healthy', () => {
    expect(wallEntries([withGroup(incident('i:a', 'page', 'x'), 'product')], ['product', 'reliability'], defs).map((e) => e.kind)).toEqual(['head', 'tile'])
    expect(wallEntries([cell('s:a', 1)], [], defs).map((e) => e.kind)).toEqual(['cells', 'tile'])
  })

  it('a healthy cell titles itself in the level it is given: h3 under a heading, h2 by default, and keeps its dots and summary', () => {
    const tile = { id: 's:Backups', tier: 'quiet' as const, R: 1, kind: 'service' as const }
    const health = { service: 'Backups', cells: [{ id: 'c1', source: 'grafana', name: 'r', service: 'Backups', state: 'ok' as const }], firing: 0 }
    const html = (level?: 'h2' | 'h3'): string => renderToStaticMarkup(createElement(ServiceTile, { tile, health, style: undefined, active: false, onFocus: () => undefined, kinds: { grafana: 'grafana' }, level }))
    expect(html('h3')).toMatch(/<h3 class="tile__title">/)
    expect(html()).toMatch(/<h2 class="tile__title">/)
    expect(html('h3').replace(NBSP, ' ')).toContain('1 ok')
  })

  it('an incident tile names its group first in its breadcrumb, and in its accessible name, whether or not the Group toggle is on', () => {
    const e = new Engine(openDb(':memory:'), cfg)
    const now = new Date().toISOString()
    const alert = makeAlert(
      { origin: 'grafana', fingerprint: 'a1b2c3d4e5f60718', rule: 'HostDiskHigh', labels: { alertname: 'HostDiskHigh', severity: 'warning', component: 'host-disk', host: 'node-4' }, annotations: { summary: 'Host disk node-4 above 85 percent' }, startsAt: now, via: { source: 'grafana', kind: 'grafana', lastSeen: now }, raw: {} },
      cfg.serviceMap,
      now
    )
    e.ingest({ source: 'grafana', kind: 'grafana', at: now, firing: [alert], resolved: [], complete: true })
    const state = e.wall()
    const i = state.incidents[0]
    expect(i.service).toBe('Host disks')
    const lookup = groupLookup(state.wallGroups)
    const tile = { id: `i:${i.key}`, tier: i.state.tier, R: i.state.R, kind: 'incident' as const, incident: i, wallGroup: lookup(i.service) }
    const props = { i, size: 'compact' as const, style: undefined, nowMs: Date.now(), kinds: { grafana: 'grafana' as const }, titleStyle: 'title' as const, active: false, onFocus: () => undefined, onAck: () => undefined }
    const html = renderToStaticMarkup(createElement(IncidentTile, { ...props, tile, level: 'h3' }))
    expect(html).toMatch(/<span class="tile__crumb tile__crumb--group"[^>]*>Infrastructure<\/span>/)
    expect(html).toMatch(/aria-label="[^"]*In Infrastructure\./)
    expect(html).toMatch(/<h3 class="tile__title">/)
    // a wall with no groups (By host) says nothing of one
    const plain = renderToStaticMarkup(createElement(IncidentTile, { ...props, tile: { ...tile, wallGroup: undefined } }))
    expect(plain).not.toContain('tile__crumb--group')
    expect(plain).toMatch(/<h2 class="tile__title">/)
  })
})
