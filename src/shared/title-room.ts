// How much of an incident's title a tile shows. Pure: the caller gives `measure` (the browser's canvas text metrics, or a fixed-width stub in a
// test) and the sizes it read from tokens.css, so no design number lives here.
//
// A tile no longer grows to hold its title (the tier rule, layout.ts, gives a tile the footprint of its severity). A page shows its title whole in up
// to `--wall-title-lines` lines and sets it as large as it holds; a warning shows two or three lines and ends the rest with an ellipsis, its full text on
// hover and in the sheet. docs/design.md, "The wall".

/** The width in px of one line of text, in the font a title is set in. */
export type Measure = (text: string) => number

/**
 * How many lines a title wraps to in a line `lineW` wide: a greedy wrap between words, as a browser does it. A word wider than the line takes
 * the lines it needs by itself (the tile's own fit breaks a long name at its joints). Never fewer than one.
 */
export function wrapLines(text: string, lineW: number, measure: Measure): number {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return 1
  if (lineW <= 0) return Number.POSITIVE_INFINITY
  const space = measure(' ')
  let lines = 1
  let used = 0
  for (const word of words) {
    const w = measure(word)
    if (used > 0 && used + space + w <= lineW) {
      used += space + w
      continue
    }
    if (used > 0) lines += 1
    const spans = Math.max(1, Math.ceil(w / lineW))
    lines += spans - 1
    used = w - (spans - 1) * lineW
  }
  return lines
}

/** Does `text`, set in a style whose line is `lineH` tall, fit a tile `box` wide and tall in `maxLines` lines? A box of unlimited height (a stacked tile) is `Infinity` tall. */
export function titleHolds(text: string, box: { w: number; h: number }, style: { measure: Measure; lineH: number }, m: { chromeW: number; chromeH: number }, maxLines: number): boolean {
  const lines = wrapLines(text, box.w - m.chromeW, style.measure)
  return lines <= maxLines && m.chromeH + lines * style.lineH <= box.h
}

/** How many title lines a warning tile shows at most: three, or two once it also says who has it (the two lines under its title). */
export function warningTitleLines(attended: boolean, rule: { lines: number; attendedLines: number }): number {
  return attended ? rule.attendedLines : rule.lines
}

export interface TitleShown {
  /** Lines of the title that are drawn. */
  lines: number
  /** False when the title is longer than the lines allowed: it ends in an ellipsis and its full text is on hover and in the sheet. */
  whole: boolean
}

/** What a tile `w` wide shows of `text`: the lines it wraps to, up to `maxLines` (a long title is cut after the last). */
export function titleShown(text: string, w: number, chromeW: number, measure: Measure, maxLines: number): TitleShown {
  const lines = wrapLines(text, w - chromeW, measure)
  return { lines: Math.min(lines, maxLines), whole: lines <= maxLines }
}

/** How many whole lines of title a tile `h` tall holds under the `chromeH` its other rows take. */
export function linesHeld(h: number, chromeH: number, lineH: number): number {
  return Math.max(0, Math.floor((h - chromeH) / lineH))
}
