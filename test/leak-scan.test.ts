// The leak gate proves itself: a tree with one planted value of every class it claims to know must fail with that class named,
// and a tree of placeholders must pass. The planted values are assembled from parts rather than written out, so this test file
// is itself clean under the gate it tests — a test that trips the scanner it exercises proves nothing about either. The
// fixture tree is built in a temporary directory for the same reason: a committed fixture would have to carry the leaks it
// plants, and then the gate would report the fixture.
//
// The second half is the other direction: a token in the plaintext list is caught without that list ever entering the tree,
// `--require-denylist` fails closed when the list is missing, and the built client bundle may not carry a configured source.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const SCANNER = fileURLToPath(new URL('../scripts/leak-scan.mjs', import.meta.url))
const REPO = resolve(dirname(SCANNER), '..')

interface Finding {
  tier: number
  rule: string
  file: string
  line: number
  column: number
  token: string
  message: string
}

interface Report {
  ok: boolean
  code?: string
  error?: string
  findings: Finding[]
  stats: Record<string, number>
}

interface Run {
  status: number
  stdout: string
  stderr: string
  report: Report | null
}

const trees: string[] = []

afterEach(() => {
  for (const dir of trees.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'leak-scan-'))
  trees.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return dir
}

const parts = (...values: string[]): string => values.join('')
const labels = (...values: string[]): string => values.join('.')

// The smallest allowlist a scan needs: the placeholder names a clean tree may use.
const ALLOW = ['example.com', 'example.org', 'example.net', 'localhost', 'ntfy.sh', 'k8s.io'].join('\n') + '\n'

function run(args: string[], env: Record<string, string> = {}): Run {
  const result = spawnSync(process.execPath, [SCANNER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LEAK_DENYLIST: '', LEAK_DENYLIST_FILE: '', ...env }
  })
  let report: Report | null = null
  try {
    report = JSON.parse(result.stdout) as Report
  } catch {
    report = null
  }
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr, report }
}

// Every planted value, assembled so that this file never contains one of them.
const PLANTED = {
  ipv4Public: [93, 184, 216, 34].join('.'),
  ipv4Cgnat: [100, 71, 4, 9].join('.'),
  hostLocal: labels(parts('build', '-', 'box'), 'local'),
  hostInternal: labels('db', 'internal'),
  hostTailnet: labels('build', 'box', parts('tail', '9f2c'), 'ts', 'net'),
  email: parts('ops', '@', labels('acme', 'robotics'), '.dev'),
  phone: parts('+', '14158675309'),
  path: parts('/', 'Users', '/', 'ada', '/', 'work/repo'),
  credential: parts('sk', '_', 'live', '_', '51HxY2abcDEF0123456789'),
  hex: createHash('sha256').update('planted-hex-value').digest('hex'),
  hostname: labels('api', labels('acme', 'robotics'), 'dev'),
  uuid: [parts('7c9e1d2a'), parts('0b3f'), parts('4a1c'), parts('9e2d'), parts('5f6a7b8c9d0e')].join('-'),
  // A stand-in naming family (`kqr`, `kqx`, `KQ_`): the real one lives only in the never-committed list.
  familyName: parts('K', 'q', 'r', 'Wedge'),
  token: labels(parts('acme', '-', 'widget'), 'corp'),
  domain: labels('acme', 'infra') + '.dev'
}

describe('tier 1: the generic classes', () => {
  it('names one planted value of every class', () => {
    const dir = tempTree({
      'scripts/leak-allow.txt': ALLOW,
      'notes/leaks.txt': [
        `public address ${PLANTED.ipv4Public}`,
        `tailnet address ${PLANTED.ipv4Cgnat}`,
        `machine ${PLANTED.hostLocal}`,
        `service ${PLANTED.hostInternal}`,
        `tailnet ${PLANTED.hostTailnet}`,
        `mailbox ${PLANTED.email}`,
        `pager ${PLANTED.phone}`,
        `checkout ${PLANTED.path}`,
        `key ${PLANTED.credential}`,
        `digest ${PLANTED.hex}`,
        `endpoint ${PLANTED.hostname}`,
        `space ${PLANTED.uuid}`,
        `denied ${PLANTED.token}`
      ].join('\n') + '\n'
    })
    const { status, report } = run(['--root', dir, '--history', 'none', '--json'], { LEAK_DENYLIST: PLANTED.token })
    expect(status).toBe(1)
    expect(report?.ok).toBe(false)
    const rules = new Set(report?.findings.map((finding) => finding.rule))
    for (const rule of ['ipv4-public', 'ipv4-cgnat', 'hostname-local', 'hostname-internal', 'hostname-tailnet', 'email', 'phone', 'path-home', 'credential', 'hex-blob', 'hostname-public', 'uuid', 'denylist']) {
      expect(rules, rule).toContain(rule)
    }
    const denied = report?.findings.find((finding) => finding.rule === 'denylist')
    expect(denied?.token).toBe(PLANTED.token)
    expect(denied?.file).toBe('notes/leaks.txt')
  })

  it('passes a tree of placeholders, the synthetic UUID shape included', () => {
    const dir = tempTree({
      'scripts/leak-allow.txt': ALLOW,
      'src/clean.ts': [
        "const base = 'https://api.example.com/healthz'",
        "const local = 'http://127.0.0.1:7717'",
        "const private4 = '10.1.2.3'",
        "const doc = '192.0.2.10'",
        "const tailnet = '100.64.0.0'",
        "const mail = 'ops@example.com'",
        "const fictional = '+15550001111'",
        "const brew = '/opt/homebrew/bin/node'",
        "const ext = 'intake.sh'",
        'const el = x.el, at = at.top, dev = x.dev, org = cfg.org',
        "const host = 'docs.ntfy.sh'",
        "const kube = 'k8s.io'",
        `const fixture = '${parts('00000000', '-', '0000', '-', '4000', '-', '8000', '-', '00000000000a')}'`
      ].join('\n') + '\n'
    })
    const { status, report } = run(['--root', dir, '--history', 'none', '--json'])
    expect(report?.findings).toEqual([])
    expect(status).toBe(0)
  })

  it('accepts the brand in both tiers', () => {
    const dir = tempTree({
      'scripts/leak-allow.txt': ALLOW,
      'README.md': 'The product is EZO Watcher by EZO Labs. The package is ezo-watcher; the org is ezolabs.\n'
    })
    const { status, report } = run(['--root', dir, '--history', 'none', '--json'], { LEAK_DENYLIST: parts('ezo', 'labs') })
    expect(report?.findings).toEqual([])
    expect(status).toBe(0)
  })

  it('reads neither a lockfile integrity value nor a resolved URL', () => {
    const digest = parts('sha512-', createHash('sha512').update('lock').digest('base64'))
    const dir = tempTree({
      'scripts/leak-allow.txt': ALLOW,
      'package-lock.json': JSON.stringify({
        name: 'demo',
        packages: { 'node_modules/demo': { integrity: digest, resolved: 'https://registry.example.org/demo/-/demo-1.0.0.tgz' } }
      })
    })
    const { status, report } = run(['--root', dir, '--history', 'none', '--json'])
    expect(report?.findings).toEqual([])
    expect(status).toBe(0)
  })

  it('skips a binary file', () => {
    const dir = tempTree({
      'scripts/leak-allow.txt': ALLOW,
      'public/icon.png': parts('\u0000\u0001PNG', PLANTED.ipv4Public)
    })
    const { status, report } = run(['--root', dir, '--history', 'none', '--json'])
    expect(report?.findings).toEqual([])
    expect(status).toBe(0)
  })

  it('takes the synthetic UUID shape in any case but not another UUID', () => {
    const synthetic = parts('00000000', '-', '0000', '-', '4000', '-', '8000', '-', 'ABCDEF012345')
    const dir = tempTree({
      'scripts/leak-allow.txt': ALLOW,
      'src/ids.ts': `const ok = '${synthetic.toLowerCase()}'\n`
    })
    expect(run(['--root', dir, '--history', 'none', '--json']).status).toBe(0)
    writeFileSync(join(dir, 'src/ids.ts'), `const bad = '${PLANTED.uuid}'\n`)
    const { status, report } = run(['--root', dir, '--history', 'none', '--json'])
    expect(status).toBe(1)
    expect(report?.findings.map((finding) => finding.rule)).toEqual(['uuid'])
  })
})

describe('tier 2: the plaintext list that never enters the tree', () => {
  it('catches a denied token in any case', () => {
    const dir = tempTree({
      'scripts/leak-allow.txt': ALLOW,
      'src/leak.ts': `const org = '${PLANTED.token.toUpperCase()}'\n`
    })
    const { status, report } = run(['--root', dir, '--history', 'none', '--json'], { LEAK_DENYLIST: `${PLANTED.token}\n` })
    expect(status).toBe(1)
    expect(report?.findings.map((finding) => finding.rule)).toEqual(['denylist'])
  })

  it('catches a denied token from LEAK_DENYLIST_FILE, whole-word only', () => {
    const dir = tempTree({
      'scripts/leak-allow.txt': ALLOW,
      'src/leak.ts': `const org = '${PLANTED.token}'\nconst longer = '${PLANTED.token}-extra'\n`
    })
    const listDir = mkdtempSync(join(tmpdir(), 'leak-deny-'))
    trees.push(listDir)
    const list = join(listDir, 'deny.txt')
    writeFileSync(list, `# a comment\n${PLANTED.token}\n`)
    const { status, report } = run(['--root', dir, '--history', 'none', '--json'], { LEAK_DENYLIST_FILE: list })
    expect(status).toBe(1)
    const denied = report?.findings.filter((finding) => finding.rule === 'denylist') ?? []
    // Whole-word only: the hyphenated longer name (`<token>-extra`) is a different identifier, not the denied one.
    expect(denied.length).toBe(1)
    expect(denied.every((finding) => finding.file === 'src/leak.ts')).toBe(true)
  })

  it('denies a naming family through a prefix entry, where the prefix runs into the rest of the name', () => {
    const dir = tempTree({
      'scripts/leak-allow.txt': ALLOW,
      'src/alerts.ts': [
        `const rule = '${PLANTED.familyName}'`,
        `const ns = '${parts('k', 'q', 'x', '-', 'space')}'`,
        `const file = '${parts('k', 'q', 'r', '.rules.yml')}'`,
        `const env = '${parts('K', 'Q', '_', 'INGEST_TOKEN')}'`,
        `const other = '${parts('a', 'k', 'q', 'r', '-', 'unrelated')}'`
      ].join('\n') + '\n'
    })
    const family = { LEAK_DENYLIST: ['kqr*', 'kqx*', 'kq_*'].join('\n') }
    const { status, report } = run(['--root', dir, '--history', 'none', '--json'], family)
    expect(status).toBe(1)
    expect(report?.findings.map((finding) => [finding.rule, finding.line, finding.token])).toEqual([
      ['denylist', 1, PLANTED.familyName],
      ['denylist', 2, parts('k', 'q', 'x', '-', 'space')],
      ['denylist', 3, 'kqr'],
      ['denylist', 4, parts('K', 'Q', '_', 'INGEST_TOKEN')]
    ])
    // Without the `*` the same entry is whole-word: it still denies the dotted file name, but not the names it runs into.
    const word = run(['--root', dir, '--history', 'none', '--json'], { LEAK_DENYLIST: 'kqr' })
    expect(word.report?.findings.map((finding) => finding.line)).toEqual([3])
    // A bare `*` would deny everything, so it is no entry at all.
    expect(run(['--root', dir, '--history', 'none', '--require-denylist', '--json'], { LEAK_DENYLIST: '*' }).status).toBe(3)
  })

  it('passes the same tree when the list denies something else', () => {
    const dir = tempTree({
      'scripts/leak-allow.txt': ALLOW,
      'src/leak.ts': `const org = '${PLANTED.token}'\n`
    })
    const { status, report } = run(['--root', dir, '--history', 'none', '--json'], { LEAK_DENYLIST: labels('other', 'corp') })
    expect(report?.findings).toEqual([])
    expect(status).toBe(0)
  })

  it('skips tier 2 with a printed note when no list is set, and fails closed with --require-denylist', () => {
    const dir = tempTree({
      'scripts/leak-allow.txt': ALLOW,
      'src/clean.ts': 'export const ok = true\n'
    })
    const skipped = run(['--root', dir, '--history', 'none'])
    expect(skipped.status).toBe(0)
    expect(skipped.stdout).toContain('tier 2 skipped')
    const required = run(['--root', dir, '--history', 'none', '--require-denylist', '--json'])
    expect(required.status).toBe(3)
    expect(required.report?.code).toBe('leak.denylist-missing')
  })

  it('fails --require-denylist when the named file does not exist', () => {
    const dir = tempTree({ 'scripts/leak-allow.txt': ALLOW, 'src/clean.ts': 'export const ok = true\n' })
    const missing = run(['--root', dir, '--history', 'none', '--require-denylist', '--json'], { LEAK_DENYLIST_FILE: join(dir, 'nope.txt') })
    expect(missing.status).toBe(3)
    expect(missing.report?.code).toBe('leak.denylist-missing')
  })
})

describe('fail closed', () => {
  it('refuses to run without an allowlist', () => {
    const dir = tempTree({ 'src/clean.ts': 'export const ok = true\n' })
    const { status, report } = run(['--root', dir, '--history', 'none', '--json'])
    expect(status).toBe(3)
    expect(report?.code).toBe('leak.allowlist-missing')
  })
})

describe('the built client bundle', () => {
  const config = JSON.stringify({
    sources: [{ id: 'probe', type: 'http-probe', url: 'http://127.0.0.1:8123/healthz', tokenEnv: 'PROBE_INGEST_TOKEN' }]
  })

  it('denies a configured source host:port or env name in dist/web', () => {
    const dir = tempTree({
      'scripts/leak-allow.txt': ALLOW,
      'config/watch.example.json': config,
      'dist/web/app.js': "const probe = 'http://127.0.0.1:8123/healthz'; const token = 'PROBE_INGEST_TOKEN'\n"
    })
    const { status, report } = run(['--root', dir, '--history', 'none', '--json'])
    expect(status).toBe(1)
    const bundle = report?.findings.filter((finding) => finding.rule === 'bundle-config') ?? []
    expect(bundle.map((finding) => finding.token).sort()).toEqual(['127.0.0.1:8123', 'PROBE_INGEST_TOKEN'])
    expect(bundle.every((finding) => finding.file === 'dist/web/app.js')).toBe(true)
  })

  it('judges dist/web only: the CLI and server bundles are the process that reads the config', () => {
    const dir = tempTree({
      'scripts/leak-allow.txt': ALLOW,
      'config/watch.example.json': config,
      'dist/web/app.js': 'export const title = "Watcher"\n',
      'dist/cli/main.mjs': `const url = 'http://127.0.0.1:8123/healthz'; const token = 'PROBE_INGEST_TOKEN'\n`
    })
    const { status, report } = run(['--root', dir, '--history', 'none', '--json'])
    expect(report?.findings).toEqual([])
    expect(status).toBe(0)
  })
})

describe('the commit messages', () => {
  it('scopes the scan to a range, reads all on a first push, and reads none with --history none', () => {
    const dir = tempTree({
      'scripts/leak-allow.txt': ALLOW,
      'README.md': '# demo\n'
    })
    const git = (...args: string[]) =>
      spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-C', dir, ...args], { encoding: 'utf8' })
    const init = git('init', '-q')
    if (init.status !== 0) return // no git on this machine: nothing to prove
    git('add', '-A')
    git('commit', '-q', '-m', 'Initial')
    const first = git('rev-parse', 'HEAD').stdout.trim()
    writeFileSync(join(dir, 'README.md'), '# demo\nmore\n')
    git('add', '-A')
    git('commit', '-q', '-m', `Add ${PLANTED.token} support`)

    const inLog = (r: Run): number => (r.report?.findings ?? []).filter((f) => f.file.startsWith('<git-log>')).length
    const env = { LEAK_DENYLIST: PLANTED.token }
    expect(inLog(run(['--root', dir, '--history', 'range', '--range', `${first}..${first}`, '--json'], env))).toBe(0)
    expect(inLog(run(['--root', dir, '--history', 'range', '--range', `${first}..HEAD`, '--json'], env))).toBe(1)
    // a first push names the all-zero sha for `before`: that is no range at all, so every commit is read
    expect(inLog(run(['--root', dir, '--history', 'range', '--range', `${'0'.repeat(40)}..HEAD`, '--json'], env))).toBe(1)
    expect(inLog(run(['--root', dir, '--history', 'none', '--json'], env))).toBe(0)
  })

  it('reads a denied token out of git log', () => {
    const dir = tempTree({
      'scripts/leak-allow.txt': ALLOW,
      'README.md': '# demo\n'
    })
    const git = (...args: string[]) =>
      spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-C', dir, ...args], { encoding: 'utf8' })
    const init = git('init', '-q')
    if (init.status !== 0) return // no git on this machine: nothing to prove
    git('add', '-A')
    git('commit', '-q', '-m', `Add ${PLANTED.token} support`)
    const env = { LEAK_DENYLIST: PLANTED.token }
    const { status, report } = run(['--root', dir, '--json'], env)
    expect(status).toBe(1)
    const fromLog = report?.findings.filter((finding) => finding.file.startsWith('<git-log>')) ?? []
    expect(fromLog.map((finding) => finding.rule)).toEqual(['denylist'])
    const quiet = run(['--root', dir, '--history', 'none', '--json'], env)
    expect(quiet.status).toBe(0)
  })

  it('reads the author and committer of each commit, not just its message', () => {
    const dir = tempTree({
      'scripts/leak-allow.txt': ALLOW,
      'README.md': '# demo\n'
    })
    const bot = parts('acme', '-', 'ci')
    const git = (...args: string[]) =>
      spawnSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Ada',
          GIT_AUTHOR_EMAIL: parts('build', '@', PLANTED.token),
          GIT_COMMITTER_NAME: bot,
          GIT_COMMITTER_EMAIL: parts('12345+', bot, '@users.noreply.github.com')
        }
      })
    const init = git('init', '-q')
    if (init.status !== 0) return // no git on this machine: nothing to prove
    git('add', '-A')
    git('commit', '-q', '-m', 'Initial')
    const env = { LEAK_DENYLIST: `${PLANTED.token}\n${bot}\n` }
    const { status, report } = run(['--root', dir, '--json'], env)
    expect(status).toBe(1)
    const of = (prefix: string): Finding[] => (report?.findings ?? []).filter((finding) => finding.file.startsWith(prefix))
    // The author's address is a real mailbox (tier 1) on a denied domain (tier 2).
    expect(of('<git-author>').map((finding) => finding.rule).sort()).toEqual(['denylist', 'email'])
    // The committer's GitHub no-reply address passes tier 1, but the login it carries is denied, as is the name.
    const committer = of('<git-committer>')
    expect(committer.map((finding) => finding.rule)).toEqual(['denylist', 'denylist'])
    expect(committer.every((finding) => finding.token.toLowerCase() === bot)).toBe(true)
    expect(of('<git-log>')).toEqual([])
    expect(run(['--root', dir, '--history', 'none', '--json'], env).status).toBe(0)
  })

  it('passes a commit made under a GitHub no-reply identity', () => {
    const dir = tempTree({
      'scripts/leak-allow.txt': ALLOW,
      'README.md': '# demo\n'
    })
    const git = (...args: string[]) =>
      spawnSync('git', ['-c', 'user.email=12345+ada@users.noreply.github.com', '-c', 'user.name=Ada', '-C', dir, ...args], { encoding: 'utf8' })
    const init = git('init', '-q')
    if (init.status !== 0) return // no git on this machine: nothing to prove
    git('add', '-A')
    git('commit', '-q', '-m', 'Initial')
    const { status, report } = run(['--root', dir, '--json'], { LEAK_DENYLIST: PLANTED.token })
    expect(report?.findings).toEqual([])
    expect(status).toBe(0)
  })
})

describe('the gate keeps its own files clean', () => {
  it('finds nothing in the cleaned tree', () => {
    // A tree with one real-looking UUID and one name from a denied family must fail...
    const planted = tempTree({
      'scripts/leak-allow.txt': ALLOW,
      'notes/planted.txt': `space ${PLANTED.uuid}\nrule ${PLANTED.familyName}\n`
    })
    const red = run(['--root', planted, '--history', 'none', '--json'], { LEAK_DENYLIST: 'kqr*' })
    expect(red.status).toBe(1)
    expect(red.report?.findings.map((finding) => finding.rule).sort()).toEqual(['denylist', 'uuid'])

    // ...and the repository itself must pass.
    const { status, report } = run(['--root', REPO, '--history', 'none', '--no-dist', '--json'])
    expect(report?.findings).toEqual([])
    expect(status).toBe(0)
  })

  it('names the UUID class, and leaves every internal name family to the list', () => {
    const source = readFileSync(SCANNER, 'utf8')
    expect(source).toContain("'uuid'")
    // No tier-1 rule for one deployment's names, and so no exemption for the scanner's own source either.
    expect(source).not.toContain("'env-prefix'")
    expect(source).not.toContain("file === 'scripts/leak-scan.mjs'")
    expect(source).toContain('--require-denylist')
    expect(source).not.toContain('leak-denylist.sha256')
  })
})
