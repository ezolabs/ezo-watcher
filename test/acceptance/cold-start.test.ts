// Both install modes (--from-tarball and --from-git) need a work directory under the repository's ignored `.tmp/`
// before the transcript starts. A fresh clone or a tarball export has no `.tmp/`, and `mkdtempSync(join(ROOT,
// '.tmp', …))` died with ENOENT there; CI never saw it because its git lane clones a mirror into `.tmp/` first.
// This test builds the fresh-checkout shape — the runner's own files and a package.json, no `.tmp/` — and runs
// `--from-git` with a spec that cannot install: the run must reach that install's FAIL line and leave `.tmp/`
// behind, not die before its first check with the cold-start ENOENT.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { rmTemp, tempDir } from '../cli/helpers.ts'

const ROOT = resolve(import.meta.dirname, '../..')

function toolAvailable(command: string): boolean {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0
}

const TOOLS = toolAvailable('git') && toolAvailable('npm')

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmTemp(dir)
})

describe('the acceptance runner on a fresh checkout', () => {
  it.skipIf(!TOOLS)('creates .tmp/ before the --from-git work directory instead of dying with ENOENT', { timeout: 60_000 }, () => {
    // The shape of a fresh clone: only the transcript's own files, and no .tmp/.
    const root = tempDir('acceptance-cold-start')
    dirs.push(root)
    mkdirSync(join(root, 'test', 'acceptance'), { recursive: true })
    for (const file of ['run.mjs', 'lib.mjs', 'negative.mjs']) {
      cpSync(join(ROOT, 'test', 'acceptance', file), join(root, 'test', 'acceptance', file))
    }
    writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'cold-start-fixture', version: '0.0.0', type: 'module' })}\n`)
    expect(existsSync(join(root, '.tmp')), 'the fixture tree is not a fresh checkout: it has a .tmp/').toBe(false)

    // A spec that cannot install, so the run stops at the install instead of spending a minute on the transcript.
    // `pathToFileURL` keeps the spec valid when the temp path has spaces.
    const spec = `git+${pathToFileURL(join(root, 'missing.git')).href}`
    const result = spawnSync(process.execPath, [join(root, 'test', 'acceptance', 'run.mjs'), '--from-git', spec], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CI: '1', GIT_TERMINAL_PROMPT: '0' }
    })

    // On a cold start the mkdtemp throws an uncaught ENOENT on stderr, before any PASS/FAIL line.
    expect(result.stderr).not.toMatch(/mkdtemp|ENOENT/)
    expect(result.stdout).not.toMatch(/mkdtemp/)
    expect(result.stdout).toContain('FAIL  the git spec installs into a temp prefix')
    expect(result.stdout).toContain('acceptance: 0 passed, 1 failed')
    expect(result.status).toBe(1)
    expect(existsSync(join(root, '.tmp')), 'the run did not create .tmp/ before its work directory').toBe(true)
  })
})
