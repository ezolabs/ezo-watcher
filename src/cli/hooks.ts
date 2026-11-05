// `watcher hooks install|uninstall --target claude|codex`: put `watcher status --brief` in front of a coding session.
//
// Claude Code reads a `SessionStart` hook from `.claude/settings.json`; the shape below is the one in the hooks reference at
// https://code.claude.com/docs/en/hooks (retrieved 2026-11-04): an event maps to an array of matcher groups, and each group
// has an inner `hooks` array of handlers (`{"type":"command","command":...,"timeout":<seconds>}`). SessionStart's matcher
// names how the session began: `startup|resume|clear|compact|fork`.
//
// Codex has no session-hook API, so its install is an instruction block in the project's AGENTS.md between two markers;
// uninstall removes exactly that block. Every write is idempotent, preserves everything it did not add, and `--dry-run`
// reports the change without writing.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ParsedArgs } from './util.ts'
import { CliError, flagValue, usageError } from './util.ts'
import type { Output } from './output.ts'
import { resolveProject, writeFileAtomic } from './project.ts'

export const HOOKS_SPEC = {
  valueFlags: ['dir', 'output', 'target'],
  switchFlags: ['help', 'dry-run'],
  subVerbs: ['install', 'uninstall']
} as const

export const HOOK_COMMAND = 'watcher status --brief'
export const HOOK_MATCHER = 'startup|resume|clear|compact|fork'
export const CODEX_START = '<!-- ezo-watcher:start -->'
export const CODEX_END = '<!-- ezo-watcher:end -->'
export const HOOKS_DOC_URL = 'https://code.claude.com/docs/en/hooks'

/** The block the Codex target writes: the instruction, between markers only this command writes. */
export const CODEX_BLOCK = [
  CODEX_START,
  '## Watch status',
  '',
  `At the start of a task, run \`${HOOK_COMMAND}\`. It lists the open incidents in at most ten lines and prints nothing when everything is green.`,
  CODEX_END
].join('\n')

interface HookHandler {
  type?: unknown
  command?: unknown
  [key: string]: unknown
}

interface HookGroup {
  matcher?: unknown
  hooks?: unknown
  [key: string]: unknown
}

type Settings = Record<string, unknown>

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

function hooksOf(settings: Settings): Record<string, unknown> {
  if (settings.hooks === undefined) return {}
  if (!isObject(settings.hooks)) throw new Error('settings.hooks is not an object')
  return settings.hooks
}

function groupHasCommand(group: unknown, command: string): boolean {
  if (!isObject(group) || !Array.isArray(group.hooks)) return false
  return group.hooks.some((h) => isObject(h) && h.type === 'command' && h.command === command)
}

export type MergeResult = { ok: true; settings: Settings; changed: boolean; removed: number } | { ok: false; error: string }

/** Add the SessionStart handler once. Every other setting, event and hook is kept as it was. */
export function installClaudeHook(settings: Settings, opts: { command?: string; matcher?: string } = {}): MergeResult {
  const command = opts.command ?? HOOK_COMMAND
  const matcher = opts.matcher ?? HOOK_MATCHER
  let hooks: Record<string, unknown>
  try {
    hooks = { ...hooksOf(settings) }
  } catch (err) {
    return { ok: false, error: `${(err as Error).message}; fix or remove it and run the command again` }
  }
  const existing = hooks.SessionStart
  if (existing !== undefined && !Array.isArray(existing)) {
    return { ok: false, error: 'hooks.SessionStart is not a list; fix or remove it and run the command again' }
  }
  const groups = Array.isArray(existing) ? [...existing] : []
  if (groups.some((g) => groupHasCommand(g, command))) {
    return { ok: true, settings, changed: false, removed: 0 }
  }
  groups.push({ matcher, hooks: [{ type: 'command', command, timeout: 10 }] })
  hooks.SessionStart = groups
  return { ok: true, settings: { ...settings, hooks }, changed: true, removed: 0 }
}

/** Remove exactly the handler(s) `installClaudeHook` adds, and the matcher group or event it leaves empty. */
export function uninstallClaudeHook(settings: Settings, opts: { command?: string } = {}): MergeResult {
  const command = opts.command ?? HOOK_COMMAND
  let hooks: Record<string, unknown>
  try {
    hooks = { ...hooksOf(settings) }
  } catch (err) {
    return { ok: false, error: `${(err as Error).message}; fix or remove it and run the command again` }
  }
  let removed = 0
  // Only SessionStart: that is the event `installClaudeHook` writes. The same command under another event (a user's own
  // PreToolUse hook, say) is not ours to remove.
  for (const event of ['SessionStart']) {
    const value = hooks[event]
    if (value === undefined) continue
    if (!Array.isArray(value)) continue
    const keptGroups: unknown[] = []
    for (const group of value) {
      if (!isObject(group) || !Array.isArray(group.hooks)) {
        keptGroups.push(group)
        continue
      }
      const kept = (group.hooks as HookHandler[]).filter((h) => {
        const ours = isObject(h) && h.type === 'command' && h.command === command
        if (ours) removed += 1
        return !ours
      })
      // A group that held only our handler is dropped whole; one with any other handler keeps its matcher and the rest.
      if (kept.length > 0) keptGroups.push({ ...(group as HookGroup), hooks: kept })
    }
    if (keptGroups.length === 0) delete hooks[event]
    else hooks[event] = keptGroups
  }
  if (removed === 0) return { ok: true, settings, changed: false, removed: 0 }
  const next: Settings = { ...settings }
  if (Object.keys(hooks).length === 0) delete next.hooks
  else next.hooks = hooks
  return { ok: true, settings: next, changed: true, removed }
}

/** The AGENTS.md text with the block appended or replaced between the markers. */
export function installCodexBlock(text: string): { ok: true; text: string; changed: boolean } | { ok: false; error: string } {
  const start = text.indexOf(CODEX_START)
  const end = text.indexOf(CODEX_END)
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    return { ok: false, error: `AGENTS.md holds one of ${CODEX_START} / ${CODEX_END} but not a matching pair; remove it or restore the pair and run the command again` }
  }
  if (start !== -1) {
    const next = `${text.slice(0, start)}${CODEX_BLOCK}${text.slice(end + CODEX_END.length)}`
    return { ok: true, text: next, changed: next !== text }
  }
  const base = text === '' ? '' : text.endsWith('\n') ? `${text}\n` : `${text}\n\n`
  return { ok: true, text: `${base}${CODEX_BLOCK}\n`, changed: true }
}

/** The AGENTS.md text with the marker block (and the blank line install added in front of it) removed. */
export function uninstallCodexBlock(text: string): { ok: true; text: string; changed: boolean } | { ok: false; error: string } {
  const start = text.indexOf(CODEX_START)
  const end = text.indexOf(CODEX_END)
  if (start === -1 && end === -1) return { ok: true, text, changed: false }
  if (start === -1 || end === -1 || end < start) {
    return { ok: false, error: `AGENTS.md holds one of ${CODEX_START} / ${CODEX_END} but not a matching pair; remove it by hand and run the command again` }
  }
  const before = text.slice(0, start).replace(/\n\n$/, '\n')
  const after = text.slice(end + CODEX_END.length).replace(/^\n/, '')
  const next = before + after
  return { ok: true, text: next, changed: true }
}

function readSettings(path: string): { ok: true; settings: Settings } | { ok: false; error: string } {
  if (!existsSync(path)) return { ok: true, settings: {} }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    return { ok: false, error: `${path}: ${(err as Error).message}` }
  }
  if (text.trim() === '') return { ok: true, settings: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (err) {
    return { ok: false, error: `${path} is not JSON: ${(err as Error).message}` }
  }
  if (!isObject(parsed)) return { ok: false, error: `${path}: the top level must be a JSON object` }
  return { ok: true, settings: parsed }
}

export interface HooksOutcome {
  action: 'install' | 'uninstall'
  target: 'claude' | 'codex'
  path: string
  changed: boolean
  removed: number
  dryRun: boolean
}

function targetOf(args: ParsedArgs): 'claude' | 'codex' {
  const target = (flagValue(args, 'target') ?? 'claude').toLowerCase()
  if (target !== 'claude' && target !== 'codex') {
    throw usageError('hooks.unknown-target', `--target must be claude or codex, not ${JSON.stringify(target)}`, 'Example: watcher hooks install --target claude')
  }
  return target
}

export async function runHooks(args: ParsedArgs, out: Output): Promise<number> {
  const action = args.sub
  if (action !== 'install' && action !== 'uninstall') {
    throw usageError('hooks.missing-action', 'hooks needs install or uninstall', 'Run `watcher hooks install --target claude` or `watcher hooks uninstall`.')
  }
  const target = targetOf(args)
  const project = resolveProject(args.dir)
  const dryRun = args.dryRun
  let outcome: HooksOutcome

  if (target === 'claude') {
    const path = join(project.dir, '.claude', 'settings.json')
    const read = readSettings(path)
    if (!read.ok) throw new CliError('hooks.unreadable', read.error, { next: `Fix ${path} and run the command again.` })
    const merged = action === 'install' ? installClaudeHook(read.settings) : uninstallClaudeHook(read.settings)
    if (!merged.ok) throw new CliError('hooks.invalid', merged.error, { next: `Fix ${path} and run the command again.` })
    if (merged.changed && !dryRun) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileAtomic(path, `${JSON.stringify(merged.settings, null, 2)}\n`, 0o644)
    }
    outcome = { action, target, path, changed: merged.changed, removed: merged.removed, dryRun }
  } else {
    const path = join(project.dir, 'AGENTS.md')
    let text = ''
    if (existsSync(path)) {
      try {
        text = readFileSync(path, 'utf8')
      } catch (err) {
        throw new CliError('hooks.unreadable', `${path}: ${(err as Error).message}`, { next: `Fix ${path} and run the command again.` })
      }
    }
    const merged = action === 'install' ? installCodexBlock(text) : uninstallCodexBlock(text)
    if (!merged.ok) throw new CliError('hooks.invalid', merged.error, { next: `Fix ${path} and run the command again.` })
    if (merged.changed && !dryRun) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileAtomic(path, merged.text, 0o644)
    }
    outcome = { action, target, path, changed: merged.changed, removed: merged.changed ? 1 : 0, dryRun }
  }

  out.json({ ok: true, ...outcome, ...(target === 'claude' ? { hook: { event: 'SessionStart', matcher: HOOK_MATCHER, command: HOOK_COMMAND, timeout: 10 }, docs: HOOKS_DOC_URL } : { block: { start: CODEX_START, end: CODEX_END } }) })
  const verb = action === 'install' ? (outcome.changed ? 'installed' : 'already installed') : outcome.removed > 0 ? 'removed' : 'nothing to remove'
  out.line(`${out.bold('hooks')} ${action} ${target}  ${outcome.changed ? out.ok(verb) : out.dim(verb)}  ${outcome.path}${dryRun ? out.dim(' (dry run: nothing written)') : ''}`)
  if (target === 'claude') {
    out.line(`  ${HOOK_COMMAND} runs at SessionStart (${HOOK_MATCHER}), timeout 10 s.`)
    out.line(`  shape: ${HOOKS_DOC_URL} (retrieved 2026-11-04)`)
  } else {
    out.line('  Codex has no session hook API, so the instruction goes in AGENTS.md between the markers.')
  }
  out.md(`# hooks ${action}: ${target}`)
  out.md('')
  out.md(`- Path: \`${outcome.path}\``)
  out.md(`- Changed: ${outcome.changed ? 'yes' : 'no'}${dryRun ? ' (dry run)' : ''}`)
  if (target === 'claude') out.md(`- Hook: SessionStart ${HOOK_MATCHER} → \`${HOOK_COMMAND}\` (shape: ${HOOKS_DOC_URL}, retrieved 2026-11-04)`)
  else out.md(`- Block: between ${CODEX_START} and ${CODEX_END}`)
  return 0
}
