// The `watcher` CLI: one entry point, one verb at a time, no prompts.
//
// The contract (documented in docs/doctor-codes.md and `watcher help`):
//   - exit 0 when the verb succeeded, 1 when a check failed, 64 for a usage mistake;
//   - every read/report verb answers `--output json|md|table` (or `--json`), and an error in json
//     mode is one `{ok:false,error:{code,message,next?}}` document;
//   - `--dry-run` previews a write and changes nothing;
//   - the project state lives in `.watcher/` under the project (or `--dir`), never under $HOME.
//
// How this runs: from a checkout, bin/watcher.mjs imports this file as TypeScript and Node's native
// type stripping executes it (Node 24+; `engines` in package.json), so src/ keeps to the strip-only
// subset (no enums, no parameter properties). An installed package runs the esbuild bundles instead
// (dist/cli/main.mjs and dist/server/main.mjs; Node refuses type stripping under node_modules), which
// is what `npm run build` and the package's prepack produce; Docker runs dist/server/main.mjs too.

import { existsSync } from 'node:fs'
import { CliError, parseArgs, usageError } from './util.ts'
import type { ParsedArgs } from './util.ts'
import type { Output, OutputFormat } from './output.ts'
import { loadProjectEnv } from './run.ts'
import { resolveProject } from './project.ts'
import { INIT_SPEC, runInit } from './init.ts'
import { ADD_SPEC, listChannelTypes, listSourceKinds, kindHelp, runAdd, validateAdd } from './add.ts'
import { RM_SPEC, runRm } from './remove.ts'
import { DOCTOR_SPEC, runDoctorCommand } from './doctor.ts'
import { SCAN_SPEC, runScan } from './scan.ts'
import { RUN_SPEC, STOP_SPEC, runRun, runStop } from './run.ts'
import { SERVICE_SPEC, runService } from './service.ts'
import { INCIDENTS_SPEC, MCP_CONFIG_SPEC, STATUS_SPEC, TEST_ALERT_SPEC, runIncidents, runMcpConfig, runStatus, runTestAlert } from './status.ts'
import { INCIDENT_SPEC, RECHECK_SPEC, runIncident, runRecheck } from './incident.ts'
import { MCP_SPEC, runMcp } from './mcp.ts'
import { HOOKS_SPEC, runHooks } from './hooks.ts'
import { SKILLS_SPEC, runSkills } from './skills.ts'
import { CLOUDFLARE_SPEC, runCloudflare } from './cloudflare.ts'
import { RecordingOutput, TELEMETRY_SPEC, finishCliTelemetry, openCliTelemetry, runTelemetry } from './telemetry.ts'
import { cliVersion } from './project.ts'

interface Verb {
  summary: string
  spec: { valueFlags: readonly string[]; switchFlags?: readonly string[]; subVerbs?: readonly string[] }
  run: (args: ParsedArgs, out: Output) => Promise<number>
  usage: string
}

const VERBS: Record<string, Verb> = {
  init: {
    summary: 'create .watcher/ (config, secrets, .env.example, gitignore) and print a doctor summary',
    spec: INIT_SPEC,
    run: runInit,
    usage: 'watcher init [--dir <project>] [--port <n>] [--host <addr>] [--brand <name>] [--short-name <name>] [--dry-run]'
  },
  add: {
    summary: 'add a source (<kind>) or a channel to .watcher/config.json through the server validator',
    spec: ADD_SPEC,
    run: runAdd,
    usage: 'watcher add <kind> --id <id> [flags] [--optional] [--replace]   |   watcher add channel <type> --id <id> [flags] [--replace]   (watcher add <kind> --help lists that kind\'s flags)'
  },
  rm: {
    summary: 'remove one source or channel by id, and take a removed channel out of every route that named it',
    spec: RM_SPEC,
    run: runRm,
    usage: 'watcher rm <id> [--dir <project>] [--dry-run]'
  },
  doctor: {
    summary: 'check the project in order; --live reads the running server, --prove moves each source reading past its threshold',
    spec: DOCTOR_SPEC,
    run: runDoctorCommand,
    usage: 'watcher doctor [--live] [--prove] [--no-runtime-surface] [--target local|cloudflare] [--hostname <h>] [--output json|md|table]'
  },
  scan: {
    summary: 'deterministic telemetry scan of a project: signals, evidence, suggested watcher add commands',
    spec: SCAN_SPEC,
    run: runScan,
    usage: 'watcher scan [--dir <project>] [--max-files <n>] [--output json|md|table]'
  },
  run: {
    summary: 'run the server in the foreground (or --detach with a pid file and a log)',
    spec: RUN_SPEC,
    run: runRun,
    usage: 'watcher run [--dir <project>] [--port <n>] [--host <addr>] [--detach]'
  },
  stop: {
    summary: 'stop the detached server named by .watcher/data/watcher.pid',
    spec: STOP_SPEC,
    run: runStop,
    usage: 'watcher stop [--dir <project>]'
  },
  service: {
    summary: 'install or uninstall a launchd (macOS) / systemd --user (Linux) service running watcher run',
    spec: SERVICE_SPEC,
    run: runService,
    usage: 'watcher service install [--with-tunnel] [--force]   |   watcher service uninstall'
  },
  status: {
    summary: 'read the running server: counts, sources, channels',
    spec: STATUS_SPEC,
    run: runStatus,
    usage: 'watcher status [--brief] [--url <base>] [--output json|md|table]'
  },
  incidents: {
    summary: 'list firing incidents from the running server',
    spec: INCIDENTS_SPEC,
    run: runIncidents,
    usage: 'watcher incidents [--open] [--all] [--severity page|warning|info] [--service <name>] [--limit <n>] [--output json|md|table]'
  },
  incident: {
    summary: 'one incident, or the fix brief an agent acts on (--fix-context)',
    spec: INCIDENT_SPEC,
    run: runIncident,
    usage: 'watcher incident <key> [--fix-context] [--output json|md|table]'
  },
  recheck: {
    summary: 're-check an incident now, and with --wait, wait for the source to answer',
    spec: RECHECK_SPEC,
    run: runRecheck,
    usage: 'watcher recheck <key> [--wait] [--timeout 60] [--output json|md|table]'
  },
  'test-alert': {
    summary: 'send a test notification through one channel (default: every configured channel)',
    spec: TEST_ALERT_SPEC,
    run: runTestAlert,
    usage: 'watcher test-alert [--channel <id>] [--url <base>]'
  },
  'mcp-config': {
    summary: 'print the exact MCP client config for /mcp, with the bearer token reference',
    spec: MCP_CONFIG_SPEC,
    run: runMcpConfig,
    usage: 'watcher mcp-config --client claude|cursor|codex [--show-secret]'
  },
  mcp: {
    summary: 'run an MCP server over stdio that forwards every tool call to the running Watcher',
    spec: MCP_SPEC,
    run: runMcp,
    usage: 'watcher mcp [--dir <project>] [--url <base>]'
  },
  hooks: {
    summary: 'install or uninstall the SessionStart hook that prints `status --brief` (claude), or the AGENTS.md instruction (codex)',
    spec: HOOKS_SPEC,
    run: runHooks,
    usage: 'watcher hooks install --target claude|codex [--dir <project>] [--dry-run]   |   watcher hooks uninstall [--target claude|codex] [--dir <project>] [--dry-run]'
  },
  skills: {
    summary: 'list/print the agent docs shipped with the CLI, or install them into a project',
    spec: SKILLS_SPEC,
    run: runSkills,
    usage: 'watcher skills [<topic>]   |   watcher skills install --target claude|codex|cursor|agents|all [--dir .] [--force]'
  },
  cloudflare: {
    summary: 'put the Watcher behind Cloudflare: a quick ephemeral tunnel or a hosted tunnel + DNS (+ Access)',
    spec: CLOUDFLARE_SPEC,
    run: runCloudflare,
    usage: 'watcher cloudflare quick [--dry-run]   |   watcher cloudflare tunnel --hostname <h> [--access-email <e>] [--dry-run]'
  },
  telemetry: {
    summary: 'show, enable or disable the anonymous usage telemetry (what it sends: docs/telemetry.md)',
    spec: TELEMETRY_SPEC,
    run: runTelemetry,
    usage: 'watcher telemetry [status|enable|disable] [--dry-run] [--output json|md|table]'
  }
}

/** Every flag the CLI knows can take a value, across all verbs: used to step over a flag's value while looking for the verb. */
const COMMAND_VALUE_FLAGS = new Set<string>(['dir', 'output', ...Object.values(VERBS).flatMap((verb) => [...verb.spec.valueFlags])])

/**
 * The verb, wherever it sits in argv: `watcher --dir x init` and `watcher init --dir x` both name `init`. A global flag may come
 * before the verb, so the first bare word is not necessarily the command. Values of value-taking flags are stepped over.
 */
export function commandWordOf(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') return argv[i + 1]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2)
      if (eq < 0 && COMMAND_VALUE_FLAGS.has(name)) i++
      continue
    }
    if (a.startsWith('-') && a !== '-') continue
    return a
  }
  return undefined
}

export interface ParsedCommand {
  verb: string
  args: ParsedArgs
}

/** The CLI's argument parser, with no side effect: the verb (wherever the flags put it) and its parsed arguments. */
export function parseCommand(argv: string[]): ParsedCommand {
  const command = commandWordOf(argv)
  const verb = command ? VERBS[command] : undefined
  if (!verb) {
    const guessed = command ?? argv[0] ?? ''
    throw usageError('usage.unknown-verb', `unknown verb ${JSON.stringify(guessed)}`, `Run \`watcher help\` for the verbs: ${Object.keys(VERBS).join(', ')}`)
  }
  const args = parseArgs(argv, {
    valueFlags: [...verb.spec.valueFlags],
    switchFlags: [...(verb.spec.switchFlags ?? [])],
    subVerbs: [...(verb.spec.subVerbs ?? [])]
  })
  return { verb: command as string, args }
}

/**
 * Parse AND check the flags a verb cannot run without, for the documented-command test (test/cli/doc-commands.test.ts). It
 * performs no I/O: an `add` is assembled by its pure builder and discarded, and every other verb is checked for the
 * positionals it names. A documented command that misses a required flag fails here rather than at the user's terminal.
 */
export function validateCommand(argv: string[]): ParsedCommand {
  // --version and --help answer before a verb exists: they are documented commands of their own.
  if (argv.includes('--version') || argv.includes('-v')) return { verb: 'version', args: parseArgs(argv, { valueFlags: ['dir', 'output'] }) }
  if (argv.includes('--help') || argv.includes('-h')) {
    const word = commandWordOf(argv)
    if (!word || !VERBS[word]) return { verb: 'help', args: parseArgs(argv, { valueFlags: ['dir', 'output'] }) }
  }
  const parsed = parseCommand(argv)
  const { verb, args } = parsed
  const needsPositional: Record<string, string> = {
    rm: 'an id to remove',
    incident: 'an incident key',
    recheck: 'an incident key'
  }
  const why = needsPositional[verb]
  if (why && args.positionals.length === 0) throw usageError('usage.missing-argument', `watcher ${verb} needs ${why}`)
  // `watcher add <kind> --help` lists a kind's flags without naming the id they belong to.
  if (verb === 'add' && !args.help) validateAdd(args)
  if (verb === 'service' && (args.sub === undefined || !['install', 'uninstall'].includes(args.sub))) {
    throw usageError('usage.missing-sub', 'watcher service needs install or uninstall')
  }
  return parsed
}

/** `--dir` before the parser runs: the env file belongs to the project the command will use. */
function preDir(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dir') return argv[i + 1]
    if (a.startsWith('--dir=')) return a.slice('--dir='.length)
    if (a === '--') break
  }
  return undefined
}

function formatOf(argv: string[]): OutputFormat {
  if (argv.includes('--json') || argv.includes('-q')) return 'json'
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = a === '--output' ? argv[i + 1] : a.startsWith('--output=') ? a.slice('--output='.length) : undefined
    if (v === 'json' || v === 'md' || v === 'table') return v
  }
  return 'table'
}

export function globalHelp(): string {
  const lines = [
    'watcher: the open-source AI SRE for your project (EZO Watcher)',
    '',
    'Usage: watcher <verb> [options]',
    '',
    'Verbs:'
  ]
  for (const [name, verb] of Object.entries(VERBS)) lines.push(`  ${name.padEnd(12)} ${verb.summary}`)
  lines.push(
    '',
    'Global options:',
    '  --dir <path>        the project directory (default: the current directory)',
    '  --output <format>   json | md | table (default: table)',
    '  --json              same as --output json',
    '  --dry-run           preview a write; change nothing',
    '  --show-secret       print a secret value (init/add/mcp-config: never by default)',
    '  --help, -h          this help, or the flags of a verb / an add kind',
    '  --version, -v       the CLI version',
    '',
    'Exit codes: 0 ok, 1 a check failed, 64 usage.',
    'No verb prompts: every answer is a flag. The project state is .watcher/ in the project.',
    'Anonymous telemetry (verb, flag names, exit code, doctor codes, error types): `watcher telemetry disable` or DO_NOT_TRACK=1.',
    '',
    'Runtime: Node 24 or newer. From a checkout the CLI runs src/*.ts under native type stripping;',
    'an installed package runs the bundled dist/cli/main.mjs and dist/server/main.mjs. `watcher run`',
    'loads .watcher/.env and builds dist/web once with vite if the wall has never been built.'
  )
  return lines.join('\n')
}

function verbHelp(name: string, verb: Verb): string {
  const lines = [`watcher ${name}: ${verb.summary}`, '', `Usage: ${verb.usage}`, '', 'Flags:']
  const values = [...new Set([...verb.spec.valueFlags, 'output'])]
  lines.push(`  --${values.join(', --')}`)
  if (verb.spec.switchFlags && verb.spec.switchFlags.length > 0) lines.push(`  --${verb.spec.switchFlags.join(', --')}`)
  lines.push('  --help, -h')
  if (name === 'add') {
    lines.push('', `Source kinds: ${listSourceKinds().join(', ')}`)
    lines.push(`Channel types: ${listChannelTypes().join(', ')}`)
    lines.push('Run `watcher add <kind> --help` for that kind\'s flags.')
  }
  return lines.join('\n')
}

function addKindHelp(isChannel: boolean, kind: string | undefined): string | null {
  if (kind === undefined) return null
  const flags = kindHelp(kind, isChannel)
  if (flags === null) return null
  return [
    `watcher add ${isChannel ? 'channel ' : ''}${kind} --id <id>`,
    '',
    'Flags:',
    ...flags.map((f) => `  ${f}`),
    '',
    `A credential is always an env-var NAME; --secret-value writes the value to .watcher/.env (0600), never to the config.`,
    `A heartbeat or webhook token with no value in .watcher/.env is minted on add; --replace keeps the value, --secret-value sets your own.`,
    `Every write goes through the server's validateConfig; --dry-run validates and prints without writing.`
  ].join('\n')
}

/** The command a run is recorded under: a verb, `help`, `version`, or `unknown` (never the word typed). */
export function telemetryCommandOf(argv: string[]): string {
  const word = commandWordOf(argv)
  if (word === 'telemetry') return 'telemetry'
  if (argv.includes('--version') || argv.includes('-v')) return 'version'
  if (argv.length === 0 || argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) return word && VERBS[word] ? word : 'help'
  return word && VERBS[word] ? word : 'unknown'
}

/** The whole CLI. Returns the process exit code; the bin sets it and exits. */
export async function main(argv: string[]): Promise<number> {
  const started = Date.now()
  const format = formatOf(argv)
  const out = new RecordingOutput(format, process.stdout, process.stderr, argv.includes('--no-color') ? false : undefined)

  // Load the project's .env before parsing dispatch, so `doctor`, `cloudflare`, `mcp-config` and
  // `run` all see the same environment a running server saw. Variables already exported win.
  const dir = preDir(argv)
  const project = resolveProject(dir)
  if (existsSync(project.envPath)) loadProjectEnv(project.envPath)

  // Telemetry opens after the .env is loaded, so a DO_NOT_TRACK there counts; the first-run notice prints here, on stderr.
  // `watcher telemetry` itself records nothing: the command that turns it off must not send (or print the notice) first.
  const command = telemetryCommandOf(argv)
  const telemetry = command === 'telemetry' ? null : openCliTelemetry()
  const ended: Ended = { errorCode: null, thrown: undefined }
  const exitCode = await dispatch(argv, out, ended)
  if (telemetry) {
    let sub: string | null = null
    try {
      sub = VERBS[command] ? (parseCommand(argv).args.sub ?? null) : null
    } catch {
      sub = null // the run already failed on its arguments; the sub-verb is simply not known
    }
    const spec = VERBS[command]?.spec
    await finishCliTelemetry(
      telemetry,
      { command, sub, declared: spec ? [...spec.valueFlags, ...(spec.switchFlags ?? [])] : [], argv, exitCode, durationMs: Date.now() - started, errorCode: ended.errorCode },
      { doctor: command === 'doctor' ? out.lastJson : undefined, thrown: ended.thrown }
    )
  }
  return exitCode
}

/** How a run ended, for telemetry: the CliError code, or the internal error itself. */
interface Ended {
  errorCode: string | null
  thrown: unknown
}

async function dispatch(argv: string[], out: Output, ended: Ended): Promise<number> {
  let args: ParsedArgs
  try {
    if (argv.includes('--version') || argv.includes('-v')) {
      process.stdout.write(`${cliVersion()}\n`)
      return 0
    }
    if (argv.length === 0 || argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) {
      // `watcher add http-probe --help` gets the kind's flags, not the global help.
      const command = commandWordOf(argv)
      if (command === 'add') {
        // The kind is the first positional after the verb (and after `channel`); a global flag before the verb no longer counts.
        let rest: string[] = []
        try {
          const peek = parseCommand(argv)
          rest = [...(peek.args.sub === undefined ? [] : [peek.args.sub]), ...peek.args.positionals]
        } catch {
          rest = []
        }
        const isChannel = rest[0] === 'channel'
        const kind = isChannel ? rest[1] : rest[0]
        const kindText = addKindHelp(isChannel, kind)
        if (kindText) {
          process.stdout.write(`${kindText}\n`)
          return 0
        }
      }
      if (command && command !== 'help' && VERBS[command]) {
        // Peek at the spec so `watcher add --help` still parses its own flags.
        const peek = parseArgs(argv, { valueFlags: [...VERBS[command].spec.valueFlags], switchFlags: [...(VERBS[command].spec.switchFlags ?? [])], subVerbs: [...(VERBS[command].spec.subVerbs ?? [])] })
        process.stdout.write(`${verbHelp(command, VERBS[command])}\n`)
        void peek
        return 0
      }
      process.stdout.write(`${globalHelp()}\n`)
      return 0
    }
    const parsed = parseCommand(argv)
    args = parsed.args
    const code = await VERBS[parsed.verb].run(args, out)
    return code
  } catch (err) {
    if (err instanceof CliError) {
      ended.errorCode = err.code
      out.error({ code: err.code, message: err.message, ...(err.next ? { next: err.next } : {}) })
      return err.exitCode
    }
    ended.errorCode = 'internal.error'
    ended.thrown = err
    const message = err instanceof Error ? err.message : String(err)
    out.error({ code: 'internal.error', message, next: 'Run `watcher doctor` and include this message if it repeats.' })
    return 1
  }
}
