// `watcher hooks install|uninstall` and `watcher status --brief`: the SessionStart hook (the Claude Code shape) and the
// AGENTS.md block for Codex, both idempotent and both removed exactly; and the ten-line brief a session reads, which prints
// nothing at all when the wall is green or the Watcher is not running.
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { INIT_SPEC, runInit } from '../../src/cli/init.ts'
import { STATUS_SPEC, runStatus } from '../../src/cli/status.ts'
import {
  CODEX_END,
  CODEX_START,
  HOOK_COMMAND,
  HOOK_MATCHER,
  HOOKS_SPEC,
  installClaudeHook,
  installCodexBlock,
  runHooks,
  uninstallClaudeHook,
  uninstallCodexBlock
} from '../../src/cli/hooks.ts'
import { EnvGuard, WATCHER_KEYS, capture, fakeServer, parse, readJson, rmTemp, tempDir } from './helpers.ts'

const guards: Array<() => void> = []
const dirs: string[] = []

function guard(): EnvGuard {
  const g = new EnvGuard(WATCHER_KEYS)
  guards.push(() => g.restore())
  return g
}

afterEach(() => {
  for (const restore of guards.splice(0)) restore()
  for (const dir of dirs.splice(0)) rmTemp(dir)
})

async function seeded(prefix: string): Promise<string> {
  const g = guard()
  g.set({ WATCHER_ACK_SECRET: 'ack-test', WATCHER_MCP_TOKEN: undefined, WATCHER_PORT: undefined, WATCHER_HOST: undefined, WATCHER_CONFIG: undefined, WATCHER_DATA_DIR: undefined })
  const dir = tempDir(prefix)
  dirs.push(dir)
  expect(await runInit(parse(['init', '--dir', dir], INIT_SPEC), capture('json').out)).toBe(0)
  const path = join(dir, '.watcher', 'config.json')
  const raw = readJson(path)
  raw.sources = [{ id: 'probe', type: 'http-probe', targets: [{ id: 'api', service: 'api', url: 'https://api.example.com/healthz' }] }]
  raw.channels = []
  raw.routes = []
  writeFileSync(path, JSON.stringify(raw, null, 2))
  return dir
}

describe('the Claude Code hook merge', () => {
  it('adds one SessionStart handler in the documented shape and preserves every other setting and hook', () => {
    const settings = {
      model: 'opus',
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh' }] }] }
    }
    const r = installClaudeHook(settings)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.changed).toBe(true)
    expect(r.settings.model).toBe('opus')
    expect(r.settings.hooks).toMatchObject({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh' }] }] })
    expect(r.settings.hooks).toMatchObject({
      SessionStart: [{ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 10 }] }]
    })
  })

  it("is idempotent and removes exactly the handler it added, keeping the user's own SessionStart hook", () => {
    const user = { matcher: 'startup', hooks: [{ type: 'command', command: './hello.sh' }] }
    const first = installClaudeHook({ hooks: { SessionStart: [user] } })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = installClaudeHook(first.settings)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.changed).toBe(false)

    const removed = uninstallClaudeHook(second.settings)
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect(removed.removed).toBe(1)
    expect(removed.settings.hooks).toEqual({ SessionStart: [user] })
  })

  it('removes only the SessionStart handler, leaving the same command under another event alone', () => {
    const settings = {
      hooks: {
        SessionStart: [{ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 10 }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: HOOK_COMMAND }] }]
      }
    }
    const r = uninstallClaudeHook(settings)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.removed).toBe(1)
    expect(r.settings.hooks).toEqual({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: HOOK_COMMAND }] }] })
  })

  it('drops the event and the hooks object when the removed handler was all there was', () => {
    const r = installClaudeHook({})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const back = uninstallClaudeHook(r.settings)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.settings).toEqual({})
  })

  it('refuses a malformed hooks value instead of overwriting it', () => {
    const r = installClaudeHook({ hooks: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('hooks')
    const r2 = installClaudeHook({ hooks: { SessionStart: 'soon' } })
    expect(r2.ok).toBe(false)
  })
})

describe('the Codex AGENTS.md block', () => {
  it('appends between markers, is idempotent, preserves the rest, and uninstall removes exactly it', () => {
    const original = '# Project\n\nRead this first.\n'
    const first = installCodexBlock(original)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.changed).toBe(true)
    expect(first.text).toContain(original)
    expect(first.text).toContain(CODEX_START)
    expect(first.text).toContain('At the start of a task, run `watcher status --brief`')
    const second = installCodexBlock(first.text)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.changed).toBe(false)
    const back = uninstallCodexBlock(second.text)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.text).toBe(original)
  })

  it('refuses a lone marker rather than writing between the wrong lines', () => {
    expect(installCodexBlock(`${CODEX_START}\nno end\n`).ok).toBe(false)
    expect(uninstallCodexBlock(`text\n${CODEX_END}\n`).ok).toBe(false)
  })
})

describe('watcher hooks', () => {
  it('installs the claude hook into .claude/settings.json, reports an idempotent second run, and uninstalls it', async () => {
    const dir = await seeded('hooks-claude')
    const settingsPath = join(dir, '.claude', 'settings.json')
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({ model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh' }] }] } }, null, 2))
    const cap = capture('json')
    expect(await runHooks(parse(['hooks', 'install', '--target', 'claude', '--dir', dir], HOOKS_SPEC), cap.out)).toBe(0)
    const installed = JSON.parse(cap.stdout()) as { changed: boolean; path: string; hook: { command: string; event: string } }
    expect(installed.changed).toBe(true)
    expect(installed.path).toBe(settingsPath)
    expect(installed.hook).toMatchObject({ event: 'SessionStart', command: HOOK_COMMAND })
    const saved = JSON.parse(readFileSync(settingsPath, 'utf8')) as { model: string; hooks: Record<string, unknown> }
    expect(saved.model).toBe('opus')
    expect(saved.hooks.PreToolUse).toBeDefined()
    expect(saved.hooks.SessionStart).toEqual([{ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 10 }] }])

    cap.reset()
    expect(await runHooks(parse(['hooks', 'install', '--target', 'claude', '--dir', dir], HOOKS_SPEC), cap.out)).toBe(0)
    expect((JSON.parse(cap.stdout()) as { changed: boolean }).changed).toBe(false)
    expect((JSON.parse(readFileSync(settingsPath, 'utf8')) as { hooks: { SessionStart: unknown[] } }).hooks.SessionStart).toHaveLength(1)

    cap.reset()
    expect(await runHooks(parse(['hooks', 'uninstall', '--target', 'claude', '--dir', dir], HOOKS_SPEC), cap.out)).toBe(0)
    const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as { model: string; hooks: Record<string, unknown> }
    expect(after.model).toBe('opus')
    expect(after.hooks.PreToolUse).toBeDefined()
    expect(after.hooks.SessionStart).toBeUndefined()
  })

  it('creates .claude/settings.json when the project has none', async () => {
    const dir = await seeded('hooks-new')
    const settingsPath = join(dir, '.claude', 'settings.json')
    expect(existsSync(settingsPath)).toBe(false)
    const cap = capture('json')
    expect(await runHooks(parse(['hooks', 'install', '--target', 'claude', '--dir', dir], HOOKS_SPEC), cap.out)).toBe(0)
    expect(existsSync(settingsPath)).toBe(true)
    const saved = JSON.parse(readFileSync(settingsPath, 'utf8')) as { hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } }
    expect(saved.hooks.SessionStart[0].hooks[0].command).toBe(HOOK_COMMAND)
  })

  it('--dry-run reports the change and writes nothing', async () => {
    const dir = await seeded('hooks-dry')
    const settingsPath = join(dir, '.claude', 'settings.json')
    const cap = capture('json')
    expect(await runHooks(parse(['hooks', 'install', '--target', 'claude', '--dir', dir, '--dry-run'], HOOKS_SPEC), cap.out)).toBe(0)
    const out = JSON.parse(cap.stdout()) as { changed: boolean; dryRun: boolean }
    expect(out).toMatchObject({ changed: true, dryRun: true })
    expect(existsSync(settingsPath)).toBe(false)
  })

  it('writes the codex instruction block into AGENTS.md and removes exactly it', async () => {
    const dir = await seeded('hooks-codex')
    const agents = join(dir, 'AGENTS.md')
    writeFileSync(agents, '# Project\n\nRead this first.\n')
    const cap = capture('json')
    expect(await runHooks(parse(['hooks', 'install', '--target', 'codex', '--dir', dir], HOOKS_SPEC), cap.out)).toBe(0)
    expect(existsSync(agents)).toBe(true)
    const text = readFileSync(agents, 'utf8')
    expect(text).toContain(CODEX_START)
    expect(text).toContain('At the start of a task, run `watcher status --brief`')
    expect(text).toContain(CODEX_END)
    expect(text).toContain('# Project')

    cap.reset()
    expect(await runHooks(parse(['hooks', 'install', '--target', 'codex', '--dir', dir], HOOKS_SPEC), cap.out)).toBe(0)
    expect((JSON.parse(cap.stdout()) as { changed: boolean }).changed).toBe(false)

    cap.reset()
    expect(await runHooks(parse(['hooks', 'uninstall', '--target', 'codex', '--dir', dir], HOOKS_SPEC), cap.out)).toBe(0)
    expect(readFileSync(agents, 'utf8')).toBe('# Project\n\nRead this first.\n')
  })

  it('refuses an unknown target and a missing action as usage errors', async () => {
    const dir = await seeded('hooks-bad')
    await expect(runHooks(parse(['hooks', 'install', '--target', 'vim', '--dir', dir], HOOKS_SPEC), capture('json').out)).rejects.toMatchObject({ exitCode: 64 })
    await expect(runHooks(parse(['hooks', '--dir', dir], HOOKS_SPEC), capture('json').out)).rejects.toMatchObject({ exitCode: 64 })
  })
})

describe('watcher status --brief', () => {
  function briefServer(incidents: Array<Record<string, unknown>>) {
    return fakeServer((req, res) => {
      if ((req.url ?? '') === '/api/state') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ generatedAt: new Date().toISOString(), header: {}, sources: [], channels: [], health: [], incidents }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"not found"}')
    })
  }

  const incident = (n: number, state: Record<string, unknown> = { firing: true, attention: 'none' }) => ({
    key: `Api|Rule${n}`,
    service: 'Api',
    rule: `Rule${n}`,
    instance: null,
    summary: `Rule${n} is firing`,
    severity: n === 0 ? 'page' : 'warning',
    startsAt: new Date(Date.now() - (n + 1) * 60_000).toISOString(),
    state,
    alerts: [{}]
  })

  it('prints one line per open incident plus the fix hint, and leaves parked and green ones out', async () => {
    const dir = await seeded('brief-open')
    const server = await briefServer([incident(0), incident(1), incident(2, { firing: false, attention: 'parked' })])
    try {
      const cap = capture('table')
      expect(await runStatus(parse(['status', '--dir', dir, '--url', server.url, '--brief'], STATUS_SPEC), cap.out)).toBe(0)
      const lines = cap.stdout().trim().split('\n')
      expect(lines.length).toBeLessThanOrEqual(10)
      expect(lines.some((l) => l.includes('page') && l.includes('Api') && l.includes('Rule0') && l.includes('Api|Rule0'))).toBe(true)
      expect(lines.some((l) => l.includes('Api|Rule2'))).toBe(false)
      expect(lines[lines.length - 1]).toContain('watcher incident <key> --fix-context')
      expect(lines[lines.length - 1]).toContain('get_fix_context')
    } finally {
      await server.close()
    }
  })

  it('stays within ten lines when many incidents are open, and says how many more', async () => {
    const dir = await seeded('brief-many')
    const server = await briefServer(Array.from({ length: 12 }, (_, i) => incident(i)))
    try {
      const cap = capture('table')
      expect(await runStatus(parse(['status', '--dir', dir, '--url', server.url, '--brief'], STATUS_SPEC), cap.out)).toBe(0)
      const lines = cap.stdout().trim().split('\n')
      expect(lines.length).toBeLessThanOrEqual(10)
      expect(lines.some((l) => l.includes('+4 more'))).toBe(true)
      expect(lines[lines.length - 1]).toContain('watcher incident <key> --fix-context')
    } finally {
      await server.close()
    }
  })

  it('prints nothing and exits 0 when everything is green', async () => {
    const dir = await seeded('brief-green')
    const server = await briefServer([])
    try {
      const cap = capture('table')
      expect(await runStatus(parse(['status', '--dir', dir, '--url', server.url, '--brief'], STATUS_SPEC), cap.out)).toBe(0)
      expect(cap.stdout()).toBe('')
    } finally {
      await server.close()
    }
  })

  it('prints nothing and exits 0 when the Watcher is not running', async () => {
    const dir = await seeded('brief-down')
    const cap = capture('table')
    expect(await runStatus(parse(['status', '--dir', dir, '--url', 'http://127.0.0.1:1', '--brief'], STATUS_SPEC), cap.out)).toBe(0)
    expect(cap.stdout()).toBe('')
  })

  it('answers --json with the incidents and the hint when an agent asks for them', async () => {
    const dir = await seeded('brief-json')
    const server = await briefServer([incident(0)])
    try {
      const cap = capture('json')
      expect(await runStatus(parse(['status', '--dir', dir, '--url', server.url, '--brief'], STATUS_SPEC), cap.out)).toBe(0)
      const out = JSON.parse(cap.stdout()) as { ok: boolean; count: number; incidents: Array<{ key: string }>; hint: string }
      expect(out.ok).toBe(true)
      expect(out.count).toBe(1)
      expect(out.incidents[0].key).toBe('Api|Rule0')
      expect(out.hint).toContain('get_fix_context')
    } finally {
      await server.close()
    }
  })
})
