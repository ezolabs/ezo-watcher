#!/usr/bin/env node
// The leak gate, in two tiers.
//
// Tier 1 is generic and lives in this file: classes of value that identify a private system wherever they appear — public IP
// addresses, carrier-grade NAT and tailnet addresses, `*.local` and `*.internal` machine names, e-mail addresses that are not
// placeholders or GitHub's no-reply addresses, E.164 phone numbers, absolute home and install paths, provider credential shapes, long hex runs, and hostnames
// that the committed allowlist does not accept. It needs no secret and no configuration, so it runs on a fork's pull request
// exactly as it runs on main.
//
// Tier 2 is a plain token list that never enters the tree: LEAK_DENYLIST (newlines) or LEAK_DENYLIST_FILE (a path), matched
// whole-word and case-insensitively; an entry ending in `*` is a prefix, matched with a leading boundary only, so a family of
// internal names (`abc*`: `abc.rules.yml`, `AbcWedge`, `ABC_TOKEN`) is denied without this file naming it. A committed list, hashed or not, would either name the tokens (a plaintext list) or be
// guessable for low-entropy ones (a salted hash list of short hostnames and env names); the list lives in the repository
// secret and in the operator's environment instead. --require-denylist makes a missing list fail closed (exit 3) on main;
// a fork's pull request has no secret, so without the flag tier 2 is skipped with a printed note and tier 1 still runs.
//
// What is scanned: the tracked (and not ignored) files of the tree and, for every commit `--history` names (`all` by default),
// its message and its author and committer name and e-mail — all in full, except that a commit the allowlist names as
// `commit:<sha>` (already public) has its tier-1 findings counted and printed rather than reported. The built output under
// `dist/`, when a build has run, is read by tier 2 and by the config rule below rather than by tier 1's shape heuristics: a
// minified third-party bundle is full of object properties that end in a reserved machine-name suffix, documentation links
// and dependency commit ids, so tier 1 belongs on the sources that name a value, while the exact denylist and the config rule
// are what a build artifact can be judged by. The config rule is the UptimeFlare class of bug, where a build-time config
// module reaches the browser: every source host:port and every `*Env` name the example config and its fixtures carry must not
// appear in `dist/web/**`, the one bundle a browser receives (the CLI and server bundles under `dist/cli/` and `dist/server/`
// legitimately carry those names: they are the process that reads them).
//
// The brand of this product is allowed in both tiers (`EZO Watcher`, `ezo-watcher`, `ezolabs`, `EZO Labs`): the gate denies
// infrastructure identifiers, not the project's own name.
//
// Usage:
//   node scripts/leak-scan.mjs [--root <dir>] [--allow <file>] [--config <file>] [--require-denylist]
//                              [--history all|range|none] [--range <git range>] [--no-dist] [--json] [--github] [--quiet]
//
// Exit codes: 0 clean, 1 findings, 2 bad usage, 3 the gate could not load its allowlist or denylist (fail closed).

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// The reserved TLDs (RFC 2606, RFC 6761) and the placeholder second-level label: a name under one of these cannot identify
// a private system, so both tiers accept it unconditionally.
const RESERVED_TLDS = new Set(['example', 'test', 'invalid', 'localhost'])
const RESERVED_LABELS = new Set(['example'])

// The TLDs a hostname candidate may end with. Deliberately not every delegated TLD: `info`, `name`, `page`, `store`, `site`
// and friends are also ordinary object properties in this codebase (`counts.info`, `held.page`), and a scanner that reads
// them as hostnames drowns the gate in noise. A private system on one of those TLDs is caught by tier 2, which names it.
const TLDS = new Set([
  'com', 'org', 'net', 'io', 'dev', 'sh', 'gg', 'fun', 'cloud', 'app', 'co', 'me', 'tv', 'ai', 'xyz', 'top', 'uk', 'de',
  'fr', 'eu', 'ca', 'us', 'edu', 'gov', 'biz', 'pro', 'mobi', 'asia'
])

// A two-label token ending in one of these is a file name (`intake.sh`, `read-one.sh`), not a host: every one of them is
// also a real TLD, and the tree writes script names in prose constantly.
const FILE_EXT_TLDS = new Set([
  'sh', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'md', 'css', 'scss', 'html', 'json', 'txt', 'yml', 'yaml', 'svg', 'png',
  'jpg', 'jpeg', 'gif', 'webp', 'ico', 'log', 'db', 'lock', 'toml', 'ini', 'env', 'conf', 'map', 'gz', 'zip', 'wasm', 'pdf'
])

// Directories whose text is never part of the tree the gate speaks about: the git store, dependencies, scratch, data and
// build output (dist is read separately, as the built bundle).
const SKIP_DIRS = new Set(['.git', 'node_modules', '.tmp', 'data', 'coverage', '.cache', '.vite'])

const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g
const HOST_RE = /(?<![A-Za-z0-9@._-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?![A-Za-z0-9_-])/g
const PHONE_RE = /(?<![A-Za-z0-9+])\+[1-9]\d{6,14}(?![A-Za-z0-9])/g
const PATH_RE = /(?<![\w./-])\/(?:Users|home|root|opt)\/([A-Za-z0-9._-]+)/g
const HEX_RE = /(?<![0-9A-Za-z_])[0-9A-Fa-f]{32,}(?![0-9A-Za-z_])/g
// RFC 4122 UUIDs identify a space, room, node or alarm outside this tree. The one synthetic shape the fixtures use is the
// all-zero prefix with the version/variant nibbles fixed: 00000000-0000-4000-8000-<12 hex>. Any other UUID is a finding.
const UUID_RE = /(?<![0-9A-Za-z])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9A-Za-z])/g
const SYNTHETIC_UUID_RE = /^00000000-0000-4000-8000-[0-9a-fA-F]{12}$/
const CREDENTIAL_RE = new RegExp(
  '(?<![A-Za-z0-9])(' +
    'sk_live_[A-Za-z0-9]{8,}|sk_test_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,}|' +
    'xox[baprs]-[A-Za-z0-9-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|' +
    '-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----' +
  ')',
  'g'
)

// The one install prefix that names no owner: Homebrew's on Apple silicon. Every other /opt/<name> is a product of its own.
const GENERIC_OPT_PREFIXES = new Set(['homebrew'])

// Object properties in this codebase whose name happens to be a TLD (`cfg.org`). They are code, not hosts, and no rule can
// tell the two apart by shape alone; naming them here is cheaper than allowlisting a host that is not a host. Every TLD that
// is also an ordinary verb or noun (`run`, `page`, `store`, `name`, `info`) is left out of `TLDS` instead.
const CODE_CHAINS = new Set(['cfg.org'])

const BRAND_RE = /(?<![A-Za-z0-9])(?:ezo[ _-]watcher|ezo[ _-]labs|ezolabs)(?![A-Za-z0-9])/gi

const RULE_TEXT = {
  'ipv4-public': 'public IP address',
  'ipv4-cgnat': 'carrier-grade NAT or tailnet address',
  'hostname-local': '*.local machine name',
  'hostname-internal': '*.internal machine name',
  'hostname-tailnet': '*.ts.net tailnet machine name',
  'hostname-public': 'hostname the allowlist does not accept',
  email: 'e-mail address that is not a placeholder',
  phone: 'E.164 phone number',
  'path-home': 'absolute home or install path',
  credential: 'provider credential',
  'hex-blob': 'long hex run',
  uuid: 'UUID that is not the synthetic fixture shape',
  'bundle-config': 'configured value inside the built client bundle',
  denylist: 'denied token'
}

const EXIT_CLEAN = 0
const EXIT_FINDINGS = 1
const EXIT_USAGE = 2
const EXIT_UNUSABLE = 3

// ---- arguments -----------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { root: process.cwd(), json: false, github: false, quiet: false, history: 'all', range: null, dist: true, allow: null, requireDenylist: false, config: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined) throw new UsageError(`${arg} needs a value`)
      return v
    }
    switch (arg) {
      case '--root': opts.root = value(); break
      case '--allow': opts.allow = value(); break
      case '--require-denylist': opts.requireDenylist = true; break
      case '--config': opts.config = value(); break
      case '--history':
        opts.history = value()
        if (!['all', 'range', 'none'].includes(opts.history)) throw new UsageError(`--history must be all, range or none, not ${JSON.stringify(opts.history)}`)
        break
      case '--range': opts.range = value(); break
      case '--no-dist': opts.dist = false; break
      case '--json': opts.json = true; break
      case '--github': opts.github = true; break
      case '--quiet': opts.quiet = true; break
      case '--help': case '-h': opts.help = true; break
      default: throw new UsageError(`unknown option ${arg}`)
    }
  }
  return opts
}

class UsageError extends Error {}

const USAGE = `leak-scan — the two-tier leak gate

  node scripts/leak-scan.mjs [options]

  --root <dir>              tree to scan (default: the working directory)
  --allow <file>            allowlist of hostnames and ip:, hex: and commit:<sha> entries
                            (default: <root>/scripts/leak-allow.txt)
  --require-denylist        fail closed (exit 3) when LEAK_DENYLIST / LEAK_DENYLIST_FILE names no token
  --config <file>           example config whose source hosts and *Env names the bundle may not carry
                            (default: <root>/config/watch.example.json, when present)
  --history <mode>          which commits to read (message, author, committer): all (default), range (the commits
                            a push or pull request adds, from --range or LEAK_HISTORY_RANGE; a
                            first push, whose before-sha is all zeros, scans all) or none
  --range <git range>       the range --history range reads, such as origin/main..HEAD
  --no-dist                 do not read dist/
  --json                    print one JSON report
  --github                  print GitHub Actions annotations
  --quiet                   print findings only, no summary

Exit codes: 0 clean, 1 findings, 2 usage, 3 the gate could not load its allowlist or denylist (fail closed).`

// ---- the allowlist -------------------------------------------------------------------------------------------------------

// One line per entry, `#` comments:
//   example.com        a hostname; accepts the name itself and every subdomain of it
//   ip:203.0.113.9     one IP address (RFC 5737 documentation addresses need no entry: they are accepted already)
//   hex:<value>        one long hex run that is data, not a secret (a documented fixture id)
//   commit:<sha>       one commit already public, by its full 40-hex sha: tier 1 accepts what that commit's message, author
//                      and committer carry (a pushed commit cannot be unpublished, so re-flagging it says nothing new), while
//                      tier 2 still reads them and reports. Every accepted finding is counted in the summary line and in
//                      --json, so a green run never hides one. The sha itself is a public commit id, accepted as a hex run.
const emptyAllow = () => ({ hosts: new Set(), ips: new Set(), hex: new Set(), commits: new Set() })

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i

function readAllowlist(file) {
  if (!existsSync(file)) throw new UnusableError('leak.allowlist-missing', `no allowlist at ${file}`)
  const allow = emptyAllow()
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('ip:')) allow.ips.add(line.slice(3).trim())
    else if (line.startsWith('hex:')) allow.hex.add(line.slice(4).trim().toLowerCase())
    else if (line.startsWith('commit:')) {
      // Only the full sha: an abbreviation could come to name a second commit as the history grows.
      const sha = line.slice(7).trim()
      if (!COMMIT_SHA_RE.test(sha)) throw new UnusableError('leak.allowlist-invalid', `${file}:${i + 1}: ${JSON.stringify(line)} is not commit:<full 40-hex sha>`)
      allow.commits.add(sha.toLowerCase())
      allow.hex.add(sha.toLowerCase())
    } else allow.hosts.add(line.toLowerCase())
  }
  if (allow.hosts.size === 0) throw new UnusableError('leak.allowlist-missing', `${file} lists no hostnames`)
  return allow
}

// The name itself or any parent domain of it: `ntfy.sh` accepts `docs.ntfy.sh`.
function hostAllowed(host, allow) {
  let name = host
  for (;;) {
    if (allow.hosts.has(name)) return true
    const dot = name.indexOf('.')
    if (dot < 0) return false
    name = name.slice(dot + 1)
  }
}

// ---- the denylist --------------------------------------------------------------------------------------------------------

const ENV_DENY_SPLIT = /\r?\n/

// The whole plain list: LEAK_DENYLIST (newlines) or LEAK_DENYLIST_FILE (a path to the same). Never committed. An entry is
// matched whole-word and case-insensitively, or as a prefix when it ends in `*`; a `#` line is a comment, and a bare `*`,
// which would deny everything, is dropped.
function readEnvDenylist(env) {
  const entries = []
  const inline = env.LEAK_DENYLIST
  if (typeof inline === 'string') entries.push(...inline.split(ENV_DENY_SPLIT))
  if (typeof env.LEAK_DENYLIST_FILE === 'string' && env.LEAK_DENYLIST_FILE !== '' && existsSync(env.LEAK_DENYLIST_FILE)) {
    entries.push(...readFileSync(env.LEAK_DENYLIST_FILE, 'utf8').split(ENV_DENY_SPLIT))
  }
  return [...new Set(entries.map((e) => e.trim().toLowerCase()).filter((e) => e.replace(/\*$/, '') !== '' && !e.startsWith('#')))]
}

class UnusableError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// ---- reading files -------------------------------------------------------------------------------------------------------

const isProbablyBinary = (buf) => {
  const end = Math.min(buf.length, 8192)
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true
  return false
}

// The tree's own file list: tracked files plus untracked files that are not ignored. `git ls-files` prints paths relative
// to the working directory git was given, so they join onto the root unchanged.
function listTreeFiles(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return out.split('\0').filter(Boolean)
  } catch {
    return listDirFiles(root, '')
  }
}

function listDirFiles(root, prefix) {
  const out = []
  let entries
  try {
    entries = readdirSync(join(root, prefix), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...listDirFiles(root, rel))
    } else if (entry.isFile()) {
      out.push(rel)
    }
  }
  return out
}

// dist/ is not in the tree (it is ignored), so it is listed on its own when a build has run.
function listDistFiles(root) {
  const out = []
  const walk = (prefix) => {
    let entries
    try {
      entries = readdirSync(join(root, prefix), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (entry.isFile()) out.push(rel)
    }
  }
  if (existsSync(join(root, 'dist'))) walk('dist')
  return out
}

function readText(root, rel) {
  const abs = join(root, rel)
  let stat
  try {
    stat = statSync(abs)
  } catch {
    return null
  }
  if (!stat.isFile()) return null
  const buf = readFileSync(abs)
  if (isProbablyBinary(buf)) return null
  return buf.toString('utf8')
}

// package-lock.json's integrity and resolved strings are registry data: base64 hashes and registry URLs. The hash can hold
// a run that looks like hex, and the lockfile is not where a private identifier would live. Both are blanked in place (same
// length, so every reported column still points at the real line).
function blankLockValues(text) {
  return text.replace(/("(?:integrity|resolved)":\s*")[^"]*(")/g, (all, head, tail) => head + ' '.repeat(all.length - head.length - tail.length) + tail)
}

// ---- positions -----------------------------------------------------------------------------------------------------------

function lineStarts(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}

function positionOf(starts, offset) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 }
}

// ---- tier 1 --------------------------------------------------------------------------------------------------------------

const OCTETS_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

// IPv4 that names a machine: public addresses and the carrier-grade NAT / tailnet range. Loopback, RFC 1918, link-local,
// the documentation ranges and multicast name nobody, and the range's own network and broadcast addresses (100.64.0.0,
// 100.127.255.255) are the range's definition rather than an address in it.
function ipv4Class(token) {
  const m = OCTETS_RE.exec(token)
  if (!m) return null
  const octets = m.slice(1).map(Number)
  if (octets.some((n) => n > 255)) return null
  const [a, b, c] = octets
  if (a === 0 || a === 127 || a >= 224) return null
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return null
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return null
  if (a === 169 && b === 254) return null
  if (a === 100 && b >= 64 && b <= 127) {
    if (token === '100.64.0.0' || token === '100.127.255.255') return null
    return 'ipv4-cgnat'
  }
  return 'ipv4-public'
}

const isRepeatedPattern = (value) => {
  for (let period = 1; period <= Math.floor(value.length / 2); period++) {
    if (value.length % period !== 0) continue
    if (value.slice(0, period).repeat(value.length / period) === value) return true
  }
  return false
}

// A phone number is E.164 (`+` and up to 15 digits). The NANP's 555-01xx block is reserved for fiction, so those numbers
// name nobody and pass.
const isFictionalPhone = (token) => /^\+1(?:555\d{7}|[2-9]\d{2}555\d{4})$/.test(token)

const emailDomain = (token) => token.slice(token.lastIndexOf('@') + 1).toLowerCase()

function isPlaceholderEmail(token) {
  const domain = emailDomain(token)
  const labels = domain.split('.')
  const tld = labels[labels.length - 1]
  return RESERVED_TLDS.has(tld) || labels.some((label) => RESERVED_LABELS.has(label))
}

// The addresses GitHub writes so that a commit names no mailbox: `<id>+<login>@users.noreply.github.com` for a person or a
// bot, and `noreply@github.com` for a commit made in the web UI. The login it carries is tier 2's to judge.
const isGithubNoreply = (token) => emailDomain(token) === 'users.noreply.github.com' || token.toLowerCase() === 'noreply@github.com'

// Every finding for one block of text. `file` is the label the report prints (a repository path, a dist path, or
// `<git-log>`, `<git-author>` or `<git-committer>` and the commit's sha).
function scanTier1(text, file, allow) {
  const findings = []
  const starts = lineStarts(text)
  const add = (rule, index, token) => {
    const { line, column } = positionOf(starts, index)
    findings.push({ tier: 1, rule, file, line, column, token, message: RULE_TEXT[rule] })
  }

  for (const m of text.matchAll(CREDENTIAL_RE)) add('credential', m.index, m[0].slice(0, 24) + (m[0].length > 24 ? '…' : ''))

  for (const m of text.matchAll(IPV4_RE)) {
    const rule = ipv4Class(m[0])
    if (rule === null || allow.ips.has(m[0])) continue
    add(rule, m.index, m[0])
  }

  for (const m of text.matchAll(EMAIL_RE)) {
    if (isPlaceholderEmail(m[0]) || isGithubNoreply(m[0])) continue
    add('email', m.index, m[0])
  }

  for (const m of text.matchAll(PHONE_RE)) {
    if (isFictionalPhone(m[0])) continue
    add('phone', m.index, m[0])
  }

  for (const m of text.matchAll(PATH_RE)) {
    if (m[0].startsWith('/opt/') && GENERIC_OPT_PREFIXES.has(m[1])) continue
    add('path-home', m.index, m[0])
  }

  for (const m of text.matchAll(HEX_RE)) {
    const token = m[0].toLowerCase()
    if (allow.hex.has(token) || isRepeatedPattern(token)) continue
    add('hex-blob', m.index, m[0])
  }

  for (const m of text.matchAll(UUID_RE)) {
    if (SYNTHETIC_UUID_RE.test(m[0])) continue
    add('uuid', m.index, m[0])
  }

  for (const m of text.matchAll(HOST_RE)) {
    const raw = m[0]
    const host = raw.toLowerCase()
    if (OCTETS_RE.test(host)) continue
    const labels = host.split('.')
    const last = labels[labels.length - 1]
    if (last === 'local') { add('hostname-local', m.index, raw); continue }
    if (last === 'internal') { add('hostname-internal', m.index, raw); continue }
    if (last === 'net' && labels[labels.length - 2] === 'ts') { add('hostname-tailnet', m.index, raw); continue }
    if (!TLDS.has(last)) continue
    if (RESERVED_TLDS.has(last) || labels.some((label) => RESERVED_LABELS.has(label))) continue
    if (labels.includes('ezolabs')) continue // the brand is public
    if (CODE_CHAINS.has(host)) continue
    if (labels[0].length < 3) continue // `x.dev`, `at.top`, `l.app`: a property chain, not a host
    if (labels.length === 2 && FILE_EXT_TLDS.has(last)) continue // `intake.sh`, `read-one.sh`: a file name
    if (hostAllowed(host, allow)) continue
    add('hostname-public', m.index, raw)
  }

  return findings
}

// ---- tier 2 --------------------------------------------------------------------------------------------------------------

function scanTier2(text, file, envEntries) {
  const findings = []
  const starts = lineStarts(text)
  const add = (rule, index, token) => {
    const { line, column } = positionOf(starts, index)
    findings.push({ tier: 2, rule, file, line, column, token, message: RULE_TEXT[rule] })
  }
  // The brand is public, so its words never reach the list: blanking them keeps `ezolabs` from matching a fragment entry
  // and keeps the intent of the allowlist explicit in code rather than implied by the list's contents.
  const masked = text.replace(BRAND_RE, (all) => ' '.repeat(all.length))

  for (const entry of envEntries) {
    // A prefix entry (`abc*`) has a leading boundary only and reports the whole name it starts: the prefix runs into the rest
    // of the identifier (`AbcWedge`, `ABC_TOKEN`), where a trailing boundary would miss it.
    const prefix = entry.endsWith('*')
    const word = (prefix ? entry.slice(0, -1) : entry).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = prefix
      ? new RegExp(`(?<![A-Za-z0-9])${word}[A-Za-z0-9_-]*`, 'gi')
      : new RegExp(`(?<![A-Za-z0-9_-])${word}(?![A-Za-z0-9_-])`, 'gi')
    for (const m of masked.matchAll(re)) add('denylist', m.index, m[0])
  }

  return findings
}

// ---- the built client bundle ---------------------------------------------------------------------------------------------

// Config values the browser must never receive: every source's host (or host:port when the URL names a port) and every
// `*Env` name in the example config and in the fixtures beside it. This is the UptimeFlare class of bug: the server config
// module gets compiled into the client bundle and the served JavaScript names the private hosts.
function configValuesOf(configFiles) {
  const values = []
  const visit = (value, key) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key)
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const [k, v] of Object.entries(value)) {
        if (/Env$/.test(k) && typeof v === 'string' && v !== '') values.push({ kind: 'env', value: v })
        if (k === 'url' && typeof v === 'string') {
          try {
            const url = new URL(v)
            const host = url.hostname.toLowerCase()
            if (host === '') continue
            values.push({ kind: 'host', value: url.port === '' ? host : `${host}:${url.port}` })
          } catch {
            // not a URL: nothing to check
          }
        }
        visit(v, k)
      }
      return
    }
  }
  for (const file of configFiles) {
    let json
    try {
      json = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    visit(json, '')
  }
  const seen = new Set()
  return values.filter(({ kind, value }) => {
    const key = `${kind}:${value}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function scanBundle(root, distFiles, configFiles, findings) {
  if (distFiles.length === 0) return { scanned: 0 }
  const values = configValuesOf(configFiles)
  if (values.length === 0) return { scanned: 0 }
  let scanned = 0
  for (const rel of distFiles) {
    const text = readText(root, rel)
    if (text === null) continue
    scanned++
    const starts = lineStarts(text)
    const lower = text.toLowerCase()
    for (const { kind, value } of values) {
      const needle = kind === 'env' ? value : value.toLowerCase()
      const at = kind === 'env' ? text.indexOf(needle) : lower.indexOf(needle)
      if (at < 0) continue
      // A host must be a whole name or host:port, not the tail of a longer one.
      if (kind === 'host') {
        const before = lower[at - 1] ?? ''
        const after = lower[at + needle.length] ?? ''
        if (/[a-z0-9.-]/.test(before) || /[a-z0-9.-]/.test(after)) continue
      }
      const { line, column } = positionOf(starts, at)
      findings.push({ tier: 1, rule: 'bundle-config', file: rel, line, column, token: value, message: `${RULE_TEXT['bundle-config']} (${kind})` })
    }
  }
  return { scanned }
}

// ---- the commit messages -------------------------------------------------------------------------------------------------

const ZERO_SHA = /^0{40}$/

// The revisions `git log` reads: no range (all), or the new commits of a push or pull request. A range whose start is the all-zero
// sha of a first push, or that names a base this clone does not have, reads all of them rather than none: a gate that cannot see
// the history must not report it clean.
function revsOf(range) {
  if (typeof range !== 'string' || range === '') return []
  const [from, to = ''] = range.split('..')
  if (ZERO_SHA.test(from) || from === '') return to === '' || ZERO_SHA.test(to) ? [] : [to]
  return [range]
}

// Each commit as the three texts the gate reads: the message, and the author and the committer as `name <email>`. An identity
// is as public as the message once the history is pushed, and a clean message does not make an internal address clean.
function commits(root, range) {
  const revs = revsOf(range)
  try {
    const out = execFileSync('git', ['-C', root, 'log', ...revs, '--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const records = []
    for (const record of out.split('\x1e')) {
      const trimmed = record.replace(/^\n+/, '')
      if (trimmed === '') continue
      const fields = trimmed.split('\x1f')
      if (fields.length < 6) continue
      const [sha, authorName, authorEmail, committerName, committerEmail] = fields
      records.push({
        sha: sha.trim(),
        author: `${authorName} <${authorEmail}>`,
        committer: `${committerName} <${committerEmail}>`,
        body: fields.slice(5).join('\x1f')
      })
    }
    return records
  } catch {
    if (revs.length > 0) return commits(root, null)
    return []
  }
}

// ---- the gate ------------------------------------------------------------------------------------------------------------

function scan(options = {}) {
  const root = resolve(options.root ?? process.cwd())
  const env = options.env ?? process.env
  const allowPath = options.allow ?? join(root, 'scripts/leak-allow.txt')
  const allow = readAllowlist(allowPath)
  const envEntries = readEnvDenylist(env)
  const requireDenylist = options.requireDenylist === true
  if (requireDenylist && envEntries.length === 0) {
    throw new UnusableError('leak.denylist-missing', '--require-denylist was given but LEAK_DENYLIST and LEAK_DENYLIST_FILE name no token')
  }

  const findings = []
  const stats = { files: 0, bytes: 0, commits: 0, distFiles: 0, tier1: 0, tier2: 0, skipped: 0, acceptedCommits: 0, acceptedFindings: 0, denylistSkipped: envEntries.length === 0 }

  // The tree in full; then the built output by tier 2 and the config rule only (see the note at the top of the file).
  const distFiles = options.dist === false ? [] : listDistFiles(root)
  for (const rel of listTreeFiles(root)) {
    const text = readText(root, rel)
    if (text === null) { stats.skipped++; continue }
    stats.files++
    stats.bytes += text.length
    const scannedText = rel.endsWith('package-lock.json') ? blankLockValues(text) : text
    findings.push(...scanTier1(scannedText, rel, allow))
    findings.push(...scanTier2(scannedText, rel, envEntries))
  }
  for (const rel of distFiles) {
    const text = readText(root, rel)
    if (text === null) { stats.skipped++; continue }
    stats.files++
    stats.bytes += text.length
    findings.push(...scanTier2(text, rel, envEntries))
  }

  if ((options.history ?? 'all') !== 'none') {
    const range = (options.history ?? 'all') === 'range' ? (options.range ?? env.LEAK_HISTORY_RANGE) : null
    for (const { sha, author, committer, body } of commits(root, range)) {
      stats.commits++
      // A listed commit is already public: its tier-1 findings are counted, not reported. Tier 2 reads it as any other.
      const listed = allow.commits.has(sha.toLowerCase())
      if (listed) stats.acceptedCommits++
      for (const [label, text] of [[`<git-log>:${sha}`, body], [`<git-author>:${sha}`, author], [`<git-committer>:${sha}`, committer]]) {
        const tier1 = scanTier1(text, label, allow)
        if (listed) stats.acceptedFindings += tier1.length
        else findings.push(...tier1)
        findings.push(...scanTier2(text, label, envEntries))
      }
    }
  }

  // The config rule reads the client bundle only: dist/web/** is what a browser downloads, and it is the only place a build-time
  // config module can leak a source host to. dist/cli and dist/server are the process that reads that config.
  const webBundle = distFiles.filter((rel) => rel.startsWith('dist/web/'))
  if (webBundle.length > 0) {
    const configFiles = []
    const example = options.config ?? join(root, 'config/watch.example.json')
    if (existsSync(example)) configFiles.push(example)
    const fixtures = join(root, 'test/fixtures/watch.config.json')
    if (existsSync(fixtures)) configFiles.push(fixtures)
    const bundle = scanBundle(root, webBundle, configFiles, findings)
    stats.distFiles = bundle.scanned
  }

  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.column - b.column))
  stats.tier1 = findings.filter((f) => f.tier === 1).length
  stats.tier2 = findings.filter((f) => f.tier === 2).length
  return { ok: findings.length === 0, findings, stats }
}

function report(result, opts) {
  const { findings, stats } = result
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: result.ok, findings, stats }, null, 2) + '\n')
    return
  }
  if (opts.github) {
    for (const f of findings) {
      const file = f.file.startsWith('<git-') ? '' : ` file=${f.file},line=${f.line},col=${f.column}`
      process.stdout.write(`::error${file},title=leak-scan: ${f.rule}::${f.message}: ${f.token}\n`)
    }
  } else {
    for (const f of findings) process.stdout.write(`${f.file}:${f.line}:${f.column}: [${f.rule}] ${f.message}: ${f.token}\n`)
  }
  if (!opts.quiet) {
    const where = `${stats.files} files (${stats.skipped} binary or unreadable skipped), ${stats.commits} commits`
    const dist = stats.distFiles > 0 ? `, ${stats.distFiles} built files` : ''
    const accepted = stats.acceptedCommits > 0
      ? `, ${stats.acceptedFindings} tier-1 finding${stats.acceptedFindings === 1 ? '' : 's'} accepted in ${stats.acceptedCommits} listed commit${stats.acceptedCommits === 1 ? '' : 's'}`
      : ''
    const skipped = stats.denylistSkipped ? ', tier 2 skipped: LEAK_DENYLIST and LEAK_DENYLIST_FILE name no token' : ''
    process.stdout.write(
      findings.length === 0
        ? `leak-scan: clean — ${where}${dist}${accepted}${skipped}\n`
        : `leak-scan: ${findings.length} finding${findings.length === 1 ? '' : 's'} (tier 1: ${stats.tier1}, tier 2: ${stats.tier2}) in ${where}${dist}${accepted}${skipped}\n`
    )
  }
}

function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`leak-scan: ${error.message}\n\n${USAGE}\n`)
      return EXIT_USAGE
    }
    throw error
  }
  if (opts.help) {
    process.stdout.write(USAGE + '\n')
    return EXIT_CLEAN
  }
  try {
    const result = scan({ root: opts.root, allow: opts.allow, requireDenylist: opts.requireDenylist, config: opts.config, history: opts.history, range: opts.range, dist: opts.dist })
    report(result, opts)
    return result.ok ? EXIT_CLEAN : EXIT_FINDINGS
  } catch (error) {
    if (error instanceof UnusableError) {
      if (opts.json) process.stdout.write(JSON.stringify({ ok: false, code: error.code, error: error.message, findings: [], stats: {} }, null, 2) + '\n')
      else process.stderr.write(`leak-scan: ${error.code}: ${error.message}\n`)
      return EXIT_UNUSABLE
    }
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}

export { scan, scanTier1, scanTier2, parseArgs, main, EXIT_CLEAN, EXIT_FINDINGS, EXIT_USAGE, EXIT_UNUSABLE }
