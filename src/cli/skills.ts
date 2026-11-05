// `watcher skills`: the agent-facing docs that ship with the CLI, read from the package at runtime
// (so the docs and the CLI are one version), and the Checkly-style install into a project.
//
//   watcher skills                     list the topics
//   watcher skills <topic>             print skills/ezo-watcher/references/<topic>.md
//   watcher skills install --target claude|codex|cursor|agents|all [--dir .] [--force]
//
// The install writes the skill where each host looks for it:
//   .claude/skills/ezo-watcher/   Claude Code (reload with /reload-skills)
//   .agents/skills/ezo-watcher/   Codex, Cursor and the generic .agents convention
// and prints the host's reload step as its last line. The directory is created mid-session, so
// Claude Code needs /reload-skills: a skill added after the session started is not listed until then
// (code.claude.com/docs/en/skills, read 2026-11-04 by the #11 refuter).
//
// The files themselves are owned by the agent-surface work, not this module: this code reads and
// copies whatever the package ships, and reports a missing package skill as a named failure instead
// of inventing content.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import type { ParsedArgs } from './util.ts'
import { CliError, flagValue } from './util.ts'
import type { Output } from './output.ts'
import { packageRoot, resolveProject, writeFileAtomic } from './project.ts'

export const SKILLS_SPEC = {
  valueFlags: ['dir', 'output', 'target'],
  switchFlags: ['help', 'force', 'dry-run'],
  subVerbs: ['install']
} as const

/** The documented topic list, used only to describe the expected set when the package has none. */
export const DOCUMENTED_TOPICS = ['install', 'discover', 'sources', 'channels', 'hosting', 'cloudflare', 'netdata', 'fix', 'operate', 'telemetry'] as const

/** Where the skill files live in the package. */
export function skillsDir(root = packageRoot()): string {
  return join(root, 'skills', 'ezo-watcher')
}

/** The topics the package ships, from the references directory. */
export function listTopics(root = packageRoot()): string[] {
  const dir = join(skillsDir(root), 'references')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => basename(f, '.md'))
      .sort()
  } catch {
    return []
  }
}

/** Read one topic's markdown. */
export function readTopic(topic: string, root = packageRoot()): string {
  const safe = /^[a-z0-9][a-z0-9-]{0,63}$/.test(topic)
  if (!safe) throw new CliError('skills.bad-topic', `topic ${JSON.stringify(topic)} is not a topic name`, { exitCode: 64, next: 'watcher skills   (lists the topics)' })
  const file = join(skillsDir(root), 'references', `${topic}.md`)
  if (!existsSync(file)) {
    const available = listTopics(root)
    throw new CliError('skills.topic-missing', `no topic ${topic} in ${dirname(file)}`, {
      next: available.length > 0 ? `Available: ${available.join(', ')}` : `This package ships no skill files (${skillsDir(root)} is empty); reinstall ezo-watcher.`
    })
  }
  return readFileSync(file, 'utf8')
}

export interface InstallTarget {
  name: 'claude' | 'agents'
  dir: string
  hosts: string[]
}

/** Resolve `--target` to the directories to write. */
export function installTargets(target: string, projectDir: string): InstallTarget[] {
  const claude: InstallTarget = { name: 'claude', dir: join(projectDir, '.claude', 'skills', 'ezo-watcher'), hosts: ['claude'] }
  const agents: InstallTarget = { name: 'agents', dir: join(projectDir, '.agents', 'skills', 'ezo-watcher'), hosts: ['codex', 'cursor', 'agents'] }
  if (target === 'claude') return [claude]
  if (target === 'codex' || target === 'cursor' || target === 'agents') return [agents]
  if (target === 'all') return [claude, agents]
  throw new CliError('skills.bad-target', `--target must be claude, codex, cursor, agents or all, not ${JSON.stringify(target)}`, {
    exitCode: 64,
    next: 'Example: watcher skills install --target claude'
  })
}

/** Every file under a skill directory, relative to it. */
function skillFiles(root: string): string[] {
  const base = skillsDir(root)
  if (!existsSync(base)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (st.isFile()) out.push(relative(base, p))
    }
  }
  walk(base)
  return out.sort()
}

/** The last line of an install: what the host must do to see the new skill. */
export function reloadStep(targets: InstallTarget[]): string {
  if (targets.some((t) => t.name === 'claude')) return 'Claude Code: run /reload-skills (a skill added mid-session is not listed until you do)'
  return 'Codex/Cursor/agents: restart the agent (or reopen the workspace) to pick up the new skill'
}

export interface SkillsInstallResult {
  ok: boolean
  dryRun: boolean
  files: number
  targets: Array<{ name: string; dir: string; written: number; skipped: number }>
  reload: string
}

export interface InstallOptions {
  root: string
  projectDir: string
  target: string
  force: boolean
  dryRun: boolean
}

/** Copy the skill into the project for the chosen host(s). No prompts; a conflict is an error. */
export function installSkills(opts: InstallOptions): SkillsInstallResult {
  const targets = installTargets(opts.target, opts.projectDir)
  const files = skillFiles(opts.root)
  if (files.length === 0) {
    throw new CliError('skills.missing', `this package ships no skill files (${skillsDir(opts.root)} is empty)`, {
      next: 'Reinstall ezo-watcher (npm i -g ezo-watcher); the skill ships with the package.'
    })
  }
  const results: SkillsInstallResult['targets'] = []
  for (const t of targets) {
    let written = 0
    let skipped = 0
    for (const rel of files) {
      const dest = join(t.dir, rel)
      if (existsSync(dest) && !opts.force) {
        const same = readFileSync(dest, 'utf8') === readFileSync(join(skillsDir(opts.root), rel), 'utf8')
        if (same) {
          skipped += 1
          continue
        }
        throw new CliError('skills.exists', `${dest} exists with different content`, {
          next: 'Re-run with --force to replace it, or move the existing skill aside.'
        })
      }
      if (!opts.dryRun) {
        mkdirSync(dirname(dest), { recursive: true })
        copyFileSync(join(skillsDir(opts.root), rel), dest)
      }
      written += 1
    }
    results.push({ name: t.name, dir: t.dir, written, skipped })
  }
  return { ok: true, dryRun: opts.dryRun, files: files.length, targets: results, reload: reloadStep(targets) }
}

export async function runSkills(args: ParsedArgs, out: Output): Promise<number> {
  // WATCHER_SKILLS_ROOT lets a packaging test point the reader at a fixture package; unset in use.
  const root = process.env.WATCHER_SKILLS_ROOT ?? packageRoot()
  if (args.sub !== 'install') {
    const topic = args.positionals[0]
    if (topic === undefined) {
      const topics = listTopics(root)
      out.json({ ok: true, topics, dir: skillsDir(root), documented: DOCUMENTED_TOPICS, reload: 'watcher skills install --target claude' })
      out.line(out.bold('watcher skills') + '  agent docs shipped with the CLI')
      out.line('')
      if (topics.length === 0) {
        out.line(out.warn(`no skill files in ${skillsDir(root)}`))
        out.line(`The documented topics are: ${DOCUMENTED_TOPICS.join(', ')}`)
      } else {
        for (const t of topics) out.line(`  ${t}`)
      }
      out.line('')
      out.line('print one:  watcher skills <topic>')
      out.line('install:    watcher skills install --target claude|codex|cursor|agents|all [--dir .] [--force]')
      return 0
    }
    const text = readTopic(topic, root)
    out.json({ ok: true, topic, markdown: text })
    if (out.format === 'table') process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
    else out.md(text)
    return 0
  }

  const project = resolveProject(args.dir)
  const result = installSkills({
    root,
    projectDir: project.dir,
    target: flagValue(args, 'target') ?? 'claude',
    force: args.switches.get('force') === true,
    dryRun: args.dryRun
  })
  out.json(result)
  out.line(`${out.ok(args.dryRun ? 'would install' : 'installed')} ezo-watcher skill (${result.files} files)`)
  for (const r of result.targets) out.line(`  ${r.name}: ${r.dir} (${r.written} written, ${r.skipped} unchanged)`)
  out.line('')
  out.line(result.reload)
  return 0
}

/** Prompt-free copy: kept for the skill's own tests. */
export function copySkillFile(root: string, dest: string, rel: string): void {
  mkdirSync(dirname(dest), { recursive: true })
  writeFileAtomic(dest, readFileSync(join(skillsDir(root), rel), 'utf8'))
}
