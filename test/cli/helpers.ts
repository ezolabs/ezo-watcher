// Shared helpers for the CLI tests. Every test writes under a fresh mkdtemp directory (never the
// real home), captures the CLI's output streams, and restores process.env after itself.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Output } from '../../src/cli/output.ts'
import type { OutputFormat } from '../../src/cli/output.ts'
import { parseArgs } from '../../src/cli/util.ts'
import type { ParsedArgs } from '../../src/cli/util.ts'

export interface Capture {
  out: Output
  stdout(): string
  stderr(): string
  reset(): void
}

export function capture(format: OutputFormat = 'json'): Capture {
  let out = ''
  let err = ''
  const stdout = { write: (chunk: string) => { out += chunk; return true }, isTTY: false } as unknown as NodeJS.WriteStream
  const stderr = { write: (chunk: string) => { err += chunk; return true }, isTTY: false } as unknown as NodeJS.WriteStream
  return {
    out: new Output(format, stdout, stderr, false),
    stdout: () => out,
    stderr: () => err,
    reset: () => { out = ''; err = '' }
  }
}

/** A temp project directory. `t.after` cleanup is the caller's job (rmTemp). */
export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `watcher-cli-${prefix}-`))
}

export function rmTemp(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** Parse argv for a verb's spec, the way main.ts does. */
export function parse(argv: string[], spec: { valueFlags: readonly string[]; switchFlags?: readonly string[]; subVerbs?: readonly string[] }): ParsedArgs {
  return parseArgs(argv, { valueFlags: [...spec.valueFlags], switchFlags: spec.switchFlags ? [...spec.switchFlags] : undefined, subVerbs: spec.subVerbs ? [...spec.subVerbs] : undefined })
}

/** Save the WATCHER_ and CLOUDFLARE_ keys of process.env and give them back. */
export class EnvGuard {
  private readonly saved = new Map<string, string | undefined>()
  constructor(keys: string[]) {
    for (const k of keys) this.saved.set(k, process.env[k])
  }
  set(vars: Record<string, string | undefined>): void {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  restore(): void {
    for (const [k, v] of this.saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

export const WATCHER_KEYS = [
  'WATCHER_ACK_SECRET', 'WATCHER_ADMIN_TOKEN', 'WATCHER_MCP_TOKEN', 'WATCHER_PORT', 'WATCHER_HOST',
  'WATCHER_CONFIG', 'WATCHER_DATA_DIR', 'WATCHER_WEB_DIR', 'WATCHER_EMBED_ORIGINS', 'WATCHER_SKILLS_ROOT',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_TUNNEL_TOKEN', 'HOME'
]

/** A free port on 127.0.0.1, found by binding and releasing one. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

export interface FakeServer {
  url: string
  port: number
  requests: Array<{ method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }>
  close(): Promise<void>
  setHandler(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: string) => void): void
}

/** A tiny HTTP server a test can script. Records every request for assertions. */
export async function fakeServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: string) => void): Promise<FakeServer> {
  let current = handler
  const requests: FakeServer['requests'] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body })
      current(req, res, body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    setHandler: (h) => { current = h },
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

/** Read a JSON file as a typed record. */
export function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

export function writeText(path: string, text: string): void {
  writeFileSync(path, text)
}
