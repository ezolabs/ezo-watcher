// Plain-language time: no middle dots, no em dashes, durations as "3 h" not "3h 2m 11s".

/** A non-breaking space: the joint between a number and its unit, so a line never ends on "7" and starts on "min". */
export const NBSP = '\u00a0'

/** A number and its unit as one unbreakable piece: `unitText(7, 'min')` is "7", a non-breaking space and "min". */
export function unitText(n: number | string, unit: string): string {
  return `${n}${NBSP}${unit}`
}

/**
 * Prose a person wrote (a catalog sentence) with an ordinary space between a number and its unit: "the 48 h shadow soak" becomes one that
 * cannot break between the 48 and the h. Only a number followed by a unit word is touched, so a sentence reads the same.
 */
export function keepUnits(text: string): string {
  return text.replace(/(\d) (ms|s|min|h|d|KB|MB|GB|TB|%)(?![A-Za-z0-9])/g, `$1${NBSP}$2`)
}

export function durationText(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  if (s < 90) return unitText(s, 's')
  const m = Math.round(s / 60)
  if (m < 90) return unitText(m, 'min')
  const h = Math.round(s / 3600)
  if (h < 36) return unitText(h, 'h')
  return unitText(Math.round(s / 86400), 'd')
}

/**
 * A wait read to the minute where it matters: "90 s", "35 min", "1 h 35 min". `durationText` rounds 95 min to "2 h", which is too coarse for
 * "the sweep runs next in ...". From a day and a half it falls back to `durationText`.
 */
export function exactDurationText(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  if (s < 120) return unitText(s, 's')
  const m = Math.round(s / 60)
  if (m < 60) return unitText(m, 'min')
  if (m >= 36 * 60) return durationText(s)
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest === 0 ? unitText(h, 'h') : `${unitText(h, 'h')} ${unitText(rest, 'min')}`
}

/** "7 min ago" for a duration in seconds, the number, unit and "ago" held together. */
export function agoDurationText(sec: number): string {
  return `${durationText(sec)}${NBSP}ago`
}

export function agoText(iso: string | null, nowMs: number): string {
  if (!iso) return 'never'
  return agoDurationText((nowMs - Date.parse(iso)) / 1000)
}

export function clockText(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function stampText(iso: string): string {
  const d = new Date(iso)
  const day = d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return `${day} ${clockText(iso)}`
}

/** "Oct 17, 09:00": the day and the time of day, the form a park's end and start are told in ("Parked until Oct 17, 09:00"). */
export function parkStampText(iso: string): string {
  const day = new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
  return `${day}, ${clockText(iso)}`
}

export function sinceText(iso: string, nowMs: number): string {
  return `since ${clockText(iso)}, ${durationText((nowMs - Date.parse(iso)) / 1000)}`
}
