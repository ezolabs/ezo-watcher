// The Fleet strip and the Fleet view in the chat panel (views/Embed.tsx, docs/embed.md): the strip is on the embed above the wall, it is the one door to
// the Fleet view, the view is a layer over a wall that stays mounted and inert, Back and Escape lead out of it, `/embed#/fleet` opens on it, the hottest host
// comes first, and the full app's strip and page are what they were. The markup is drawn with the server renderer, so a press is proved by the link it follows
// and the pure step it takes (route, place, Escape), and the rest by the guards on how the pieces are built.

import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FleetMount, FleetNode, FleetView } from '../src/shared/types.ts'
import { FleetStripView, hottestFirst, attentionOf } from '../src/web/components/FleetStrip.tsx'
import { embedPlace, EmbedContext, escapeStep, fleetOpen, parentOrigins } from '../src/web/lib/embed.ts'
import { href, parse } from '../src/web/lib/route.ts'
import Embed, { FleetLayer } from '../src/web/views/Embed.tsx'

const src = (p: string): string => readFileSync(new URL(`../src/web/${p}`, import.meta.url), 'utf8')
const NOW = Date.parse('2026-10-16T01:30:00Z')
const SERIES = Array.from({ length: 60 }, (_, i) => 5 + (i % 7))

const mount = (path: string, usedPct: number): FleetMount => ({
  path,
  fs: 'ext4',
  usedPct,
  usedBytes: null,
  freeBytes: 100 * 1024 ** 3,
  sizeBytes: 915 * 1024 ** 3,
  series: SERIES,
  heat: usedPct >= 90 ? 'hot' : usedPct >= 80 ? 'warm' : 'ok'
})

function node(name: string, over: Partial<FleetNode> & { disk?: number } = {}): FleetNode {
  const { disk = 30, ...rest } = over
  const m = mount('/', disk)
  return {
    name,
    role: 'fleet',
    group: 'servers',
    state: 'reachable',
    live: true,
    updatedAt: '2026-10-16T01:29:30Z',
    stale: false,
    heat: 'cold',
    cores: 32,
    ramBytes: null,
    version: 'v2.12.1',
    cpu: 3,
    cpu10: 3,
    mem: 10,
    load1: 0.4,
    load5: 0.4,
    load15: 0.4,
    loadPerCore: 0.01,
    disk,
    mounts: [m],
    diskHeat: m.heat,
    series: { from: 0, stepSec: 60, cpu: SERIES, mem: SERIES, loadPerCore: SERIES, disk: SERIES },
    rules: [],
    ...rest
  }
}

function view(nodes: FleetNode[]): FleetView {
  return {
    generatedAt: '2026-10-16T01:29:50Z',
    dataAt: '2026-10-16T01:29:30Z',
    ageSec: 20,
    pollSec: 60,
    stale: false,
    error: null,
    windowMin: 60,
    stepSec: 60,
    thresholds: {
      cpu: { warnAbove: 80, clearBelow: 70, forMin: 10 },
      memory: { warnAbove: 85, clearBelow: 80, pageAbove: 95, pageClearBelow: 90, forMin: 10 },
      load: { warnAbove: 1.5, clearBelow: 1.2, forMin: 15 },
      coldCpuBelow: 10,
      disk: { warmAt: 80, hotAt: 90 }
    },
    summary: { nodes: nodes.length, servers: nodes.length, watchOnly: 0, live: nodes.length, hot: 0, warm: 0, cold: nodes.length, hottest: null, fleetCpuAvg: 4 },
    nodes
  }
}

// five hosts in the API's order: quiet, a warm disk, a warm CPU, a hot disk, a hot CPU
const FLEET = [node('node-1'), node('node-2', { disk: 83.4 }), node('node-6', { heat: 'warm', cpu: 74 }), node('node-13', { disk: 91.3 }), node('node-5', { heat: 'hot', cpu: 91 })]

const draw = (el: ReactElement, embedded: boolean): string => renderToStaticMarkup(createElement(EmbedContext.Provider, { value: embedded }, el))
const strip = (embedded: boolean, nodes = FLEET): string =>
  draw(createElement(FleetStripView, { state: { status: 'ready', view: view(nodes) }, offline: false, reload: () => undefined, nowMs: NOW }), embedded)
const names = (html: string): string[] => [...html.matchAll(/class="fstrip__name"[^>]*>([^<]+)</g)].map((m) => m[1] ?? '')

// the sparkline reads its width from a token through a probe element, which the server renderer has no document for
beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: () => ({ style: {}, getBoundingClientRect: () => ({ width: 40 }), remove: () => undefined }),
    body: { appendChild: () => undefined }
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('the parent origin the frame answers', () => {
  const globals = globalThis as unknown as { location?: unknown; document?: unknown }
  const saved = { location: globals.location, document: globals.document }
  afterEach(() => {
    globals.location = saved.location
    globals.document = saved.document
  })

  it('is the browser own ancestorOrigin, else the referrer page, else nobody (never a guessed constant)', () => {
    globals.location = { ancestorOrigins: ['https://panel.example.com', 'https://other.example.com'] }
    expect(parentOrigins()).toEqual(['https://panel.example.com'])
    // Firefox has no ancestorOrigins: the framing page is the referrer, and its origin is exactly who to answer.
    globals.location = { ancestorOrigins: [] }
    globals.document = { referrer: 'https://chat.example.com/room/7?x=1' }
    expect(parentOrigins()).toEqual(['https://chat.example.com'])
    // A stripped referrer and no ancestor name nobody: nothing is posted to a guess.
    globals.document = { referrer: '' }
    expect(parentOrigins()).toEqual([])
  })
})

describe('the Fleet strip is on the embed, above the wall', () => {
  it('draws the strip between the status bar and the wall, and the layer only when the view is open', () => {
    vi.stubGlobal('location', { hash: '#/', search: '?theme=dark', pathname: '/embed' })
    const html = renderToStaticMarkup(createElement(Embed))
    const bar = html.indexOf('embed__bar')
    const band = html.indexOf('class="fstrip"')
    const wall = html.indexOf('skel-wall')
    expect(bar).toBeGreaterThan(-1)
    expect(band).toBeGreaterThan(bar)
    expect(wall).toBeGreaterThan(band)
    expect(html).not.toContain('embed__fleet')
    expect(html).not.toMatch(/embed__wall"[^>]*inert/)
  })

  it('has one row, the lead on the left and one cell per host, with the Fleet label carrying a chevron', () => {
    const html = strip(true)
    expect(html.match(/class="fstrip__link"/g)).toHaveLength(1)
    expect(html.match(/fstrip__lead/g)).toHaveLength(1)
    expect(html.match(/<span class="fstrip__cell"/g)).toHaveLength(FLEET.length)
    expect(html).toContain('fstrip__go')
    expect(html).toContain('Fleet')
  })

  it('is one link to the Fleet view, named in words for a screen reader', () => {
    const html = strip(true)
    expect(html).toContain('href="#/fleet"')
    expect(html).toMatch(/aria-label="Fleet, [^"]*Open the Fleet page\."/)
  })

  it('shows the loudest host first: a hot CPU, a hot disk, a warm CPU, a warm disk, then the rest in the API order', () => {
    expect(names(strip(true))).toEqual(['node-5', 'node-13', 'node-6', 'node-2', 'node-1'])
    expect(hottestFirst(FLEET).map((n) => n.name)).toEqual(['node-5', 'node-13', 'node-6', 'node-2', 'node-1'])
    expect(attentionOf(FLEET[4]!)).toBeGreaterThan(attentionOf(FLEET[3]!))
    expect(attentionOf(FLEET[3]!)).toBeGreaterThan(attentionOf(FLEET[2]!))
    expect(attentionOf(FLEET[2]!)).toBeGreaterThan(attentionOf(FLEET[1]!))
    expect(attentionOf(FLEET[1]!)).toBeGreaterThan(attentionOf(FLEET[0]!))
    // quiet hosts keep the API's order, and the sort leaves its input alone
    const quiet = [node('node-1'), node('node-2'), node('node-3')]
    expect(hottestFirst(quiet).map((n) => n.name)).toEqual(['node-1', 'node-2', 'node-3'])
    expect(FLEET.map((n) => n.name)).toEqual(['node-1', 'node-2', 'node-6', 'node-13', 'node-5'])
  })

  it('draws the three lines of one cell: the name, the CPU now with its sparkline, and the fullest disk', () => {
    const html = strip(true, [node('node-5', { heat: 'hot', cpu: 91, disk: 53.4 })])
    expect(html).toContain('>node-5<')
    expect(html).toContain('>91%<')
    expect(html).toContain('>53.4%<')
    expect(html).toContain('class="spark"')
  })

  it('keeps one height for loading and for its one sentence, and its chevron, in the frame', () => {
    const loading = draw(createElement(FleetStripView, { state: { status: 'loading' }, offline: false, reload: () => undefined, nowMs: NOW }), true)
    expect(loading).toContain('data-state="loading"')
    expect(loading).toContain('fstrip__go')
    const none = draw(createElement(FleetStripView, { state: { status: 'none' }, offline: false, reload: () => undefined, nowMs: NOW }), true)
    // an unframed embed page (no window here) offers the full app's Sources in a new tab; the strip's "Open sources" is a hash link the embed has no page for
    expect(none).toContain('Fleet metrics are not set up on this host.')
    expect(none).not.toContain('href="#/sources"')
    expect(none).toContain('Open full Watch')
  })
})

describe('the full app keeps its own strip', () => {
  it('draws the API order, no chevron and the same link, outside the frame', () => {
    const html = strip(false)
    expect(names(html)).toEqual(['node-1', 'node-2', 'node-6', 'node-13', 'node-5'])
    expect(html).not.toContain('fstrip__go')
    expect(html).toContain('href="#/fleet"')
    const none = draw(createElement(FleetStripView, { state: { status: 'none' }, offline: false, reload: () => undefined, nowMs: NOW }), false)
    expect(none).toContain('href="#/sources"')
    expect(none).toContain('Open sources')
  })

  it('keeps the wall page a strip over the wall and leaves the Fleet page its own h1 and its fleet incident link', () => {
    const app = src('App.tsx')
    expect(app).toContain('<FleetStrip nowMs={nowMs} />')
    const page = src('views/Fleet.tsx')
    expect(page).toContain("href({ view: embedded ? 'wall' : 'fleet', incident: key })")
    expect(page).toContain("const Title = embedded ? 'h2' : 'h1'")
  })
})

describe('the Fleet view opens, goes back and is deep-linkable', () => {
  it('opens on #/fleet, in the frame as in the app, and is the wall on #/ and on nothing', () => {
    expect(parse('#/fleet').view).toBe('fleet')
    expect(fleetOpen(parse('#/fleet'))).toBe(true)
    expect(fleetOpen(parse('#/'))).toBe(false)
    expect(fleetOpen(parse(''))).toBe(false)
    expect(fleetOpen(parse('#/i/Gateway%7CGatewayEnvoyFailures'))).toBe(false)
    expect(href({ view: 'fleet' })).toBe('#/fleet')
  })

  it('draws the layer with Back to wall as a link to the wall and the page titled for the region', () => {
    const html = draw(createElement(FleetLayer, { state: null, nowMs: NOW }), true)
    expect(html).toContain('class="embed__fleet"')
    expect(html).toContain('aria-labelledby="fleet-title"')
    expect(html).toMatch(/<a class="btn" href="#\/"[^>]*data-back="fleet">.*Back to wall<\/a>/)
    expect(html).toMatch(/<h2 class="page-title" id="fleet-title">Fleet<\/h2>/)
    expect(html).not.toContain('<h1')
    expect(parse(html.match(/href="(#\/)" [^>]*data-back/)?.[1] ?? '#/').view).toBe('wall')
  })

  it('opens the frame on the view from the embed URL, with the wall mounted under it and inert', () => {
    vi.stubGlobal('location', { hash: '#/fleet', search: '?theme=dark', pathname: '/embed' })
    const html = renderToStaticMarkup(createElement(Embed))
    expect(html).toContain('class="embed__fleet"')
    expect(html).toMatch(/class="embed__wall" inert=""/)
    // the wall's own pieces are still in the markup, so Back is the same place: nothing unmounts
    expect(html).toContain('class="fstrip"')
    expect(html).toContain('skel-wall')
    // one h1 for the frame, the view's title is an h2
    expect(html.match(/<h1/g)).toHaveLength(1)
  })

  it('tells the panel where the frame is: #/fleet for the view, and a sheet over it in the form the panel already knows', () => {
    expect(embedPlace(parse('#/fleet'), '#/fleet')).toBe('#/fleet')
    expect(embedPlace(parse('#/'), '#/')).toBe('#/')
    expect(embedPlace(parse(''), '')).toBe('')
    const raw = '#/i/Gateway%7CGatewayEnvoyFailures'
    expect(embedPlace(parse(raw), raw)).toBe(raw)
    expect(embedPlace(parse('#/fleet/i/Gateway%7CGatewayEnvoyFailures'), '#/fleet/i/Gateway%7CGatewayEnvoyFailures')).toBe('#/i/Gateway%7CGatewayEnvoyFailures')
  })

  it('Escape: a sheet takes it, the view steps back to the wall, and only the wall hands it to the panel', () => {
    expect(escapeStep(parse('#/fleet'), true)).toBe('sheet')
    expect(escapeStep(parse('#/fleet'), false)).toBe('fleet')
    expect(escapeStep(parse('#/'), false)).toBe('parent')
    expect(escapeStep(parse('#/'), true)).toBe('sheet')
    const embed = src('views/Embed.tsx')
    // the key only changes the hash; the wall behind it is already drawn, so nothing is saved or restored
    expect(embed).toContain("if (step === 'fleet') location.hash = href({ view: 'wall' })")
    expect(embed).not.toMatch(/scrollTo|scrollY|scrollTop/)
  })

  it('moves focus on the change of view only: into the layer when it opens, home to the strip when it closes', () => {
    const embed = src('views/Embed.tsx')
    expect(embed).toContain('if (open === was.current) return')
    expect(embed).toContain("open ? '.embed__fleet [data-back]' : '.embed .fstrip__link'")
  })
})

describe('the frame draws it with tokens only', () => {
  const css = src('styles/embed.css')
  const fleet = src('styles/fleet.css')
  const tokens = src('styles/tokens.css')

  it('declares no number outside a var() in the rules added for the frame', () => {
    const added = css.slice(css.indexOf('/* The Fleet strip above the wall.'))
    const bare = added
      .split('\n')
      .filter((l) => !l.trim().startsWith('/*') && !l.trim().startsWith('*') && !l.trim().startsWith('@container'))
      // a zero, one fraction of a track and a track count are structure, not a size
      .filter((l) => /\d/.test(l.replace(/var\([^)]*\)/g, '').replace(/\[data-[^\]]*\]/g, '').replace(/repeat\(\d+|\b1fr|\* -1|1 \/ -1|\b0\b/g, '')))
    expect(bare).toEqual([])
  })

  it('has one narrow breakpoint, repeated as the literal its token says, and a token for the layer and the wider lead', () => {
    expect(tokens).toContain('--bp-fleet-narrow: 27rem;')
    expect(css).toContain('@container fleet (max-width: 27rem)')
    expect(tokens).toContain('--bp-fleet-tight: 20rem;')
    expect(css).toContain('@container fleet (max-width: 20rem)')
    expect(tokens).toContain('--layer-view: 2;')
    expect(tokens).toContain('--fleet-strip-lead-w-embed:')
    expect(css).toContain('z-index: var(--layer-view);')
  })

  it('adds no radius but the two, no shadow, no gradient and no animation', () => {
    const added = css.slice(css.indexOf('/* The Fleet strip above the wall.'))
    expect(added).not.toMatch(/border-radius/)
    expect(added).not.toMatch(/box-shadow|gradient|animation|@keyframes|transition/)
    expect(fleet).toContain('.fleet__tag {\n  display: none;\n}')
  })

  it('holds the frame still while the view is open, and never lets the band wrap or shrink', () => {
    expect(css).toContain(':root:has(.embed__fleet) {\n  overflow: hidden;\n}')
    expect(css).toMatch(/\.embed \.fstrip \{\n  flex: none;\n\}/)
    expect(fleet).toMatch(/\.fstrip \{[^}]*overflow-x: auto;/)
    expect(fleet).toMatch(/\.fstrip__link \{[^}]*grid-auto-flow: column;/)
  })
})
