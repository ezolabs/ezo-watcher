// Every `watcher …` command the docs show must run through the CLI's real argument parser. The docs are a runtime surface:
// an agent copies a line out of SKILL.md or a reference and runs it, so a flag the parser does not know is a broken install
// loop, not a typo. This test extracts every command from fenced blocks and inline code in the shipped docs, substitutes the
// placeholders the docs use, and parses it with `validateCommand` — no execution, no project, no server.
//
// It is deliberately strict about vocabulary: a documented flag that the verb does not declare fails here. It is not a shell:
// a line with `[...]` or `...` is a synopsis, not a command, and is skipped; a `#` comment and shell operators are stripped.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCommand, validateCommand } from '../../src/cli/main.ts'
import { CliError } from '../../src/cli/util.ts'

const ROOT = resolve(import.meta.dirname, '../..')

function docFiles(): string[] {
  const files = ['README.md', 'AGENTS.md']
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(join(ROOT, dir), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.tmp') continue
        walk(rel)
      } else if (entry.name.endsWith('.md')) files.push(rel)
    }
  }
  walk('skills/ezo-watcher')
  walk('addons')
  walk('docs')
  return files.filter((f) => f === 'README.md' || f === 'AGENTS.md' || f !== '')
}

/** A shell-ish tokenizer: whitespace separates, quotes group. It is enough for the command vocabulary the docs use. */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = null
      else current += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      started = true
      continue
    }
    if (/\s/.test(c)) {
      if (started) tokens.push(current)
      current = ''
      started = false
      continue
    }
    current += c
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/** Placeholders the docs use, replaced with values the parser accepts. */
function substitute(text: string): string {
  const named: Record<string, string> = {
    id: 'sample',
    key: 'prod:12345678',
    url: 'https://example.com/healthz',
    project: '.',
    dir: '.',
    topic: 'discover',
    'file:line': 'README.md:1',
    type: 'ntfy',
    sender: 'grafana-alerts',
    env: 'SAMPLE_TOKEN',
    sec: '3600',
    n: '1',
    ms: '1000',
    days: '30',
    host: 'db.example.com',
    port: '5432',
    domain: 'example.com',
    space: '00000000-0000-4000-8000-000000000001',
    room: '00000000-0000-4000-8000-000000000002',
    machine: 'sample'
  }
  return text
    .replace(/\$\([^)]*\)/g, 'sample')
    .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, 'sample')
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, 'sample')
    .replace(/<([^<>]*)>/g, (all, name: string) => {
      const key = name.trim().toLowerCase()
      return named[key] ?? named[key.split(/\s+/)[0]] ?? 'sample'
    })
}

interface Documented {
  file: string
  line: number
  command: string
  /** True for a line in a fenced shell block (a command to run); false for an inline-code reference (a synonym). */
  fence: boolean
}

/** The verbs the CLI ships; an inline reference to a placeholder (`watcher <verb>`) is not a command. */
const VERBS = new Set(['init', 'add', 'rm', 'doctor', 'scan', 'run', 'stop', 'service', 'status', 'incidents', 'incident', 'recheck', 'test-alert', 'mcp-config', 'mcp', 'hooks', 'skills', 'cloudflare', 'telemetry'])

/** A value-taking flag with nothing after it is a synopsis (`watcher add tcp-probe --host --port`), not a command. */
const VALUE_FLAGS = new Set(['dir', 'output', 'id', 'service', 'url', 'host', 'port', 'expect-json', 'expect-status', 'slow-ms', 'interval', 'poll-sec', 'fail-after', 'token-env', 'stale-after-sec', 'presence-ttl-sec', 'recheck-pickup-sec', 'origin', 'timeout-ms', 'public-url', 'org', 'projects', 'project', 'web-url', 'space-id', 'room-id', 'fleet-nodes', 'every', 'schedule', 'grace', 'timezone', 'name', 'domain', 'url-env', 'server', 'topic-env', 'api-key-env', 'from-env', 'to-env', 'from', 'provider', 'public-key-env', 'private-key-env', 'subject', 'header', 'secret-value', 'set', 'path', 'self-server', 'self-url-env', 'self-topic-env', 'self-token-env', 'primary-env', 'base-url', 'found-at', 'read', 'mount', 'pid-file', 'warn-days', 'page-days', 'target', 'hostname', 'access-email', 'account-id', 'tunnel-name', 'severity', 'limit', 'channel', 'client', 'key', 'fix-context', 'max-files', 'range'])

function isReference(tokens: string[]): boolean {
  if (tokens.length === 0) return true
  if (!VERBS.has(tokens[0]) && !tokens[0].startsWith('-')) return true
  if (tokens[0] === 'add' && !tokens.includes('--id') && !tokens.includes('--help')) return true
  if (['rm', 'incident', 'recheck'].includes(tokens[0]) && tokens.length < 2) return true
  for (let i = 0; i < tokens.length; i++) {
    const name = tokens[i].startsWith('--') ? tokens[i].slice(2).split('=')[0] : ''
    if (VALUE_FLAGS.has(name) && !tokens[i].includes('=') && (tokens[i + 1] === undefined || tokens[i + 1].startsWith('-'))) return true
  }
  return false
}

/** Every command a doc shows: fenced-block shell lines and inline code spans that start with `watcher`. */
function commandsIn(file: string, text: string): Documented[] {
  const out: Documented[] = []
  const lines = text.split(/\r?\n/)
  let fence = false
  let pending = ''
  let pendingLine = 0
  const emit = (raw: string, line: number, fenceLine: boolean): void => {
    let logical = raw.trim()
    if (logical.startsWith('$ ')) logical = logical.slice(2)
    // A shell comment ends the command on the line.
    logical = logical.replace(/\s+#.*$/, '')
    for (const segment of logical.split(/\s+(?:&&|\|\|)\s+|;\s+|\s+\|\s+/)) {
      const command = segment.trim().replace(/^watcher\s+/, '')
      if (command === segment.trim()) continue // not a watcher command
      out.push({ file, line, command, fence: fenceLine })
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (/^\s*```/.test(raw)) {
      fence = !fence
      continue
    }
    if (fence) {
      pending = pending === '' ? raw : `${pending} ${raw.trim()}`
      if (pendingLine === 0) pendingLine = i + 1
      if (/\\\s*$/.test(raw)) {
        pending = pending.replace(/\\\s*$/, '')
        continue
      }
      emit(pending, pendingLine, true)
      pending = ''
      pendingLine = 0
      continue
    }
    for (const match of raw.matchAll(/`([^`\n]+)`/g)) {
      const span = match[1]
      if (!/\bwatcher\s/.test(span)) continue
      if (!span.trim().startsWith('watcher ')) continue
      emit(span, i + 1, false)
    }
  }
  return out
}

/** A synopsis (`watcher add <kind> [flags]`) is not a command; its brackets say so. */
const isSynopsis = (command: string): boolean => /\[[^\]]*\]/.test(command) || /\.\.\.|…/.test(command)

function run(argv: string[]): void {
  validateCommand(argv)
}

describe('every documented watcher command parses', () => {
  const files = docFiles()
  const documented: Documented[] = files.flatMap((file) => commandsIn(file, readFileSync(join(ROOT, file), 'utf8')))
  const real = documented.filter((entry) => !isSynopsis(entry.command) && entry.command.trim() !== '' && (entry.fence || !isReference(tokenize(substitute(entry.command)))))

  it('extracts commands from every documented surface', () => {
    // A regression in the extractor (a changed fence, a renamed file) must not silently empty the test.
    expect(real.length).toBeGreaterThan(20)
    expect(real.filter((entry) => entry.fence).length).toBeGreaterThan(10)
    for (const surface of ['README.md', 'AGENTS.md', 'skills/ezo-watcher/SKILL.md', 'docs/doctor-codes.md']) {
      expect(real.some((entry) => entry.file === surface), surface).toBe(true)
    }
    expect(real.some((entry) => entry.fence && entry.command.startsWith('add http-probe --id app --url'))).toBe(true)
  })

  it('parses every command with the real CLI parser and accepts only flags the verb declares', () => {
    const failures: string[] = []
    for (const entry of real) {
      const tokens = tokenize(substitute(entry.command))
      try {
        // A fenced line is a command to run and must name its required flags; an inline-code reference is a synonym,
        // so it must know every flag it names but need not be runnable on its own.
        if (entry.fence) run(tokens)
        else parseCommand(tokens)
      } catch (err) {
        const detail = err instanceof CliError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err)
        failures.push(`${entry.file}:${entry.line}: watcher ${entry.command} -> ${detail}`)
      }
    }
    expect(failures.join('\n')).toBe('')
  })

  it('accepts a global flag before the verb', () => {
    expect(() => run(['--dir', 'sample', 'init', '--dry-run'])).not.toThrow()
    expect(() => run(['--dir=sample', 'doctor', '--json'])).not.toThrow()
    expect(() => run(['--output', 'json', 'status'])).not.toThrow()
  })

  it('accepts the flags the docs add: --tls, --warn-days/--page-days, repeated --project, --set on a kind', () => {
    expect(() => run(['add', 'tcp-probe', '--id', 'db', '--host', 'db.example.com', '--port', '5432', '--tls'])).not.toThrow()
    expect(() => run(['add', 'domain-expiry', '--id', 'domains', '--domain', 'example.com', '--warn-days', '30', '--page-days', '7'])).not.toThrow()
    expect(() => run(['add', 'sentry', '--id', 'sentry', '--org', 'sample', '--token-env', 'SENTRY_TOKEN', '--project', 'web=frontend', '--project', 'api=api'])).not.toThrow()
    expect(() => run(['add', 'host', '--id', 'host', '--set', 'mounts=["/","/data"]', '--set', 'pidFile=/run/app.pid'])).not.toThrow()
  })

  it('still refuses a flag no verb declares', () => {
    expect(() => run(['doctor', '--intervl', '60'])).toThrow(/unknown flag/)
  })

  it('documents the npm package and its npx form, and no doc still says it is unpublished', () => {
    for (const file of files) {
      const text = readFileSync(join(ROOT, file), 'utf8')
      expect(/not (?:yet )?on npm/i.test(text), file).toBe(false)
    }
    for (const file of ['README.md', 'skills/ezo-watcher/SKILL.md', 'skills/ezo-watcher/references/install.md']) {
      const text = readFileSync(join(ROOT, file), 'utf8')
      expect(text, file).toContain('npm i -g ezo-watcher')
      expect(text, file).toContain('npx -y ezo-watcher')
    }
  })

  it('keeps server.json (the MCP Registry entry) on the package name, mcpName and version', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const server = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf8'))
    expect(server.name).toBe(pkg.mcpName)
    expect(server.version).toBe(pkg.version)
    expect(server.packages[0].identifier).toBe(pkg.name)
    expect(server.packages[0].version).toBe(pkg.version)
  })

  it('names the doctor code the skill tells an agent to look for', () => {
    const skill = readFileSync(join(ROOT, 'skills/ezo-watcher/SKILL.md'), 'utf8')
    expect(skill).toContain('channel.missing')
    const channels = readFileSync(join(ROOT, 'skills/ezo-watcher/references/channels.md'), 'utf8')
    expect(channels).toContain('channel.missing')
  })
})

// Keep the relative-path helper used above honest: a file that moved out of the doc surfaces is a finding, not a silent skip.
describe('the documentation surfaces exist', () => {
  it('finds the shipped docs', () => {
    for (const file of ['README.md', 'AGENTS.md', 'skills/ezo-watcher/SKILL.md', 'docs/doctor-codes.md']) {
      expect(readFileSync(join(ROOT, file), 'utf8').length, file).toBeGreaterThan(0)
      expect(relative(ROOT, join(ROOT, file))).toBe(file)
    }
  })
})
