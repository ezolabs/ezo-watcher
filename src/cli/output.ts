// Rendering for the `watcher` CLI. Three formats, one of which every read verb answers in:
// `json` (the machine contract an agent parses), `md` (a report a person reads) and `table`
// (what a terminal shows by default). The format is picked once, in main.ts, and never guessed
// per line: a command builds values and lets this module lay them out.
//
// Colour is one accent (green for a passing/healthy reading) and the severity words themselves
// (red page, amber warning) as the only other hue, exactly the wall's rule that hue is the data
// channel and not chrome. It is off when stdout is not a TTY, when NO_COLOR is set (any non-empty
// value), when TERM=dumb, or with --no-color; FORCE_COLOR overrides the first three. That is the
// design-cli capability order, not an invention of this file.

export type OutputFormat = 'json' | 'md' | 'table'

const ESC = '\u001b['

function ansiEnabled(stream: NodeJS.WriteStream): boolean {
  const env = process.env
  if (Object.hasOwn(env, 'FORCE_COLOR') && env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  if (env.TERM === 'dumb') return false
  return stream.isTTY === true
}

export class Output {
  readonly format: OutputFormat
  private readonly stdout: NodeJS.WriteStream
  private readonly stderr: NodeJS.WriteStream
  private readonly colour: boolean
  /** Set once a JSON document has been printed, so main.ts can refuse to append anything after it. */
  jsonPrinted = false

  constructor(format: OutputFormat, stdout: NodeJS.WriteStream = process.stdout, stderr: NodeJS.WriteStream = process.stderr, colour?: boolean) {
    this.format = format
    this.stdout = stdout
    this.stderr = stderr
    this.colour = colour ?? ansiEnabled(stdout)
  }

  private paint(code: string, text: string): string {
    return this.colour ? `${ESC}${code}m${text}${ESC}0m` : text
  }

  bold(text: string): string {
    return this.paint('1', text)
  }

  dim(text: string): string {
    return this.paint('2', text)
  }

  ok(text: string): string {
    return this.paint('32', text)
  }

  warn(text: string): string {
    return this.paint('33', text)
  }

  bad(text: string): string {
    return this.paint('31', text)
  }

  /** A severity word painted by the tier it names (the wall's data channel). */
  severity(sev: string): string {
    if (sev === 'page') return this.paint('31;1', sev)
    if (sev === 'warning') return this.paint('33', sev)
    return this.paint('36', sev)
  }

  /** One line of plain text in table mode; nothing in json mode (a JSON document is the whole answer). */
  line(text = ''): void {
    if (this.format === 'table') this.stdout.write(`${text}\n`)
  }

  /** A markdown line in md mode; nothing otherwise. */
  md(text = ''): void {
    if (this.format === 'md') this.stdout.write(`${text}\n`)
  }

  /** The JSON document. Only emitted in json mode; in other modes the caller renders the same values for humans. */
  json(value: unknown): void {
    if (this.format !== 'json') return
    this.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    this.jsonPrinted = true
  }

  /**
   * A table in table mode. `columns` fixes order and labels, so the same values render the same way
   * in every command; a value wider than its column wraps nothing and is clipped to keep the row
   * readable (the full value is in --json).
   */
  table(rows: Array<Record<string, string>>, columns: Array<{ key: string; label: string; max?: number }>): void {
    if (this.format !== 'table') return
    if (rows.length === 0) {
      this.line(this.dim('(nothing)'))
      return
    }
    const width = columns.map((c) => Math.max(c.label.length, ...rows.map((r) => clip(String(r[c.key] ?? ''), c.max ?? 60).length)))
    const header = columns.map((c, i) => pad(c.label, width[i])).join('  ')
    this.line(this.bold(header))
    this.line(this.dim(columns.map((_, i) => '-'.repeat(width[i])).join('  ')))
    for (const row of rows) {
      this.line(columns.map((c, i) => pad(clip(String(row[c.key] ?? ''), c.max ?? 60), width[i])).join('  '))
    }
  }

  /** A heading plus aligned key/value rows, in table mode. */
  section(title: string): void {
    if (this.format !== 'table') return
    if (this.stdout.isTTY !== false) this.stdout.write('\n')
    this.line(this.bold(title))
  }

  /** An error, in the format the caller asked for. JSON errors go to stdout as one document: `{ok:false,error:{...}}`. */
  error(error: { code: string; message: string; next?: string }): void {
    if (this.format === 'json') {
      this.stdout.write(`${JSON.stringify({ ok: false, error }, null, 2)}\n`)
      this.jsonPrinted = true
      return
    }
    const lines = [`${this.bad('error')} ${this.bold(error.code)}: ${error.message}`]
    if (error.next) lines.push(`  next: ${error.next}`)
    this.stderr.write(`${lines.join('\n')}\n`)
  }

  /** One informational line to stderr, so `--json` stdout stays one parseable document. */
  note(text: string): void {
    if (this.format === 'json') return
    this.stderr.write(`${text}\n`)
  }
}

/** Cut a value to `max` characters with an ellipsis, so a table row never runs off the screen. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

/** The MD table of the same rows, for `--output md`. */
export function markdownTable(rows: Array<Record<string, string>>, columns: Array<{ key: string; label: string }>): string {
  const head = `| ${columns.map((c) => c.label).join(' | ')} |`
  const rule = `| ${columns.map(() => '---').join(' | ')} |`
  const body = rows.map((r) => `| ${columns.map((c) => String(r[c.key] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`)
  return [head, rule, ...body].join('\n')
}

/** A human age from an ISO timestamp, for the read verbs: "3m", "2h", "4d". */
export function ageOf(iso: string | null, now = Date.now()): string {
  if (!iso) return '-'
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return '-'
  const sec = Math.max(0, Math.round((now - at) / 1000))
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h`
  return `${Math.floor(sec / 86_400)}d`
}
