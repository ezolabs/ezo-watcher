// The width of a tile title in each of the three sizes it is set in, measured with the browser's own canvas text metrics from the type
// tokens (tokens.css owns the sizes, weights and tracking). The wall sizes a firing tile to hold its title with these (shared/title-room.ts),
// and picks the largest title size that still holds the title in its tile. The tile's own fit (FitTitle) still decides what is cut, so a
// measure that is a few pixels off costs a line at worst, never a clipped letter.

import type { Measure } from '../../shared/title-room.ts'

/** The three sizes a tile title is set in: the plain one, the headline of a large tile, the display of the lead tile. */
export type TitleStyle = 'title' | 'headline' | 'display'

export interface Meters {
  measure: Record<TitleStyle, Measure>
  /** One line of each size, in px. */
  lineH: Record<TitleStyle, number>
}

let canvas: CanvasRenderingContext2D | null = null

function context(): CanvasRenderingContext2D | null {
  if (canvas) return canvas
  canvas = document.createElement('canvas').getContext('2d')
  return canvas
}

/** The measures, read from the type tokens on the document root. Call again after a resize or a scheme change: the values are read each time. */
export function readMeters(): Meters {
  const root = getComputedStyle(document.documentElement)
  const token = (name: string): string => root.getPropertyValue(name).trim()
  const family = token('--font-ui')
  const one = (style: TitleStyle): { measure: Measure; lineH: number } => {
    const size = token(`--text-${style}`)
    const weight = token(`--text-${style}--font-weight`)
    const tracking = token(`--text-${style}--letter-spacing`)
    const lineH = Number.parseFloat(token(`--text-${style}--line-height`))
    const ctx = context()
    const measure: Measure = (text) => {
      if (!ctx) return text.length * Number.parseFloat(size)
      ctx.font = `${weight} ${size} ${family}`
      if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = tracking
      return ctx.measureText(text).width
    }
    return { measure, lineH }
  }
  const title = one('title')
  const headline = one('headline')
  const display = one('display')
  return {
    measure: { title: title.measure, headline: headline.measure, display: display.measure },
    lineH: { title: title.lineH, headline: headline.lineH, display: display.lineH }
  }
}
