// Who acknowledged. Watch has no login, so a person gives a name once (the first time they acknowledge) and the browser sends it with
// each acknowledge, silence and unacknowledge. The server stores it with the ack and every surface reads it back: the tile, the sheet, History
// and the Chat record line. A person who skips is "this browser" in the store, never the word "wall": the wall is a screen, not someone. But
// "this browser" is only true for the person who skipped it, and means nothing to anyone else or in a chat message, so every surface reads a
// stored name that names nobody as no actor at all: "Acknowledged at 14:45", "Silenced until 16:47" (`shownName` is null, `byPhrase` is empty).

/** The longest name kept (the `by` of the ack API is at most this many characters). A name is a label on a tile, not a sentence. */
export const NAME_MAX = 64

/** What an acknowledgement reads when nobody gave a name. */
export const FALLBACK_NAME = 'this browser'

/** What an acknowledgement reads when a notification action did it. */
export const NOTIFICATION_NAME = 'a notification action'

/** Control characters out, runs of space folded to one, cut to NAME_MAX on a whole character. '' for anything that is not text. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const folded = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u00a0\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return [...folded].slice(0, NAME_MAX).join('').trim()
}

/**
 * The actor of a request, from its x-watch-user header. The browser sends the name percent-encoded (a header carries no more than Latin-1),
 * so it is decoded here; a missing, empty or undecodable header is the fallback, and so is the old default "wall".
 */
export function actorName(header: string | null | undefined): string {
  let text = header ?? ''
  try {
    text = decodeURIComponent(text)
  } catch {
    // an undecodable header is read as written: it is cleaned either way
  }
  const name = cleanName(text)
  return name === '' || name.toLowerCase() === 'wall' ? FALLBACK_NAME : name
}

/** The stored actors that name nobody: no name, the old default "wall", what a skipped prompt stores, and the engine's own stand-in for an event with no `by`. */
const NOBODY = new Set(['', 'wall', FALLBACK_NAME, 'someone'])

/**
 * The name a stored actor shows on a tile, a sheet, a history row and a record line, or null when it names nobody. A real name and an
 * agent's "agent: claude" are shown as stored. This holds for every viewer, the person who skipped the prompt included: their own fresh
 * acknowledgement reads without a name too, because nothing a page can say about "you" survives to the next person who reads it.
 */
export function shownName(by: string | null | undefined): string | null {
  if (by === null || by === undefined) return null
  const name = by.trim()
  return NOBODY.has(name.toLowerCase()) ? null : by
}

/** " by the user" for a stored actor that names someone, and nothing otherwise: "Acknowledged" + the phrase reads right either way. */
export function byPhrase(by: string | null | undefined): string {
  const name = shownName(by)
  return name === null ? '' : ` by ${name}`
}
