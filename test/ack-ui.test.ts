// How an acknowledgement reads on the wall and how a name is kept: the tile's line and big number, the status line's counts, the order of
// acknowledged tiles, the browser's name store and the prompt, and the guards on how the controls are built. Written, not run, in the
// session that added it (checks were off).
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { layoutWall } from '../src/shared/layout.ts'
import type { LayoutItem } from '../src/shared/layout.ts'
import type { Incident } from '../src/shared/types.ts'
import { FALLBACK_NAME } from '../src/shared/who.ts'
import { NameField, NamePrompt } from '../src/web/components/Who.tsx'
import { ackedLine, attendedRank, heroOf, statusCounts, unattendedSeconds } from '../src/web/lib/ack.ts'
import { actorBy, needsName, nameSkipped, NAME_KEY, SKIPPED_KEY, savedName, saveName, skipName } from '../src/web/lib/who.ts'

const NOW = Date.parse('2026-10-15T14:52:00Z')
const iso = (offsetMin = 0): string => new Date(NOW + offsetMin * 60_000).toISOString()
const clock = (s: string): string => new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
const plain = (s: string): string => s.replace(/\u00a0/g, ' ')

type Pick3 = Pick<Incident, 'state' | 'startsAt' | 'ackedAt'>
const incident = (attention: 'none' | 'acked' | 'silenced', over: Partial<Pick3> = {}): Pick3 => ({
  state: { tier: 'warning', R: 4, band: 3, attention, firing: true, instances: 1, park: null, unattendedSinceMs: NOW - 9 * 3600_000 },
  startsAt: iso(-9 * 60),
  ackedAt: attention === 'acked' ? iso(-25) : null,
  ...over
})

/** A Map behind the Storage methods the name store uses. */
function memory(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }
}

describe('the acknowledged tile says who and when', () => {
  it('writes one line with the name and the time of day', () => {
    expect(ackedLine('the user', iso())).toBe(`Acknowledged by the user at ${clock(iso())}`)
    expect(ackedLine('the user', null)).toBe('Acknowledged by the user')
  })

  it('never says wall: the old default and nobody read as no actor, only the time', () => {
    expect(ackedLine('wall', iso())).toBe(`Acknowledged at ${clock(iso())}`)
    expect(ackedLine(null, iso())).toBe(`Acknowledged at ${clock(iso())}`)
    expect(ackedLine('wall', null)).not.toMatch(/\bwall\b/)
  })
})

describe('the big number counts what it says', () => {
  it('unattended is how long nobody has had it', () => {
    expect(plain(heroOf(incident('none'), NOW).value)).toBe('9 h')
    expect(heroOf(incident('none'), NOW).label).toBe('unattended')
  })

  it('acknowledged is how long ago someone took it, not the time it took to be taken', () => {
    const h = heroOf(incident('acked'), NOW)
    expect(plain(h.value)).toBe('25 min')
    expect(h.label).toBe('since acknowledged')
    // the old reading counted the wait before the ack: 8 h 35 min here, and called it "until acknowledged"
    expect(plain(h.value)).not.toBe('9 h')
  })

  it('an acknowledged incident with no time falls back to the wait it had, and says so', () => {
    expect(heroOf(incident('acked', { ackedAt: null }), NOW).label).toBe('until acknowledged')
  })

  it('silenced keeps its word, and the age stops at the ack', () => {
    expect(heroOf(incident('silenced'), NOW).label).toBe('silenced')
    expect(unattendedSeconds(incident('acked'), NOW)).toBe((9 * 60 - 25) * 60)
    expect(unattendedSeconds(incident('none'), NOW)).toBe(9 * 3600)
  })
})

describe('the status line counts the acknowledged beside the firing', () => {
  it('says "6 firing, 1 acknowledged", and leaves the second out at zero or on a server that does not send it', () => {
    expect(statusCounts({ firing: 6, acknowledged: 1 })).toEqual({ firing: '6 firing', acknowledged: '1 acknowledged' })
    expect(statusCounts({ firing: 6, acknowledged: 0 }).acknowledged).toBeNull()
    expect(statusCounts({ firing: 6 }).acknowledged).toBeNull()
  })
})

describe('acknowledged tiles follow the unattended ones of their tier', () => {
  const box = { width: 1600, height: 900, gap: 8, firingMin: { w: 160, h: 120 }, quietMin: { w: 120, h: 96 } }
  const ids = (items: LayoutItem[]): string[] => layoutWall(items, box).map((p) => p.id)

  it('whatever their weight', () => {
    const items: LayoutItem[] = [
      { id: 'heavy-acked', tier: 'page', R: 24, attended: true },
      { id: 'light-unattended', tier: 'page', R: 4 },
      { id: 'mid-unattended', tier: 'page', R: 8 },
      { id: 'warn-acked', tier: 'warning', R: 10, attended: true },
      { id: 'warn-unattended', tier: 'warning', R: 2 }
    ]
    expect(ids(items)).toEqual(['mid-unattended', 'light-unattended', 'heavy-acked', 'warn-unattended', 'warn-acked'])
  })

  it('and tiers keep their own order: an acknowledged page still comes before an unattended warning', () => {
    const order = ids([
      { id: 'warn-unattended', tier: 'warning', R: 12 },
      { id: 'page-acked', tier: 'page', R: 2, attended: true }
    ])
    expect(order).toEqual(['page-acked', 'warn-unattended'])
  })

  it('a wall with nobody acknowledged is laid out as before: weight descending, then id', () => {
    expect(
      ids([
        { id: 'b', tier: 'warning', R: 4 },
        { id: 'a', tier: 'warning', R: 4 },
        { id: 'c', tier: 'warning', R: 8 }
      ])
    ).toEqual(['c', 'a', 'b'])
  })

  it('ranks attention for the phone stack', () => {
    expect(attendedRank('acked')).toBeGreaterThan(attendedRank('none'))
    expect(attendedRank('silenced')).toBe(attendedRank('none'))
  })
})

describe('the name this browser gives', () => {
  it('asks once: neither a name nor a skip means ask', () => {
    const s = memory()
    expect(needsName(s)).toBe(true)
    expect(savedName(s)).toBeNull()
    expect(actorBy(s)).toBe(FALLBACK_NAME)
  })

  it('keeps a cleaned name and sends it as the by', () => {
    const s = memory()
    expect(saveName('  the user   Chen ', s)).toBe('the user Chen')
    expect(s.m.get(NAME_KEY)).toBe('the user Chen')
    expect(needsName(s)).toBe(false)
    expect(actorBy(s)).toBe('the user Chen')
  })

  it('a skip is this browser and is not asked again', () => {
    const s = memory()
    skipName(s)
    expect(nameSkipped(s)).toBe(true)
    expect(needsName(s)).toBe(false)
    expect(actorBy(s)).toBe(FALLBACK_NAME)
  })

  it('an empty save forgets the name and counts as a skip; a later name clears the skip', () => {
    const s = memory({ [NAME_KEY]: 'the user' })
    expect(saveName('   ', s)).toBeNull()
    expect(s.m.has(NAME_KEY)).toBe(false)
    expect(s.m.get(SKIPPED_KEY)).toBe('1')
    expect(saveName('Dana', s)).toBe('Dana')
    expect(s.m.has(SKIPPED_KEY)).toBe(false)
  })

  it('a browser that refuses storage keeps nothing and asks every time, and never throws', () => {
    expect(needsName(null)).toBe(true)
    expect(saveName('the user', null)).toBe('the user')
    expect(actorBy(null)).toBe(FALLBACK_NAME)
  })

  it('cuts a stored name to the 64 the server keeps', () => {
    const s = memory({ [NAME_KEY]: 'z'.repeat(90) })
    expect([...(savedName(s) ?? '')]).toHaveLength(64)
  })
})

describe('the prompt and the field', () => {
  it('the prompt is a modal dialog that holds no form until an acknowledge asks for a name', () => {
    const html = renderToStaticMarkup(createElement(NamePrompt))
    expect(html).toContain('<dialog')
    expect(html).toContain('class="prompt"')
    expect(html).not.toContain('<form')
  })

  it('the field is labelled, and says who the browser acknowledges as when it has no name', () => {
    const html = renderToStaticMarkup(createElement(NameField))
    expect(html).toContain('>Your name<')
    expect(html).toContain('Acknowledging as this browser.')
    expect(html).toContain('maxLength="64"')
    expect(html).toContain('Save name')
    expect(html).not.toMatch(/[\u2014\u00b7\u2192]/)
  })
})

describe('how it is built', () => {
  const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

  it('a press names who and waits behind the settle seam: no handler posts an acknowledge itself', () => {
    const act = read('src/web/lib/act.ts')
    expect(act).toContain('afterSettle(')
    expect(act).toContain('by: actorBy()')
    expect(act).toContain('ensureName()')
    for (const f of ['src/web/components/Wall.tsx', 'src/web/components/Sheets.tsx']) {
      const src = read(f)
      expect(src).not.toMatch(/api\(`\/api\/incidents/)
      expect(src).not.toContain("'x-watch-user'")
    }
  })

  it('no surface writes the actor "wall"', () => {
    for (const f of ['src/web/lib/act.ts', 'src/web/lib/who.ts', 'src/web/components/Who.tsx', 'src/web/lib/ack.ts']) expect(read(f)).not.toMatch(/(by|actor)\w*\s*[:=]\s*['"`]wall['"`]/)
  })

  it('the acknowledged tile is an outline in the severity hue on the raised surface, with no dashed border and a two-line ack text (who, then when) never cut by an ellipsis', () => {
    const css = read('src/web/styles/wall.css')
    expect(css).toMatch(/\.tile\[data-attention='acked'\]\[data-tier='page'\] \{\s*border: var\(--edge-page\) solid var\(--color-danger\);/)
    expect(css).toMatch(/\.tile\[data-attention='acked'\]\[data-tier='warning'\] \{\s*border: var\(--edge-warning\) solid var\(--color-warn\);/)
    expect(css).toMatch(/\.tile\[data-attention='acked'\]\[data-tier='page'\],\s*\.tile\[data-attention='acked'\]\[data-tier='warning'\] \{\s*background: var\(--color-raised\);/)
    expect(css).not.toMatch(/data-attention='acked'\] \{\s*border-style: dashed/)
    // who on one line, when on the next: a column; the name may wrap (it can be 64 characters), the time stays one piece, and neither is ellipsised
    expect(css).toMatch(/\.tile__ack \{[^}]*flex-direction: column;/)
    expect(css).toMatch(/\.tile__ack-when \{\s*white-space: nowrap;/)
    expect(css).not.toMatch(/\.tile__ack[^{]*\{[^}]*text-overflow: ellipsis;/)
    const block = css.slice(css.indexOf("data-attention='acked'][data-tier='page'],"), css.indexOf('.tile__ack {') + 400)
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('the tile draws a check-circle for an acknowledged incident and the ack line, and counts its time from the acknowledgement', () => {
    const wall = read('src/web/components/Wall.tsx')
    expect(wall).toContain('<Glyph severity={acked ? null : i.severity} />')
    expect(wall).toContain('className="tile__ack"')
    expect(wall).toContain('heroOf(i, nowMs)')
    expect(wall).not.toContain("'until acknowledged'")
  })

  it('no copy of this feature holds an em dash', () => {
    for (const f of ['src/web/lib/ack.ts', 'src/web/lib/who.ts', 'src/web/lib/act.ts', 'src/web/components/Who.tsx', 'src/shared/who.ts']) expect(read(f)).not.toMatch(/\u2014/)
  })
})
