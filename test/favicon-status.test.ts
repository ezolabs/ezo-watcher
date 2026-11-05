// The tab icon as a status light (src/web/lib/favicon.ts): which wall state colours the pupil (only what pages no one has taken), that a poll
// which changes nothing writes nothing, and that the icon index.html ships is the same template with the grey pupil.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Attention, Incident, Severity, WallState } from '../src/shared/types.ts'
import { PUPIL, faviconHref, faviconStatus, faviconSvg, showFavicon } from '../src/web/lib/favicon.ts'

/** A wall with just what the icon reads: each incident's severity and attention. */
const wall = (...incidents: Array<[Severity, Attention]>): WallState =>
  ({ incidents: incidents.map(([severity, attention]) => ({ severity, state: { attention } }) as unknown as Incident) }) as unknown as WallState

/** A stand-in page: one icon link as index.html ships it, counting every write to its href. */
function page() {
  const attrs = new Map<string, string>([['href', '/favicon.svg']])
  const writes: string[] = []
  const link = {
    dataset: {} as DOMStringMap,
    getAttribute: (name: string) => attrs.get(name) ?? null,
    setAttribute: (name: string, value: string) => {
      writes.push(value)
      attrs.set(name, value)
    }
  }
  const doc = { querySelector: (sel: string) => (sel === 'link[rel="icon"]' ? link : null) } as unknown as Document
  return { doc, writes, href: () => attrs.get('href') }
}

const svgOf = (href: string): string => decodeURIComponent(href.replace(/^data:image\/svg\+xml,/, ''))

describe('the status the wall gives the tab icon', () => {
  it('is red for an unattended page, amber for an unattended warning, grey otherwise', () => {
    expect(faviconStatus(null)).toBe('neutral')
    expect(faviconStatus(wall())).toBe('neutral')
    expect(faviconStatus(wall(['page', 'none']))).toBe('page')
    expect(faviconStatus(wall(['warning', 'none']))).toBe('warning')
    expect(faviconStatus(wall(['warning', 'none'], ['page', 'none']))).toBe('page')
    expect(faviconStatus(wall(['info', 'none']))).toBe('neutral')
  })

  it('leaves the pupil grey for pages someone has: acked, silenced and parked colour nothing', () => {
    expect(faviconStatus(wall(['page', 'acked']))).toBe('neutral')
    expect(faviconStatus(wall(['page', 'silenced'], ['page', 'parked']))).toBe('neutral')
    expect(faviconStatus(wall(['page', 'acked'], ['warning', 'none']))).toBe('warning')
    expect(faviconStatus(wall(['warning', 'acked'], ['warning', 'parked']))).toBe('neutral')
  })

  it("takes the pupil's colours from the dark theme's tokens", () => {
    const tokens = readFileSync('src/web/styles/tokens.css', 'utf8')
    const dark = tokens.slice(0, tokens.indexOf("[data-scheme='light']"))
    expect(dark).toContain(`--color-danger: ${PUPIL.page};`)
    expect(dark).toContain(`--color-warn: ${PUPIL.warning};`)
    expect(dark).toContain(`--color-fg: ${PUPIL.neutral};`)
  })
})

describe('the icon link', () => {
  it('is written only when the colour changes', () => {
    const p = page()
    // the shipped link already shows the grey pupil
    expect(showFavicon(p.doc, 'neutral')).toBe(false)
    expect(p.writes).toEqual([])
    expect(showFavicon(p.doc, 'page')).toBe(true)
    expect(svgOf(p.href()!)).toContain(`r="8" fill="${PUPIL.page}"`)
    // the next poll with the same page firing
    expect(showFavicon(p.doc, 'page')).toBe(false)
    expect(p.writes).toHaveLength(1)
    expect(showFavicon(p.doc, 'warning')).toBe(true)
    expect(svgOf(p.href()!)).toContain(`r="8" fill="${PUPIL.warning}"`)
    expect(showFavicon(p.doc, 'neutral')).toBe(true)
    expect(p.href()).toBe(faviconHref('neutral'))
    expect(showFavicon(p.doc, 'neutral')).toBe(false)
    expect(p.writes).toHaveLength(3)
  })

  it('does nothing on a page with no icon link', () => {
    expect(showFavicon({ querySelector: () => null } as unknown as Document, 'page')).toBe(false)
  })

  it('is one template for every status: only the pupil differs', () => {
    const neutral = svgOf(faviconHref('neutral'))
    for (const s of ['page', 'warning'] as const) {
      const svg = svgOf(faviconHref(s))
      expect(svg).toBe(faviconSvg(PUPIL[s]))
      expect(svg.replace(`fill="${PUPIL[s]}"/></svg>`, `fill="${PUPIL.neutral}"/></svg>`)).toBe(neutral)
    }
    // the URL is percent-encoded whole: no raw quote, hash or angle bracket can end it early
    expect(faviconHref('page')).not.toMatch(/[#"<>]/)
  })

  it('ships the grey template as public/favicon.svg, the icon index.html links', () => {
    expect(readFileSync('public/favicon.svg', 'utf8')).toBe(`${faviconSvg(PUPIL.neutral)}\n`)
    expect(readFileSync('index.html', 'utf8')).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />')
  })
})
