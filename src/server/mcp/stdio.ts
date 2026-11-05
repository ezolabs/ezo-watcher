// `watcher mcp`: the same sixteen tools as HTTP /mcp, served over stdio (StdioServerTransport), for a client that starts a
// process instead of speaking Streamable HTTP. The bridge owns no state and starts no engine: every tool call is forwarded to
// the project's running Watcher at its own /mcp with WATCHER_MCP_TOKEN, so the wall stays the single writer.
//
// The tool list, titles, descriptions and input schemas come from TOOLS, the same table server.ts registers, so the stdio
// surface cannot drift from the HTTP one. A Watcher that is not running is not an error at startup: the client still gets
// `initialize` and `tools/list` (both local), and every call answers with a clear error naming `watcher run --detach`.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { TOOLS } from './tools.ts'
import { serverInfoOf } from './server.ts'
import { DEFAULT_BRAND } from '../../shared/instance.ts'
import type { Brand } from '../../shared/types.ts'

export interface StdioBridgeOptions {
  /** The running Watcher's /mcp endpoint, for example http://127.0.0.1:7717/mcp. */
  url: string
  /** WATCHER_MCP_TOKEN from the project's .watcher/.env. Empty is answered as a configuration error on each call. */
  token: string
  /** The project's brand, so the client sees the same server name and title as the HTTP endpoint. */
  brand?: Brand
  /** A diagnostic line to stderr. Never a token. */
  log?: (line: string) => void
}

/** `verify_fix` may wait 300 seconds for a source; the bridge outlasts it. */
const BRIDGE_TIMEOUT_MS = 360_000

interface RpcAnswer {
  result?: unknown
  error?: { code?: number; message?: string }
}

/** A message a person can act on. It never carries the token or the upstream body. */
export class BridgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeError'
  }
}

let rpcId = 0

async function forward(opts: StdioBridgeOptions, method: string, params: unknown): Promise<unknown> {
  if (opts.token.trim() === '') {
    throw new BridgeError('WATCHER_MCP_TOKEN is not set. Run `watcher init` in the project, or put the server\'s token in .watcher/.env, then start the Watcher with `watcher run --detach`.')
  }
  let res: Response
  try {
    res = await fetch(opts.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: (rpcId += 1), method, params }),
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS)
    })
  } catch (err) {
    const why = err instanceof Error && err.name === 'TimeoutError' ? 'did not answer in time' : 'is not running'
    throw new BridgeError(`the Watcher at ${opts.url} ${why}. Start it with \`watcher run --detach\`, then try again.`)
  }
  const text = await res.text().catch(() => '')
  if (res.status === 401) {
    throw new BridgeError(`the Watcher at ${opts.url} refused the token in WATCHER_MCP_TOKEN. Set it in .watcher/.env to the value the server was started with (watcher init wrote one), or restart the server.`)
  }
  if (res.status !== 200) {
    throw new BridgeError(`the Watcher at ${opts.url} answered HTTP ${res.status}. Read .watcher/data/watcher.log, then try again.`)
  }
  let answer: RpcAnswer
  try {
    answer = JSON.parse(text) as RpcAnswer
  } catch {
    throw new BridgeError(`the Watcher at ${opts.url} answered something that is not JSON-RPC. Read .watcher/data/watcher.log.`)
  }
  if (answer.error) throw new BridgeError(answer.error.message ?? `${method} failed inside the Watcher`)
  return answer.result
}

/** What the client reads: the tool descriptions say "EZO Watcher", which on another Watch is that Watch's name (as server.ts does). */
const branded = (text: string, name: string): string => (name === DEFAULT_BRAND.name ? text : text.replaceAll(DEFAULT_BRAND.name, name))

/** The stdio server: every tool in TOOLS, each call forwarded to the running Watcher. */
export function buildStdioServer(opts: StdioBridgeOptions): McpServer {
  const info = serverInfoOf(opts.brand)
  const server = new McpServer(info, {
    instructions: `${info.title} over stdio: every tool call is forwarded to the running Watcher at ${opts.url}, so the wall stays the single writer. If it is not running, start it with \`watcher run --detach\`. Read freely; every write needs \`by\` ("agent: <who>"), and every write is attributed. Use get_fix_context before fixing an incident and verify_fix after the fix is live.`
  })
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      { title: t.title, description: branded(t.description, info.title), inputSchema: t.shape, annotations: { title: t.title, ...t.hints } },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        try {
          const result = await forward(opts, 'tools/call', { name: t.name, arguments: args ?? {} })
          return result as CallToolResult
        } catch (err) {
          const message = err instanceof BridgeError ? err.message : 'the bridge hit an error inside Watch. Read the incident again before repeating a write: it may have landed.'
          opts.log?.(`stdio: ${t.name} failed: ${message}`)
          return { content: [{ type: 'text' as const, text: message }], isError: true }
        }
      }
    )
  }
  return server
}

/**
 * Run until the client closes stdin. Returns when the transport closes; the process then exits on its own. A startup that
 * cannot reach the Watcher is not a failure: the tool calls say so.
 */
export async function serveStdio(opts: StdioBridgeOptions): Promise<void> {
  const server = buildStdioServer(opts)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve()
    // stdin's end is the client hanging up. Closing the transport removes its listeners, so the process can exit.
    process.stdin.once('end', () => void transport.close().catch(() => resolve()))
  })
  await server.close().catch(() => undefined)
}
