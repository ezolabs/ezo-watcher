// `watcher scan`: the deterministic half of discovery. It reads a project, proposes signals with
// evidence, and prints the `watcher add` commands that would watch them. It NEVER writes config:
// the agent judges, then runs `add`. Exit 0 even when it finds nothing (an empty answer is an
// answer); the facts carry `capHit` so a partial scan says it is partial.
//
// `--output md` is the human report; `--output json` is the machine contract:
//   {project, facts, signals:[{id, kind, evidence:[{file,line}], suggests:{kind,args},
//    confidence, needs, assertion?}], suggestedCommands:["watcher add ..."]}

import type { ParsedArgs } from './util.ts'
import { numberFlag } from './util.ts'
import type { Output } from './output.ts'
import { markdownTable } from './output.ts'
import { resolveProject } from './project.ts'
import { scanProject } from './signals/detect.ts'
import type { ScanSignal } from './signals/detect.ts'

export const SCAN_SPEC = {
  valueFlags: ['dir', 'output', 'max-files'],
  switchFlags: ['help', 'dry-run']
} as const

export async function runScan(args: ParsedArgs, out: Output): Promise<number> {
  const project = resolveProject(args.dir)
  const maxFiles = numberFlag(args, 'max-files', { min: 50, max: 20_000 })
  const result = scanProject(project.dir, { ...(maxFiles !== undefined ? { maxFiles } : {}) })
  out.json(result)

  const byKind = new Map<string, ScanSignal[]>()
  for (const s of result.signals) {
    const list = byKind.get(s.kind) ?? []
    list.push(s)
    byKind.set(s.kind, list)
  }

  out.line(`${out.bold('scan')} ${result.project}`)
  out.line(`${result.facts.fileCount} files${result.facts.capHit ? out.warn(' (cap reached: partial scan)') : ''}, ${result.signals.length} signals, ${result.suggestedCommands.length} runnable commands`)
  if (result.facts.notes.length > 0) {
    for (const n of result.facts.notes.slice(0, 6)) out.line(`  ${out.dim('note')} ${n.file}: ${n.what}`)
  }
  for (const [kind, list] of [...byKind].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.section(`${kind} (${list.length})`)
    out.table(
      list.map((s) => {
        const ev = s.evidence[0]
        return {
          id: s.id,
          confidence: s.confidence,
          needs: s.needs,
          evidence: ev ? `${ev.file}${ev.line ? `:${ev.line}` : ''}` : '',
          note: s.note ?? '',
          command: result.suggestedCommands.includes(suggestsCommand(s)) ? suggestsCommand(s) : '(agent judgement)'
        }
      }),
      [
        { key: 'id', label: 'signal', max: 10 },
        { key: 'confidence', label: 'conf', max: 6 },
        { key: 'needs', label: 'needs', max: 10 },
        { key: 'evidence', label: 'evidence', max: 34 },
        { key: 'note', label: 'what', max: 46 },
        { key: 'command', label: 'command', max: 50 }
      ]
    )
  }

  out.md(`# Telemetry scan: ${result.project}`)
  out.md('')
  out.md(`${result.facts.fileCount} files scanned${result.facts.capHit ? ' (cap reached: partial)' : ''}; ${result.signals.length} signals; ${result.suggestedCommands.length} suggested commands.`)
  out.md('')
  if (result.facts.notes.length > 0) {
    out.md('## Notes')
    for (const n of result.facts.notes) out.md(`- ${n.file}: ${n.what}`)
    out.md('')
  }
  for (const [kind, list] of [...byKind].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.md(`## ${kind} (${list.length})`)
    out.md('')
    out.md(markdownTable(list.map((s) => {
      const ev = s.evidence[0]
      return {
        signal: s.id,
        confidence: s.confidence,
        needs: s.needs,
        evidence: ev ? `${ev.file}${ev.line ? `:${ev.line}` : ''}` : '',
        note: s.note ?? ''
      }
    }), [
      { key: 'signal', label: 'signal' },
      { key: 'confidence', label: 'confidence' },
      { key: 'needs', label: 'needs' },
      { key: 'evidence', label: 'evidence' },
      { key: 'note', label: 'what' }
    ]))
    out.md('')
  }
  if (result.suggestedCommands.length > 0) {
    out.md('## Suggested commands')
    out.md('')
    out.md('```')
    for (const c of result.suggestedCommands) out.md(c)
    out.md('```')
    out.md('')
  }
  out.md('The scan proposes; it never writes. Run a command above (or `watcher add ... --help`), then `watcher doctor --live --prove`.')
  return 0
}

/** The command a signal carries, rebuilt without running the shell-quoter (for the table column). */
function suggestsCommand(signal: ScanSignal): string {
  const args = signal.suggests.args
  const parts = [`watcher add ${signal.suggests.kind}`]
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === '') continue
    const text = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : JSON.stringify(v)
    parts.push(`--${k}`, /^[A-Za-z0-9_./:=@%+,~-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`)
  }
  return parts.join(' ')
}
