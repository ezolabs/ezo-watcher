import { describe, expect, it } from 'vitest'
import { ageBand, incidentState, reach, severityOf, tierOf } from '../src/shared/incident.ts'

const NOW = Date.parse('2026-10-14T12:00:00Z')
const base = { severity: 'page' as const, instances: 1, nowMs: NOW }

describe('severity contract', () => {
  it('reads absent and critical as a page, warn as a warning, info as info, junk as a warning', () => {
    expect(severityOf(undefined)).toBe('page')
    expect(severityOf('')).toBe('page')
    expect(severityOf('Critical')).toBe('page')
    expect(severityOf('warn')).toBe('warning')
    expect(severityOf('ticket')).toBe('warning')
    expect(severityOf('info')).toBe('info')
    expect(severityOf('weird')).toBe('warning')
  })
})

describe('reach and age bands', () => {
  it('scales reach on a log2 step so layout moves only on a real step', () => {
    expect([0, 1, 2, 3, 6, 7, 15].map(reach)).toEqual([1, 2, 2, 3, 3, 4, 5])
  })
  it('puts the band edges at 10 minutes, 1 hour and 24 hours', () => {
    expect([0, 599, 600, 3599, 3600, 86399, 86400].map(ageBand)).toEqual([0, 0, 1, 1, 2, 2, 3])
  })
})

describe('incidentState', () => {
  it('grows an unattended incident as it ages and counts instances on the log step', () => {
    const young = incidentState({ ...base, startsAtMs: NOW - 60_000 })
    const old = incidentState({ ...base, startsAtMs: NOW - 2 * 3600_000 })
    const many = incidentState({ ...base, instances: 7, startsAtMs: NOW - 60_000 })
    expect(young.R).toBe(4)
    expect(old.band).toBe(2)
    expect(old.R).toBeGreaterThan(young.R)
    expect(many.R).toBeGreaterThan(young.R)
    expect(young.tier).toBe('page')
  })
  it('freezes age at the ack and halves the weight, so an ack is visible as a smaller tile', () => {
    const startsAtMs = NOW - 5 * 3600_000
    const open = incidentState({ ...base, startsAtMs })
    const acked = incidentState({ ...base, startsAtMs, ackedAtMs: NOW - 4.9 * 3600_000 })
    expect(acked.attention).toBe('acked')
    expect(acked.band).toBe(0)
    expect(acked.R).toBeLessThan(open.R)
    expect(acked.tier).toBe('page')
  })
  it('drops a silenced incident to the quiet floor with no hue tier', () => {
    const s = incidentState({ ...base, startsAtMs: NOW - 3600_000, silencedUntilMs: NOW + 1000 })
    expect(s.attention).toBe('silenced')
    expect(s.tier).toBe('quiet')
    expect(s.R).toBe(1)
  })
  it('never lets a pile of warnings out-weigh the page tier (tier, not factor)', () => {
    expect(tierOf('page', 'none')).toBe('page')
    expect(tierOf('warning', 'none')).toBe('warning')
    expect(tierOf('info', 'none')).toBe('quiet')
  })
})
