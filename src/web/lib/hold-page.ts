// A measurement that collapses part of the page, with the page held at the height it has meanwhile.
//
// The wall reads its room with its own growth taken off (Wall.tsx measure): its min-height is cleared, the room is read, and the min-height is put back.
// A wall taller than the room is what makes the page scroll, so for that read the page is as short as the room and the browser clamps the reader's scroll
// position to the shorter range when the collapsed page is laid out for the read. The page is the full height again a moment later and nothing puts the
// reader back: every re-measure (a poll that changed a tile, a resize) threw a reader who had scrolled down the wall back up the page.
//
// Held, the collapse changes the size of nothing outside the wall's own box, so there is no range to clamp to.

/** The page's own box as far as holding its height goes: the document element in the browser, a stand-in in a test. */
export interface HeldRoot {
  readonly scrollHeight: number
  readonly style: { minHeight: string }
}

/** Run `read` with `root` held at its scroll height as a min-height, and give it its own min-height back whatever `read` does. */
export function holdPageHeight<T>(root: HeldRoot, read: () => T): T {
  const before = root.style.minHeight
  root.style.minHeight = `${root.scrollHeight}px`
  try {
    return read()
  } finally {
    root.style.minHeight = before
  }
}
