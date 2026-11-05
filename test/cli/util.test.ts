import { describe, expect, it } from 'vitest'
import { CliError, flagValue, jsonFlag, numberFlag, parseArgs } from '../../src/cli/util.ts'

const spec = { valueFlags: ['dir', 'output', 'port', 'url'], switchFlags: ['dry-run', 'no-load', 'no-runtime-surface', 'detach'] }

describe('argument parsing', () => {
  it('reads value flags in both --flag value and --flag=value forms', () => {
    const args = parseArgs(['run', '--dir', '/tmp/p', '--port=7718', '--url', 'http://x'], spec)
    expect(args.command).toBe('run')
    expect(args.dir).toBe('/tmp/p')
    expect(flagValue(args, 'port')).toBe('7718')
    expect(flagValue(args, 'url')).toBe('http://x')
  })

  it('reads a declared switch named no-... as itself, not as a negation', () => {
    const args = parseArgs(['doctor', '--no-runtime-surface', '--no-load'], spec)
    expect(args.switches.get('no-runtime-surface')).toBe(true)
    expect(args.switches.get('no-load')).toBe(true)
    expect(args.switches.has('runtime-surface')).toBe(false)
  })

  it('reads --no-<switch> as the negation of a declared switch', () => {
    const args = parseArgs(['run', '--no-detach'], spec)
    expect(args.switches.get('detach')).toBe(false)
  })

  it('maps --json and -q to json output and rejects a bad --output', () => {
    expect(parseArgs(['status', '--json'], spec).format).toBe('json')
    expect(parseArgs(['status', '-q'], spec).format).toBe('json')
    expect(parseArgs(['status', '--output', 'md'], spec).format).toBe('md')
    expect(() => parseArgs(['status', '--output', 'xml'], spec)).toThrowError(expect.objectContaining({ code: 'usage.bad-output', exitCode: 64 }))
  })

  it('refuses an unknown flag and a missing value', () => {
    expect(() => parseArgs(['status', '--nope'], spec)).toThrowError(expect.objectContaining({ code: 'usage.unknown-flag' }))
    expect(() => parseArgs(['status', '--dir'], spec)).toThrowError(expect.objectContaining({ code: 'usage.missing-value' }))
  })

  it('parses a whole number in range and a JSON object', () => {
    const args = parseArgs(['add', '--port', '8080', '--url', 'https://x'], spec)
    expect(numberFlag(args, 'port', { min: 1, max: 65535 })).toBe(8080)
    const bad = parseArgs(['add', '--port', 'eighty'], spec)
    expect(() => numberFlag(bad, 'port')).toThrowError(expect.objectContaining({ code: 'usage.bad-number' }))
    const json = parseArgs(['add', '--url', '{"ok":true}'], spec)
    expect(jsonFlag(json, 'url')).toEqual({ ok: true })
    const badJson = parseArgs(['add', '--url', '{oops'], spec)
    expect(() => jsonFlag(badJson, 'url')).toThrowError(expect.objectContaining({ code: 'usage.bad-json' }))
  })

  it('carries a usage error’s exit code and next line', () => {
    const err = new CliError('x.y', 'message', { exitCode: 64, next: 'do this' })
    expect(err.exitCode).toBe(64)
    expect(err.next).toBe('do this')
  })
})
