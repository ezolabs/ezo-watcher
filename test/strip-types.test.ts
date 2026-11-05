// The `watcher` bin runs src/cli/main.ts directly when a checkout has no dist/, and `watcher run` then imports
// src/server/main.ts; Node's own type stripping is the loader, so one enum, namespace or constructor parameter property on
// that graph is a runtime SyntaxError for a user who installed from git without a build. AGENTS.md states the rule; this
// test keeps it true. It checks src/ against Node's stripTypeScriptTypes (the parser the loader uses, node:module since
// 22.13) rather than a hand-written regex, so the files are judged by the real strip-only grammar.
//
// The guard proves itself below: every construct the strip-only loader rejects must come back as a defect at the right
// line, and the erasable syntax src/ does use must pass. A guard that flagged nothing, or everything, is worse than none.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as nodeModule from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SRC = join(ROOT, 'src')

// A namespace import, not the named one: Node before 22.13 lacks the export, and a missing named import fails the whole
// file at load time instead of leaving the suite to skip.
const stripTypeScriptTypes = nodeModule.stripTypeScriptTypes
const canStrip = typeof stripTypeScriptTypes === 'function'

interface Defect {
  file: string
  line: number | null
  code: string
  message: string
}

function display(file: string): string {
  return relative(ROOT, file).split(sep).join('/')
}

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(path))
    else if (entry.name.endsWith('.ts')) found.push(path)
  }
  return found.sort()
}

// A strip error's first stack line is its location, `<sourceUrl>:<line>`, followed by the offending source and a caret
// line. sourceUrl is the label passed below, so the prefix is compared against it rather than regexp-escaped; an older
// build that prints only `:<line>` (empty prefix) still matches. If the shape moves, the line above the caret is the
// offending source, and a unique match for it in the file gives the same answer.
function lineOf(stack: string | undefined, source: string, label: string): number | null {
  const lines = (stack ?? '').split('\n')
  const located = /^(.*):(\d+)$/.exec(lines[0] ?? '')
  if (located && (located[1] === label || located[1] === '')) return Number(located[2])
  const caret = lines.findIndex((line) => /^\s*\^+\s*$/.test(line))
  const snippet = caret > 0 ? lines[caret - 1] : undefined
  if (snippet !== undefined) {
    const hits = source.split('\n').flatMap((text, index) => (text === snippet ? [index + 1] : []))
    if (hits.length === 1) return hits[0]
  }
  return null
}

function stripDefect(source: string, label: string): Defect | null {
  if (typeof stripTypeScriptTypes !== 'function') return null
  try {
    stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: label })
    return null
  } catch (error) {
    const record = error as { code?: unknown; message?: unknown; stack?: unknown }
    return {
      file: label,
      line: lineOf(typeof record.stack === 'string' ? record.stack : undefined, source, label),
      code: typeof record.code === 'string' ? record.code : error instanceof Error ? error.name : 'Error',
      message: typeof record.message === 'string' ? record.message : String(error)
    }
  }
}

function describeDefect(defect: Defect): string {
  const where = defect.line === null ? defect.file : `${defect.file}:${defect.line}`
  return `${where} ${defect.code}: ${defect.message}`
}

function defectsIn(dir: string, label: (file: string) => string): string[] {
  return sourceFiles(dir).flatMap((file) => {
    const defect = stripDefect(readFileSync(file, 'utf8'), label(file))
    return defect ? [describeDefect(defect)] : []
  })
}

const STRIPPED_ONLY = [
  {
    construct: 'constructor parameter property',
    source: 'const ready = true\n\nexport class Sample {\n  constructor(private readonly id: number) {}\n}\n',
    line: 4,
    phrase: 'parameter property'
  },
  {
    construct: 'enum',
    source: 'const ready = true\n\nexport enum Color {\n  Red,\n  Green\n}\n',
    line: 3,
    phrase: 'enum'
  },
  {
    construct: 'namespace',
    source: 'const ready = true\n\nexport namespace Util {\n  export const value = 1\n}\n',
    line: 3,
    phrase: 'namespace'
  }
]

describe.skipIf(!canStrip)('strip-types guard', () => {
  it('strips every TypeScript file under src/ with the strip-only loader', () => {
    const files = sourceFiles(SRC)
    // The bin falls back to these two from source, so the walk must reach them and there must be something to walk.
    expect(files.length).toBeGreaterThan(0)
    expect(files.map(display)).toEqual(expect.arrayContaining(['src/cli/main.ts', 'src/server/main.ts']))
    expect(defectsIn(SRC, display)).toEqual([])
  })

  it('reports a planted defect with its path and line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'strip-types-'))
    try {
      mkdirSync(join(dir, 'nested'))
      writeFileSync(join(dir, 'nested', 'bad.ts'), 'const ready = true\n\nexport enum Color { Red }\n')
      const defects = defectsIn(dir, (file) => relative(dir, file).split(sep).join('/'))
      expect(defects).toHaveLength(1)
      expect(defects[0]).toContain('nested/bad.ts:3')
      expect(defects[0]).toContain('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  for (const { construct, source, line, phrase } of STRIPPED_ONLY) {
    it(`flags a ${construct} at its source line`, () => {
      const defect = stripDefect(source, 'sample.ts')
      expect(defect, `a ${construct} must not pass the strip-only guard`).not.toBeNull()
      expect(defect?.code).toBe('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX')
      expect(defect?.line).toBe(line)
      expect(defect?.message).toContain(phrase)
    })
  }

  it('accepts the erasable syntax src/ is allowed to use', () => {
    const source = [
      "import type { Dirent } from 'node:fs'",
      '',
      'interface Row { id: string }',
      'type Kind = "alert" | "silence"',
      'const id = "row" as string',
      'export class Sample {',
      '  private readonly id: number',
      '  constructor(id: number) { this.id = id }',
      '}',
      'export function pick(row: Row): Kind { return row.id ? "alert" : "silence" }',
      ''
    ].join('\n')
    expect(stripDefect(source, 'sample.ts')).toBeNull()
  })
})
