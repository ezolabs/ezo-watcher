import { describe, expect, it } from 'vitest'
import { linesHeld, titleHolds, titleShown, warningTitleLines, wrapLines } from '../src/shared/title-room.ts'

// A fixed-width stub for the browser's text metrics: every character is 8 px, a space included.
const measure = (text: string): number => text.length * 8
const m = { chromeW: 32, chromeH: 80 }

describe('wrapLines', () => {
  it('is one line for a title that fits and counts the lines of a greedy wrap between words', () => {
    expect(wrapLines('Replica pg-node-13 is 74 s behind', 400, measure)).toBe(1)
    // 38 characters in a line of 160 px (20 characters): "Disk on node-13 is 64% full," / "filling 5 GB/h" is 2 lines
    expect(wrapLines('Disk on node-13 is 64% full, filling 5 GB/h', 160, measure)).toBe(3)
    expect(wrapLines('Disk on node-13 is 64% full, filling 5 GB/h', 112, measure)).toBe(4)
  })

  it('gives a word wider than the line the lines it needs by itself, and never fewer than one', () => {
    expect(wrapLines('x'.repeat(50), 160, measure)).toBe(3)
    expect(wrapLines('', 160, measure)).toBe(1)
    expect(wrapLines('a b', 0, measure)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('titleHolds', () => {
  const style = { measure, lineH: 20 }
  it('is true when the whole title wraps to the lines allowed and the lines fit the tile', () => {
    expect(titleHolds('Disk on node-13 is 64% full, filling 5 GB/h', { w: 200, h: 140 }, style, m, 4)).toBe(true)
  })
  it('is false when a line too many, or a tile too short, would cut it', () => {
    expect(titleHolds('Disk on node-13 is 64% full, filling 5 GB/h', { w: 112 + m.chromeW, h: 400 }, style, m, 2)).toBe(false)
    expect(titleHolds('Disk on node-13 is 64% full, filling 5 GB/h', { w: 200, h: m.chromeH + 20 }, style, m, 4)).toBe(false)
  })
  it('never fails a stacked tile on height', () => {
    expect(titleHolds('Disk on node-13 is 64% full, filling 5 GB/h', { w: 200, h: Number.POSITIVE_INFINITY }, style, m, 4)).toBe(true)
  })
})

describe('titleShown', () => {
  const long = 'word '.repeat(80).trim()
  it('cuts a title no tile holds after the last line allowed, and says it is not whole', () => {
    expect(titleShown(long, 282, 28, measure, 3)).toEqual({ lines: 3, whole: false })
  })
  it('shows a short title whole, in the lines it wraps to', () => {
    expect(titleShown('Disk on node-13 is 64% full, filling 5 GB/h', 160 + 28, 28, measure, 3)).toEqual({ lines: 3, whole: true })
  })
})

describe('warningTitleLines', () => {
  const rule = { lines: 3, attendedLines: 2 }
  it('is three lines for a warning, two once it also says who has it, and never fewer than two', () => {
    expect(warningTitleLines(false, rule)).toBe(3)
    expect(warningTitleLines(true, rule)).toBe(2)
  })
})

describe('linesHeld', () => {
  it('counts the whole lines of title a tile holds under its other rows', () => {
    expect(linesHeld(156, 94, 20)).toBe(3)
    expect(linesHeld(150, 94, 20)).toBe(2)
    expect(linesHeld(60, 94, 20)).toBe(0)
  })
})
