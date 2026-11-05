import { describe, expect, it } from 'vitest'
import { severityOf } from '../src/shared/incident.ts'

describe('severity contract', () => {
  it('reads absent and critical as a page, warn as a warning, info as info', () => {
    expect(severityOf(undefined)).toBe('page')
    expect(severityOf('critical')).toBe('page')
    expect(severityOf('warn')).toBe('warning')
    expect(severityOf('info')).toBe('info')
    expect(severityOf('weird')).toBe('warning')
  })
})
