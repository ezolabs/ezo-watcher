import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { holdPageHeight } from '../src/web/lib/hold-page.ts'
import type { HeldRoot } from '../src/web/lib/hold-page.ts'

// The wall reads its room with its own growth taken off, and the page is held at its height for that read (src/web/lib/hold-page.ts). A page that is as
// short as the room for that moment has its scroll position clamped by the browser and never given back: a re-measure threw a reader who had scrolled
// down a wall taller than the room back up the page. Found in a fixture with the page's own stylesheet (scrollY 600 -> 40 without the hold, 600 with it).

function page(scrollHeight: number, minHeight = ''): HeldRoot & { seen: string[] } {
  const seen: string[] = []
  const style = {
    own: minHeight,
    get minHeight(): string {
      return this.own
    },
    set minHeight(value: string) {
      seen.push(value)
      this.own = value
    }
  }
  return { scrollHeight, style, seen }
}

describe('holdPageHeight', () => {
  it('holds the page at its scroll height for the read and gives its own min-height back', () => {
    const root = page(1716, '12px')
    let during = ''
    const out = holdPageHeight(root, () => {
      during = root.style.minHeight
      return 42
    })
    expect(during).toBe('1716px')
    expect(out).toBe(42)
    expect(root.style.minHeight).toBe('12px')
    expect(root.seen).toEqual(['1716px', '12px'])
  })

  it('gives it back when the read throws', () => {
    const root = page(900)
    expect(() =>
      holdPageHeight(root, () => {
        throw new Error('read failed')
      })
    ).toThrow('read failed')
    expect(root.style.minHeight).toBe('')
  })
})

// The class: every place in src/web that collapses a box (a height, min-height or max-height cleared, auto, 0 or 0px) and reads its size a few lines later
// does it inside holdPageHeight. A scan of every source file of the page, so the next measure of this kind is caught by the file it is written in.
const COLLAPSE = /\.style\.(height|minHeight|maxHeight)\s*=\s*(''|'auto'|'0'|'0px')/
const READ = /\.(clientHeight|clientWidth|offsetHeight|offsetWidth|scrollHeight|scrollWidth|getBoundingClientRect)\b/

/** The lines of a source that collapse a box and read its size within the next six lines, with no holdPageHeight in the six lines up to it. */
function unheld(source: string): number[] {
  const lines = source.split('\n')
  const found: number[] = []
  lines.forEach((line, i) => {
    if (!COLLAPSE.test(line)) return
    if (!READ.test(lines.slice(i + 1, i + 7).join('\n'))) return
    if (!/holdPageHeight\(/.test(lines.slice(Math.max(0, i - 6), i + 1).join('\n'))) found.push(i + 1)
  })
  return found
}

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) sources(path, out)
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path)
  }
  return out
}

describe('measuring by collapsing a box', () => {
  it('the scan sees the measure as it was (the control) and does not see a held one', () => {
    const before = [
      'const measure = (): void => {',
      '  const grown = el.style.minHeight',
      "  el.style.minHeight = ''",
      '  const next = { w: el.clientWidth, h: el.clientHeight }',
      '  el.style.minHeight = grown',
      '}'
    ].join('\n')
    const held = [
      'const measure = (): void => {',
      '  const grown = el.style.minHeight',
      '  const next = holdPageHeight(document.documentElement, () => {',
      "    el.style.minHeight = ''",
      '    return { w: el.clientWidth, h: el.clientHeight }',
      '  })',
      '}'
    ].join('\n')
    const reset = ["el.style.minHeight = ''", 'setOpen(false)'].join('\n')
    expect(unheld(before)).toEqual([3])
    expect(unheld(held)).toEqual([])
    expect(unheld(reset)).toEqual([])
  })

  it('every collapse and read in src/web is held', () => {
    const root = fileURLToPath(new URL('../src/web', import.meta.url))
    const files = sources(root)
    expect(files.length).toBeGreaterThan(20)
    const loose = files.flatMap((file) => unheld(readFileSync(file, 'utf8')).map((line) => `${file.slice(root.length + 1)}:${line}`))
    expect(loose).toEqual([])
  })

  it('the wall measures its room inside the hold', () => {
    const wall = readFileSync(new URL('../src/web/components/Wall.tsx', import.meta.url), 'utf8')
    const hold = wall.indexOf('holdPageHeight(document.documentElement')
    const clear = wall.indexOf("el.style.minHeight = ''")
    expect(hold).toBeGreaterThan(-1)
    expect(clear).toBeGreaterThan(hold)
  })
})
