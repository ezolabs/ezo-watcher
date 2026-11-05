// The global git install (the documented latest-main path beside `npm i -g ezo-watcher`) is its own install path,
// and on npm 11.20 it was broken for every package with a build script: the git dependency is reified as a symlink to
// the clone npm keeps under its cache, npm deletes that clone when the install ends, and
// `<prefix>/lib/node_modules/<name>` plus `<prefix>/bin/<name>` are left dangling. The `--install-links` in the
// documented git command is what makes npm pack the prepared clone instead, so this test pins the documented recipe
// rather than any private helper: a fixture package (bin + `files` + a `prepare` script) is served from a local bare
// git repository, installed with the exact npm flags install.md gives, and the result must be a real package
// directory whose bin runs and whose prepare output shipped. A regression to the symlink fails here, not in a user's
// terminal.
//
// It needs git and npm and nothing else: no registry dependency, so the install is a local clone, a `prepare` run,
// a pack and an extract. The docs half of the file keeps the flag from being "cleaned up" out of any git install
// line, because a flag a doc drops is a broken install that no code test would notice, and keeps the registry
// one-liner the primary install on every copy surface.
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { rmTemp, tempDir } from '../cli/helpers.ts'

const ROOT = resolve(import.meta.dirname, '../..')
const NAME = 'git-install-fixture'
const dirs: string[] = []

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

/** A child environment with npm's inherited config removed: the install must read only the flags the command names. */
function installEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase().startsWith('npm_config_')) continue
    if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) continue
    env[key] = value
  }
  return { ...env, CI: '1', npm_config_yes: 'true', GIT_TERMINAL_PROMPT: '0' }
}

function run(command: string, args: string[], cwd: string, env = installEnv()): Run {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** A minimal package with a build script, committed and served as a bare repository: the shape npm 11 mis-installs. */
function fixtureRepo(): string {
  const root = tempDir('git-install')
  dirs.push(root)
  const pkg = join(root, 'pkg')
  mkdirSync(join(pkg, 'bin'), { recursive: true })
  writeFileSync(join(pkg, 'bin', 'cli.mjs'), '#!/usr/bin/env node\nprocess.stdout.write("fixture cli ok\\n")\n')
  writeFileSync(
    join(pkg, 'prepare.mjs'),
    'import { mkdirSync, writeFileSync } from "node:fs"\nmkdirSync("dist", { recursive: true })\nwriteFileSync("dist/built.txt", "built\\n")\n'
  )
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({
    name: NAME,
    version: '0.1.0',
    type: 'module',
    bin: { [NAME]: 'bin/cli.mjs' },
    files: ['bin/', 'dist/'],
    scripts: { prepare: 'node prepare.mjs' }
  }, null, 2) + '\n')
  for (const args of [
    ['init', '-q'],
    ['add', '-A'],
    ['-c', 'user.email=git-install@example.invalid', '-c', 'user.name=git-install', 'commit', '-qm', 'fixture']
  ]) {
    const r = run('git', args, pkg)
    if (r.status !== 0) return ''
  }
  const bare = join(root, 'repo.git')
  return run('git', ['clone', '-q', '--bare', pkg, bare], root).status === 0 ? bare : ''
}

function toolAvailable(command: string): boolean {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0
}

const TOOLS = toolAvailable('git') && toolAvailable('npm')

afterEach(() => {
  for (const dir of dirs.splice(0)) rmTemp(dir)
})

describe('the documented global git install', () => {
  it.skipIf(!TOOLS)('installs a real package directory whose bin runs, not a symlink into npm\'s cache', { timeout: 240_000 }, () => {
    const bare = fixtureRepo()
    expect(bare, 'the fixture repo could not be created').not.toBe('')
    const work = tempDir('git-install-prefix')
    dirs.push(work)
    const prefix = join(work, 'prefix')
    const cache = join(work, 'cache')
    const install = run('npm', [
      'install', '--global', '--install-links', '--prefix', prefix, '--cache', cache,
      '--no-audit', '--no-fund', `git+file://${bare}`
    ], work)
    expect(install.status, `npm install failed: ${install.stderr.trim()}`).toBe(0)

    const dir = join(prefix, 'lib', 'node_modules', NAME)
    const stat = lstatSync(dir)
    expect(stat.isSymbolicLink(), `the package is a symlink to ${stat.isSymbolicLink() ? readlinkSync(dir) : ''}`).toBe(false)
    expect(stat.isDirectory()).toBe(true)
    // The prepare script's output must be in the installed tree: the pack has to include it, or the CLI would run
    // against a package whose build never shipped.
    expect(existsSync(join(dir, 'dist', 'built.txt'))).toBe(true)

    const bin = join(prefix, 'bin', NAME)
    expect(existsSync(bin), `the installed bin is missing or dangling: ${bin}`).toBe(true)
    const ran = run(process.execPath, [bin], work)
    expect(ran.stdout.trim()).toBe('fixture cli ok')
    expect(ran.status).toBe(0)
  })
})

describe('the documented install lines', () => {
  // llms.txt carries the same one-liner in the package index, docs/doctor-codes.md describes the installed package,
  // and bin/watcher.mjs prints the reinstall line when a git install dangles: all are copy surfaces, so all are
  // checked here with the rest.
  const DOCS = ['README.md', 'AGENTS.md', 'skills/ezo-watcher/SKILL.md', 'skills/ezo-watcher/references/install.md', 'llms.txt', 'docs/doctor-codes.md', 'bin/watcher.mjs']
  // The surfaces an agent copies its first install from: each must lead with the registry one-liner.
  const PRIMARY = ['README.md', 'skills/ezo-watcher/SKILL.md', 'skills/ezo-watcher/references/install.md', 'llms.txt']

  it('every documented global git install passes --install-links', () => {
    const offenders: string[] = []
    let found = 0
    for (const file of DOCS) {
      const text = readFileSync(join(ROOT, file), 'utf8')
      text.split('\n').forEach((line, i) => {
        if (!/npm i -g\b.*github:ezolabs\/ezo-watcher/.test(line)) return
        found++
        if (!line.includes('--install-links')) offenders.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    // install.md's latest-main block and bin/watcher.mjs's two reinstall hints.
    expect(found, 'no documented git install line was found: the extractor or the docs moved').toBeGreaterThanOrEqual(3)
    expect(offenders.join('\n')).toBe('')
  })

  it('every primary surface installs the npm package, and none says it is unpublished', () => {
    const missing: string[] = []
    for (const file of PRIMARY) {
      const text = readFileSync(join(ROOT, file), 'utf8')
      if (!/npm i -g ezo-watcher(?![\w-])/.test(text)) missing.push(file)
    }
    expect(missing.join('\n'), 'a primary surface lost `npm i -g ezo-watcher`').toBe('')
    const stale: string[] = []
    for (const file of DOCS) {
      const text = readFileSync(join(ROOT, file), 'utf8')
      text.split('\n').forEach((line, i) => {
        if (/not (?:yet )?on npm/i.test(line)) stale.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(stale.join('\n')).toBe('')
  })
})
