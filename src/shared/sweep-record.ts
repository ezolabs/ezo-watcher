// The regression sweep's captured output opens, for a Sentry issue, with one record printed on one line:
//
//   source | id | ISO time | title | detail
//   sentry_mobile | 7739867797 | 2026-10-15T21:17:47.484000Z | cocoa:MXDiskWriteException: | APP-MOBILE-J warning ongoing status=unresolved count=2 users=1
//
// The title is the error; the detail is an issue short id, a level and a status and `key=value` pairs, and it is absent from a record
// the sweep printed bare. One pure reader here serves the sheet's hero (src/web/lib/hero.ts, which takes the facts out of the detail) and
// the wall tile's line (src/shared/story.ts, which shows the title), so neither ever draws the pipes, the id or the stamp.

export interface SweepRecord {
  source: string
  id: string
  /** The ISO time the record starts its third column with. */
  at: string
  /** The error, without the colon the sweep leaves after it. */
  title: string
  /** Everything after the title, empty for a bare record. */
  detail: string
}

/** The record a line is, or null when it is anything else (the third column must be an ISO date, which no prose line has there). */
export function parseSweepRecord(line: string): SweepRecord | null {
  const parts = line.split(' | ').map((p) => p.trim())
  if (parts.length < 4 || !/^\d{4}-\d{2}-\d{2}T/.test(parts[2])) return null
  const title = parts[3].replace(/:\s*$/, '').trim()
  if (title === '') return null
  return { source: parts[0], id: parts[1], at: parts[2], title, detail: parts.slice(4).join(' | ') }
}
