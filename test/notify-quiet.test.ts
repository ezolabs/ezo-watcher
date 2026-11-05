import { describe, expect, it } from 'vitest'
import type { QuietHoursConfig } from '../src/server/config.ts'
import { quietState } from '../src/server/notify/quiet.ts'

const utc = (y: number, mo: number, d: number, h: number, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s)
const night: QuietHoursConfig = { tz: 'America/Chicago', start: '22:00', end: '07:00' }

describe('quietState', () => {
  it('is never quiet without a config', () => {
    expect(quietState(null, utc(2026, 1, 15, 4))).toEqual({ quiet: false, endsAtMs: null })
  })

  it('wraps past midnight and ends at the local end time', () => {
    // January: Chicago is CST, UTC-6.
    const ends = utc(2026, 1, 15, 13)
    expect(quietState(night, utc(2026, 1, 15, 3, 59, 59)).quiet).toBe(false) // 21:59:59 local
    expect(quietState(night, utc(2026, 1, 15, 4))).toEqual({ quiet: true, endsAtMs: ends }) // 22:00 local
    expect(quietState(night, utc(2026, 1, 15, 5, 30))).toEqual({ quiet: true, endsAtMs: ends }) // 23:30 local
    expect(quietState(night, utc(2026, 1, 15, 8))).toEqual({ quiet: true, endsAtMs: ends }) // 02:00 local
    expect(quietState(night, utc(2026, 1, 15, 12, 59, 59))).toEqual({ quiet: true, endsAtMs: ends })
    expect(quietState(night, utc(2026, 1, 15, 13))).toEqual({ quiet: false, endsAtMs: null }) // 07:00 local
  })

  it('treats days as the weekday the interval starts on', () => {
    const fridays: QuietHoursConfig = { ...night, days: [5] }
    // Friday 2026-01-16 22:00 local starts it; it runs into Saturday morning.
    expect(quietState(fridays, utc(2026, 1, 17, 5)).quiet).toBe(true) // Fri 23:00 local
    expect(quietState(fridays, utc(2026, 1, 17, 9))).toEqual({ quiet: true, endsAtMs: utc(2026, 1, 17, 13) }) // Sat 03:00
    expect(quietState(fridays, utc(2026, 1, 18, 5)).quiet).toBe(false) // Sat 23:00: Saturday does not start one
    expect(quietState(fridays, utc(2026, 1, 16, 9)).quiet).toBe(false) // Fri 03:00: Thursday did not start one
    expect(quietState(fridays, utc(2026, 1, 18, 9)).quiet).toBe(false) // Sun 03:00
  })

  it('reads empty days as every day', () => {
    expect(quietState({ ...night, days: [] }, utc(2026, 1, 15, 8)).quiet).toBe(true)
  })

  it('ends an hour earlier in UTC when the night loses an hour (spring forward, 2026-03-08)', () => {
    // 02:00 CST jumps to 03:00 CDT. The interval started Saturday 22:00 CST and ends 07:00 CDT = 12:00Z.
    const ends = utc(2026, 3, 8, 12)
    expect(quietState(night, utc(2026, 3, 8, 7, 30))).toEqual({ quiet: true, endsAtMs: ends }) // 01:30 CST
    expect(quietState(night, utc(2026, 3, 8, 8, 30))).toEqual({ quiet: true, endsAtMs: ends }) // 03:30 CDT
    expect(quietState(night, utc(2026, 3, 8, 11, 59))).toEqual({ quiet: true, endsAtMs: ends }) // 06:59 CDT
    expect(quietState(night, utc(2026, 3, 8, 12)).quiet).toBe(false) // 07:00 CDT
    expect(quietState(night, utc(2026, 3, 9, 2, 59)).quiet).toBe(false) // Sunday 21:59 CDT
    expect(quietState(night, utc(2026, 3, 9, 3))).toEqual({ quiet: true, endsAtMs: utc(2026, 3, 9, 12) }) // 22:00 CDT
  })

  it('ends an hour later in UTC when the night gains an hour (fall back, 2026-11-01)', () => {
    // 02:00 CDT falls back to 01:00 CST. Interval started Saturday 22:00 CDT, ends 07:00 CST = 13:00Z.
    const ends = utc(2026, 11, 1, 13)
    expect(quietState(night, utc(2026, 11, 1, 3))).toEqual({ quiet: true, endsAtMs: ends }) // 22:00 CDT
    expect(quietState(night, utc(2026, 11, 1, 6, 30))).toEqual({ quiet: true, endsAtMs: ends }) // 01:30 CDT
    expect(quietState(night, utc(2026, 11, 1, 7, 30))).toEqual({ quiet: true, endsAtMs: ends }) // 01:30 CST, second pass
    expect(quietState(night, utc(2026, 11, 1, 12, 59))).toEqual({ quiet: true, endsAtMs: ends }) // 06:59 CST
    expect(quietState(night, utc(2026, 11, 1, 13)).quiet).toBe(false) // 07:00 CST
  })

  it('handles an interval inside one day and a half-hour zone', () => {
    const lunch: QuietHoursConfig = { tz: 'America/Chicago', start: '12:00', end: '13:00', days: [1] }
    expect(quietState(lunch, utc(2026, 1, 12, 18, 30))).toEqual({ quiet: true, endsAtMs: utc(2026, 1, 12, 19) })
    expect(quietState(lunch, utc(2026, 1, 12, 19)).quiet).toBe(false)
    expect(quietState(lunch, utc(2026, 1, 13, 18, 30)).quiet).toBe(false) // Tuesday
    const india: QuietHoursConfig = { tz: 'Asia/Kolkata', start: '22:00', end: '07:00' }
    expect(quietState(india, utc(2026, 1, 15, 16, 30))).toEqual({ quiet: true, endsAtMs: utc(2026, 1, 16, 1, 30) })
    expect(quietState(india, utc(2026, 1, 15, 16, 29)).quiet).toBe(false)
  })

  it('accepts 24:00 as the end of the day', () => {
    const evening: QuietHoursConfig = { tz: 'UTC', start: '18:00', end: '24:00' }
    expect(quietState(evening, utc(2026, 1, 15, 23, 59))).toEqual({ quiet: true, endsAtMs: utc(2026, 1, 16, 0) })
    expect(quietState(evening, utc(2026, 1, 16, 0)).quiet).toBe(false)
  })

  it('treats start equal to end as empty and rejects bad input', () => {
    expect(quietState({ tz: 'UTC', start: '22:00', end: '22:00' }, utc(2026, 1, 15, 22)).quiet).toBe(false)
    expect(() => quietState({ tz: 'UTC', start: '25:00', end: '07:00' }, 0)).toThrow('bad time')
    expect(() => quietState({ tz: 'UTC', start: '22:00', end: '7am' }, 0)).toThrow('bad time')
    expect(() => quietState({ tz: 'Mars/Olympus', start: '22:00', end: '07:00' }, 0)).toThrow(RangeError)
  })
})
