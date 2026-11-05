import { describe, expect, it } from 'vitest'
import { layoutWall } from '../src/shared/layout.ts'
import type { LayoutItem } from '../src/shared/layout.ts'
import type { Tier } from '../src/shared/types.ts'

// The wall of the drill's probe: 1440 x 900 (the app shell leaves about 1180 x 760 for the wall).
const opt = {
  width: 1180,
  height: 760,
  gap: 8,
  firingMin: { w: 160, h: 120 },
  quietMin: { w: 120, h: 96 }
}

// A tiny seeded generator so the fixtures are reproducible.
function rng(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

function fixture(seed: number): LayoutItem[] {
  const r = rng(seed)
  // Up to 14 firing incidents and up to 12 quiet service tiles: a busy day on a fleet this size.
  const firing = 2 + Math.floor(r() * 13)
  const quiet = Math.floor(r() * 13)
  const items: LayoutItem[] = []
  let hasPage = false
  for (let i = 0; i < firing + quiet; i++) {
    const t = r()
    const tier: Tier = i >= firing ? 'quiet' : t < 0.3 ? 'page' : 'warning'
    if (tier === 'page') hasPage = true
    items.push({ id: `t${i}`, tier, R: tier === 'quiet' ? 1 + Math.floor(r() * 4) : 2 + Math.floor(r() * 12) })
  }
  if (!hasPage) items[0] = { id: 't0', tier: 'page', R: 2 + Math.floor(r() * 8) }
  return items
}

const area = (b: { w: number; h: number }): number => b.w * b.h

describe('wall layout', () => {
  it('is deterministic: the same input is the same layout', () => {
    const items = fixture(7)
    expect(layoutWall(items, opt)).toEqual(layoutWall([...items].reverse(), opt))
  })

  it('keeps every tile inside the wall and no two tiles overlap', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const out = layoutWall(fixture(seed), opt)
      for (const a of out) {
        expect(a.x).toBeGreaterThanOrEqual(-0.001)
        expect(a.y).toBeGreaterThanOrEqual(-0.001)
        expect(a.x + a.w).toBeLessThanOrEqual(opt.width + 0.001)
        expect(a.y + a.h).toBeLessThanOrEqual(opt.height + 0.001)
      }
      for (let i = 0; i < out.length; i++) {
        for (let j = i + 1; j < out.length; j++) {
          const a = out[i]
          const b = out[j]
          const overlap = a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01
          expect(overlap).toBe(false)
        }
      }
    }
  })

  it('makes the biggest page tile at least 2x the biggest warning and 3x the biggest quiet tile across 1000 fixtures', () => {
    let checked = 0
    for (let seed = 100; seed < 1100; seed++) {
      const items = fixture(seed)
      const out = layoutWall(items, opt)
      const biggest = (tier: Tier): number => Math.max(0, ...out.filter((p) => p.tier === tier).map(area))
      const page = biggest('page')
      const warning = biggest('warning')
      const quiet = biggest('quiet')
      if (warning > 0) expect(page).toBeGreaterThanOrEqual(2 * warning)
      if (quiet > 0) expect(page).toBeGreaterThanOrEqual(3 * quiet)
      checked++
    }
    expect(checked).toBe(1000)
  })

  it('puts the lead page tile in the top-left half of the wall', () => {
    for (let seed = 200; seed < 400; seed++) {
      const items = fixture(seed)
      const out = layoutWall(items, opt)
      const lead = out.filter((p) => p.tier === 'page').sort((a, b) => area(b) - area(a))[0]
      const cx = lead.x + lead.w / 2
      const cy = lead.y + lead.h / 2
      expect(cx / opt.width + cy / opt.height).toBeLessThan(1)
    }
  })

  it('shows a quiet wall as a health grid: every tile at least the quiet minimum', () => {
    const items: LayoutItem[] = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, tier: 'quiet', R: 1 + (i % 3) }))
    const out = layoutWall(items, opt)
    expect(out).toHaveLength(12)
    for (const p of out) {
      expect(p.w).toBeGreaterThanOrEqual(opt.quietMin.w - opt.gap)
      expect(p.h).toBeGreaterThanOrEqual(opt.quietMin.h - opt.gap)
    }
  })

  it('keeps quiet tiles close to square, so a lone warning never squeezes them into strips', () => {
    const items: LayoutItem[] = [
      { id: 'p', tier: 'page', R: 8 },
      { id: 'w', tier: 'warning', R: 8 },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `q${i}`, tier: 'quiet' as Tier, R: 2 }))
    ]
    const out = layoutWall(items, opt)
    for (const p of out.filter((x) => x.tier === 'quiet')) expect(Math.max(p.w / p.h, p.h / p.w)).toBeLessThan(3)
  })

  it('keeps the tiers in separate regions, page first', () => {
    for (let seed = 500; seed < 560; seed++) {
      const out = layoutWall(fixture(seed), opt)
      const box = (tier: Tier) => {
        const ps = out.filter((p) => p.tier === tier)
        if (ps.length === 0) return null
        return { x0: Math.min(...ps.map((p) => p.x)), y0: Math.min(...ps.map((p) => p.y)), x1: Math.max(...ps.map((p) => p.x + p.w)), y1: Math.max(...ps.map((p) => p.y + p.h)) }
      }
      const page = box('page')
      expect(page).not.toBeNull()
      // the page region starts at the wall's top-left corner
      expect((page as { x0: number }).x0).toBeLessThan(opt.gap)
      expect((page as { y0: number }).y0).toBeLessThan(opt.gap)
    }
  })
})

describe('minimum tile size', () => {
  it('lifts the lightest tiles to the minimum so no quiet tile is a sliver', () => {
    const items: LayoutItem[] = [
      { id: 'a', tier: 'quiet', R: 5 },
      { id: 'b', tier: 'quiet', R: 5 },
      { id: 'c', tier: 'quiet', R: 5 },
      ...Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, tier: 'quiet' as Tier, R: 1 }))
    ]
    const out = layoutWall(items, opt)
    for (const p of out) {
      expect(p.w).toBeGreaterThanOrEqual(opt.quietMin.w - 1)
      expect(p.h).toBeGreaterThanOrEqual(opt.quietMin.h - 1)
    }
  })

  it('keeps every quiet tile at the minimum on both sides across 300 walls with up to ten quiet services', () => {
    for (let seed = 900; seed < 1200; seed++) {
      const r = rng(seed)
      const items: LayoutItem[] = [{ id: 'p', tier: 'page', R: 6 }, { id: 'w', tier: 'warning', R: 4 }]
      const n = 4 + Math.floor(r() * 7)
      for (let i = 0; i < n; i++) items.push({ id: `q${i}`, tier: 'quiet', R: 1 + Math.floor(r() * 12) })
      for (const p of layoutWall(items, opt).filter((x) => x.tier === 'quiet')) {
        expect(p.w).toBeGreaterThanOrEqual(opt.quietMin.w - 1)
        expect(p.h).toBeGreaterThanOrEqual(opt.quietMin.h - 1)
      }
    }
  })
})

describe('an incident tile that holds a title', () => {
  // The node-2 prober, one page per target and one target acked: the acked warning is the lightest tile on the wall.
  const probes: LayoutItem[] = [
    { id: 'chat', tier: 'page', R: 8 },
    { id: 'mas', tier: 'page', R: 6 },
    { id: 'watch', tier: 'warning', R: 2 }
  ]
  const INCIDENT_MIN_W = 180
  const widthOf = (items: LayoutItem[], id: string, o = opt): number => (layoutWall(items, o).find((p) => p.id === id) as { w: number }).w

  it('is narrower than a title needs when the layout only knows the quiet minimum (the strip that clipped "ProbeDown on ...")', () => {
    expect(widthOf(probes, 'watch')).toBeLessThan(INCIDENT_MIN_W)
  })

  it('is at least its own minimum wide, whatever the wall holds, and the page tiles stay at the page minimum', () => {
    const items = probes.map((p) => (p.id === 'watch' ? { ...p, minW: INCIDENT_MIN_W } : p))
    for (const [width, height] of [[1180, 760], [1000, 700], [820, 600]]) {
      const out = layoutWall(items, { ...opt, width, height })
      expect(out.find((p) => p.id === 'watch')?.w).toBeGreaterThanOrEqual(INCIDENT_MIN_W - 1)
      for (const p of out.filter((x) => x.tier === 'page')) {
        expect(p.w).toBeGreaterThanOrEqual(opt.firingMin.w - 1)
        expect(p.h).toBeGreaterThanOrEqual(opt.firingMin.h - 1)
      }
    }
  })

  it('changes nothing for a wall whose tiles carry no minimum', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const items = fixture(seed)
      expect(layoutWall(items.map((i) => ({ ...i, minW: undefined })), opt)).toEqual(layoutWall(items, opt))
    }
  })

  it('widens only the tier that holds the tile: the quiet tiles keep the quiet minimum, not the incident one', () => {
    const items: LayoutItem[] = [...probes.map((p) => (p.id === 'watch' ? { ...p, minW: INCIDENT_MIN_W } : p)), ...Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, tier: 'quiet' as Tier, R: 2 }))]
    const quiet = layoutWall(items, opt).filter((x) => x.tier === 'quiet')
    expect(quiet).toHaveLength(6)
    for (const p of quiet) {
      expect(p.w).toBeGreaterThanOrEqual(opt.quietMin.w - 1)
      expect(p.w).toBeLessThan(INCIDENT_MIN_W)
    }
  })
})

describe('an incident tile that holds its rows', () => {
  const INCIDENT_MIN_H = 120
  const warnings: LayoutItem[] = [
    { id: 'page', tier: 'page', R: 12 },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `w${i}`, tier: 'warning' as Tier, R: 4 + (i % 3) }))
  ]
  const short = { ...opt, height: 560 }

  it('is shorter than its rows need when the layout only knows the quiet minimum (the clipped caption of the Story tile)', () => {
    expect(Math.min(...layoutWall(warnings, short).filter((p) => p.tier === 'warning').map((p) => p.h))).toBeLessThan(INCIDENT_MIN_H)
  })

  it('is at least its own minimum tall, whatever the wall holds', () => {
    const items = warnings.map((w) => (w.tier === 'warning' ? { ...w, minW: 180, minH: INCIDENT_MIN_H } : w))
    for (const [width, height] of [[1180, 560], [1180, 760], [1000, 700]]) {
      const out = layoutWall(items, { ...opt, width, height })
      for (const p of out.filter((x) => x.tier === 'warning')) expect(p.h).toBeGreaterThanOrEqual(INCIDENT_MIN_H - 1)
    }
  })

  it('changes nothing for a wall whose tiles carry no minimum height', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const items = fixture(seed)
      expect(layoutWall(items.map((i) => ({ ...i, minH: undefined })), opt)).toEqual(layoutWall(items, opt))
    }
  })
})
