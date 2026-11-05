// The bounded walk behind `watcher scan`.
//
// One pass over the project, capped at `maxFiles`, with the lessons the #10 proof measured:
//   - files of a directory are taken BEFORE its subdirectories, so a 100k-file `data/` directory
//     cannot starve package.json (PostHog's MAX_TREE_FILES failure mode);
//   - subdirectories are visited in a priority order (src, server, app, lib, config, deploy, ...);
//   - symlinks are never followed;
//   - build/vendor/test noise is skipped by name;
//   - the cap is reported as `capHit`, so a partial scan says it is partial.
// Read-only: nothing here opens a file for writing.

import { lstatSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'target', 'vendor',
  '.venv', 'venv', '__pycache__', '.cache', 'out', '.turbo', '.output', '.astro',
  '.svelte-kit', '.parcel-cache', '.terraform', '.serverless', 'Pods', '.expo'
])

const DIR_PRIORITY = ['src', 'server', 'app', 'lib', 'cmd', 'internal', 'config', 'deploy', 'scripts', 'bin', '.github', 'ops', 'infra', 'k8s', 'workflows']

/** A dot-directory is scratch unless it is `.github` (workflows are production signal). */
export function skipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || (name.startsWith('.') && name !== '.github')
}

export interface WalkResult {
  /** Paths relative to the root, as the rest of the scan reports them. */
  files: string[]
  /** True when the cap stopped the walk: the scan saw only part of the tree. */
  capHit: boolean
  /** True when the depth limit stopped a branch. */
  depthHit: boolean
}

export function walkProject(root: string, opts: { maxFiles?: number; maxDepth?: number } = {}): WalkResult {
  const maxFiles = opts.maxFiles ?? 4000
  const maxDepth = opts.maxDepth ?? 12
  const files: string[] = []
  let depthHit = false

  const walk = (dir: string, depth: number): void => {
    if (files.length >= maxFiles) return
    if (depth > maxDepth) {
      depthHit = true
      return
    }
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    const dirs: string[] = []
    const plain: string[] = []
    for (const name of entries) {
      const p = join(dir, name)
      let st
      try {
        st = lstatSync(p)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        if (!skipDir(name)) dirs.push(name)
        continue
      }
      if (st.isFile()) plain.push(name)
    }
    // Files first: a huge data/ subdirectory must not starve the manifest beside it.
    for (const name of plain.sort()) {
      if (files.length < maxFiles) files.push(relative(root, join(dir, name)))
    }
    dirs.sort((a, b) => {
      const ra = DIR_PRIORITY.indexOf(a)
      const rb = DIR_PRIORITY.indexOf(b)
      return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || a.localeCompare(b)
    })
    for (const name of dirs) walk(join(dir, name), depth + 1)
  }

  walk(root, 0)
  return { files, capHit: files.length >= maxFiles, depthHit }
}
