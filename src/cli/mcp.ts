// `watcher mcp`: the stdio bridge (src/server/mcp/stdio.ts) against this project's running Watcher.
//
// The verb writes nothing to stdout: stdout is the MCP transport's channel. Diagnostics go to stderr, and a missing Watcher
// is answered by each tool call (the bridge still lists the tools), never by starting a second engine here.

import type { ParsedArgs } from './util.ts'
import type { Output } from './output.ts'
import { readConfig, resolveProject } from './project.ts'
import { serverRef } from './status.ts'
import { serveStdio } from '../server/mcp/stdio.ts'

export const MCP_SPEC = { valueFlags: ['dir', 'output', 'url'], switchFlags: ['help'] } as const

export async function runMcp(args: ParsedArgs, out: Output): Promise<number> {
  void out
  const project = resolveProject(args.dir)
  const read = readConfig(project)
  const ref = serverRef(args, read.ok ? read.config : null)
  const url = `${ref.base}/mcp`
  const token = process.env.WATCHER_MCP_TOKEN ?? ''
  process.stderr.write(`watcher mcp: stdio bridge to ${url}${token === '' ? ' (WATCHER_MCP_TOKEN is not set in .watcher/.env)' : ''}\n`)
  await serveStdio({ url, token, brand: read.ok ? read.config.brand : undefined, log: (line) => process.stderr.write(`${line}\n`) })
  return 0
}
