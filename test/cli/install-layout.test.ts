// The bin's layout rule: an installed package (node_modules/) runs dist/cli/main.mjs, because Node
// refuses to strip TypeScript under node_modules; a checkout without a build runs src/cli/main.ts
// under native type stripping. These tests copy bin/watcher.mjs into a fake package root and put a
// marker CLI at each location, so the assertion is about resolution, not about either CLI's behaviour.
import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { rmTemp, tempDir } from './helpers.ts'

const BIN = fileURLToPath(new URL('../../bin/watcher.mjs', import.meta.url))
const dirs: string[] = []

function layout(): string {
  const root = tempDir('install-layout')
  dirs.push(root)
  mkdirSync(join(root, 'bin'), { recursive: true })
  cpSync(BIN, join(root, 'bin', 'watcher.mjs'))
  return root
}

/** A CLI module that says which layout it was loaded from, then exits 0. */
function markerCli(path: string, marker: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `export async function main() {\n  process.stdout.write(${JSON.stringify(`${marker}\n`)})\n  return 0\n}\n`)
}

function runBin(root: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [join(root, 'bin', 'watcher.mjs'), '--version'], { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmTemp(dir)
})

describe('bin/watcher.mjs install layout', () => {
  it('runs dist/cli/main.mjs when the package ships a build, even with src/ beside it', () => {
    // The tarball ships both dist/ and src/; the installed bin must pick dist/ (node_modules cannot strip types).
    const root = layout()
    markerCli(join(root, 'dist', 'cli', 'main.mjs'), 'dist')
    markerCli(join(root, 'src', 'cli', 'main.ts'), 'src')
    markerCli(join(root, 'src', 'server', 'main.ts'), 'server')
    const r = runBin(root)
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('dist')
  })

  it('runs src/cli/main.ts when there is no build (a checkout)', () => {
    const root = layout()
    markerCli(join(root, 'src', 'cli', 'main.ts'), 'src')
    markerCli(join(root, 'src', 'server', 'main.ts'), 'server')
    const r = runBin(root)
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('src')
  })

  it('names the missing CLI when neither layout is present', () => {
    const root = layout()
    const r = runBin(root)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(join(root, 'src', 'cli', 'main.ts'))
    expect(r.stderr).toContain('reinstall the package')
  })
})
