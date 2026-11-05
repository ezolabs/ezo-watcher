// The Status Eye as shipped: every icon the manifest, the page and the service worker name is in public/ at the size it claims, the maskable
// and Apple icons are full-bleed (the OS cuts their shape), and the README logo, the app tile and the sidebar Mark are one drawing.
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** A PNG's size and whether it can hold transparency, from its IHDR (and a tRNS chunk for the palette and RGB types). */
function png(path: string): { width: number; height: number; alpha: boolean } {
  const b = readFileSync(path)
  expect(b.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  const type = b[25]
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), alpha: type === 4 || type === 6 || b.includes(Buffer.from('tRNS')) }
}

const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8')) as {
  background_color: string
  theme_color: string
  icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>
}
const html = readFileSync('index.html', 'utf8')

describe('the app icons', () => {
  it('are in public/ at the sizes the manifest claims, one of them maskable and opaque', () => {
    expect(manifest.icons.map((i) => i.src)).toEqual(['/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png'])
    for (const icon of manifest.icons) {
      const [w, h] = icon.sizes.split('x').map(Number)
      expect(icon.type).toBe('image/png')
      expect(png(`public${icon.src}`)).toMatchObject({ width: w, height: h })
    }
    const maskable = manifest.icons.filter((i) => i.purpose === 'maskable')
    expect(maskable).toHaveLength(1)
    expect(png(`public${maskable[0].src}`).alpha).toBe(false)
    expect([manifest.background_color, manifest.theme_color]).toEqual(['#0d0d0d', '#0d0d0d'])
  })

  it('give iOS a full-bleed 180 px icon, linked from the page', () => {
    expect(html).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />')
    expect(png('public/icons/apple-touch-icon.png')).toEqual({ width: 180, height: 180, alpha: false })
  })

  it('include the one the service worker shows on a notification', () => {
    const sw = readFileSync('src/web/sw.ts', 'utf8')
    const named = [...sw.matchAll(/'(\/icons\/[^']+)'/g)].map((m) => m[1])
    expect(named.length).toBeGreaterThan(0)
    for (const path of named) expect(existsSync(`public${path}`), path).toBe(true)
  })
})

describe('the mark', () => {
  const pathOf = (svg: string): string => /<path[^>]* d="([^"]+)"/.exec(svg)![1]
  const logo = readFileSync('docs/assets/logo.svg', 'utf8')
  const tile = readFileSync('docs/assets/logo-tile.svg', 'utf8')

  it('is one drawing in the README logo, the app tile and the sidebar', () => {
    const app = readFileSync('src/web/App.tsx', 'utf8')
    const bars = [.../const MARK_BARS =\n([\s\S]*?)\n\n/.exec(app)![1].matchAll(/'([^']*)'/g)].map((m) => m[1]).join('')
    expect(pathOf(tile)).toBe(pathOf(logo))
    expect(bars).toBe(pathOf(logo))
    expect(logo).toContain('<circle cx="32" cy="32" r="4.5"/>')
    expect(app).toContain('<circle cx="32" cy="32" r="4.5" />')
  })

  it("reads on GitHub's light and dark pages: ink by default, the dark scheme's text colour under prefers-color-scheme", () => {
    expect(logo).toContain('path,circle{fill:#141310}@media (prefers-color-scheme:dark){path,circle{fill:#e6e8ee}}')
    expect(logo).not.toContain('<rect')
  })

  it('sits on the app tile: #0d0d0d, a #3a3b40 hairline, corners at radius 16 of 64', () => {
    expect(tile).toContain('viewBox="0 0 64 64"')
    expect(tile).toMatch(/<rect x="0.25" y="0.25" width="63.5" height="63.5" rx="15.75" fill="#0d0d0d" stroke="#3a3b40" stroke-width="0.5"\/>/)
  })
})
