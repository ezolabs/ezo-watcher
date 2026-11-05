// How a wall tile's title wraps: only between words. A tile is a fixed box, so a title that does not fit is cut after a
// whole word (the rest is in the tile's aria-label and in the sheet), never through one.

const BREAK_AFTER = /(?<=[./_:-])|(?<=[a-z0-9])(?=[A-Z])/

/**
 * The pieces of one space-free word between which a line may break: after a dot, dash, underscore, slash or colon (a hostname,
 * a path, a service such as prod/scraper) and between the words of a CamelCase name (IntakeContainerLogFailure). A word with
 * none of these stays whole.
 */
export function breakSegments(word: string): string[] {
  return word.split(BREAK_AFTER).filter(Boolean)
}

/**
 * The text a box can hold: the whole title when it fits, else its leading pieces and an ellipsis, as many as still fit. A piece is
 * a word, or the part of a hostname or CamelCase name up to one of its joints (see breakSegments), so the cut is always at a
 * boundary and never through a letter, and the dot or dash it was cut at is dropped so the ellipsis does not read as four dots.
 * Past the first word the cut is always at a whole word, so a headline never ends in half an identifier ("Module._resolve…"); the joints
 * are for a first word that is too long by itself. The first piece is kept even when it alone does not fit (nothing narrower is honest).
 */
export function fitWords(text: string, fits: (candidate: string) => boolean): string {
  if (fits(text)) return text
  // a sentence ends after a whole word: the joints of a later word (a path, a CamelCase name) are only for a first word that is itself too long
  const words = text.split(/\s+/).filter(Boolean)
  for (let k = words.length - 1; k >= 1; k--) {
    const candidate = ellipsized(words.slice(0, k).join(' '))
    if (fits(candidate)) return candidate
  }
  const pieces = text.split(/\s+/).filter(Boolean).flatMap((word, k) => breakSegments(word).map((seg, j) => (j === 0 && k > 0 ? ` ${seg}` : seg)))
  for (let k = pieces.length - 1; k > 1; k--) {
    const candidate = ellipsized(pieces.slice(0, k).join(''))
    if (fits(candidate)) return candidate
  }
  return pieces.length > 1 ? ellipsized(pieces[0]) : text
}

const ellipsized = (head: string): string => `${head.replace(/[./_:-]+$/, '')}…`
