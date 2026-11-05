import { describe, expect, it, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SKILLS_SPEC, installSkills, listTopics, readTopic, runSkills } from '../../src/cli/skills.ts'
import { EnvGuard, WATCHER_KEYS, capture, parse, rmTemp, tempDir } from './helpers.ts'

const dirs: string[] = []
const guards: Array<() => void> = []

function temp(prefix: string): string {
  const dir = tempDir(prefix)
  dirs.push(dir)
  return dir
}

function guard(): EnvGuard {
  const g = new EnvGuard(WATCHER_KEYS)
  guards.push(() => g.restore())
  return g
}

const fixtureRoot = fileURLToPath(new URL('./fixtures/skills-pkg', import.meta.url))

afterEach(() => {
  for (const restore of guards.splice(0)) restore()
  for (const dir of dirs.splice(0)) rmTemp(dir)
})

describe('skill files', () => {
  it('lists and reads the topics in the package', () => {
    expect(listTopics(fixtureRoot)).toEqual(['install', 'sources'])
    expect(readTopic('install', fixtureRoot)).toContain('# Install')
    expect(() => readTopic('../secrets', fixtureRoot)).toThrowError(expect.objectContaining({ code: 'skills.bad-topic' }))
    expect(() => readTopic('cloudflare', fixtureRoot)).toThrowError(expect.objectContaining({ code: 'skills.topic-missing' }))
  })
})

describe('watcher skills install', () => {
  it('copies the skill and its references into .claude/skills/ezo-watcher and prints the reload step', () => {
    const project = temp('skills-claude')
    const result = installSkills({ root: fixtureRoot, projectDir: project, target: 'claude', force: false, dryRun: false })
    expect(result.files).toBe(3)
    const dest = join(project, '.claude', 'skills', 'ezo-watcher')
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(dest, 'references', 'install.md'))).toBe(true)
    expect(readFileSync(join(dest, 'references', 'sources.md'), 'utf8')).toContain('watcher add')
    expect(result.reload).toContain('/reload-skills')
  })

  it('writes .agents for codex/cursor/agents and both for all', () => {
    const project = temp('skills-agents')
    const codex = installSkills({ root: fixtureRoot, projectDir: project, target: 'codex', force: false, dryRun: false })
    expect(codex.targets.map((t) => t.name)).toEqual(['agents'])
    expect(existsSync(join(project, '.agents', 'skills', 'ezo-watcher', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(project, '.claude'))).toBe(false)
    const all = installSkills({ root: fixtureRoot, projectDir: project, target: 'all', force: false, dryRun: false })
    expect(all.targets.map((t) => t.name).sort()).toEqual(['agents', 'claude'])
    expect(all.reload).toContain('/reload-skills')
  })

  it('refuses to overwrite a different file without --force, and replaces it with --force', () => {
    const project = temp('skills-force')
    installSkills({ root: fixtureRoot, projectDir: project, target: 'claude', force: false, dryRun: false })
    const dest = join(project, '.claude', 'skills', 'ezo-watcher', 'SKILL.md')
    writeFileSync(dest, 'hand edited\n')
    expect(() => installSkills({ root: fixtureRoot, projectDir: project, target: 'claude', force: false, dryRun: false })).toThrowError(expect.objectContaining({ code: 'skills.exists' }))
    installSkills({ root: fixtureRoot, projectDir: project, target: 'claude', force: true, dryRun: false })
    expect(readFileSync(dest, 'utf8')).toContain('EZO Watcher skill (fixture)')
  })

  it('--dry-run writes nothing', () => {
    const project = temp('skills-dry')
    const result = installSkills({ root: fixtureRoot, projectDir: project, target: 'claude', force: false, dryRun: true })
    expect(result.dryRun).toBe(true)
    expect(existsSync(join(project, '.claude'))).toBe(false)
  })

  it('reports skills.missing when the package ships no skill files', () => {
    const empty = temp('skills-empty')
    mkdirSync(join(empty, 'skills', 'ezo-watcher'), { recursive: true })
    const project = temp('skills-empty-project')
    expect(() => installSkills({ root: empty, projectDir: project, target: 'claude', force: false, dryRun: false })).toThrowError(expect.objectContaining({ code: 'skills.missing' }))
  })

  it('the verb lists the documented topics and the install path works through the CLI root seam', async () => {
    const g = guard()
    const project = temp('skills-verb')
    g.set({ WATCHER_SKILLS_ROOT: fixtureRoot })
    const list = capture('json')
    expect(await runSkills(parse(['skills'], SKILLS_SPEC), list.out)).toBe(0)
    const listed = JSON.parse(list.stdout()) as { topics: string[]; documented: string[] }
    expect(listed.topics).toEqual(['install', 'sources'])
    expect(listed.documented).toContain('cloudflare')

    const printed = capture('table')
    expect(await runSkills(parse(['skills', 'install', '--target', 'claude', '--dir', project], SKILLS_SPEC), printed.out)).toBe(0)
    expect(existsSync(join(project, '.claude', 'skills', 'ezo-watcher', 'SKILL.md'))).toBe(true)
    // The reload step is the last line, so an agent that reads the tail sees it.
    const lines = printed.stdout().trimEnd().split('\n')
    expect(lines[lines.length - 1]).toContain('/reload-skills')
  })
})
