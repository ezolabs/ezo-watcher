// The MCP endpoint, over Streamable HTTP (MCP spec 2025-11-25), with @modelcontextprotocol/sdk 1.32.1: `McpServer` for the tools and
// `WebStandardStreamableHTTPServerTransport`, which takes a web-standard Request and answers a Response, so Hono mounts it as it is.
//
// Stateless and JSON: every request gets its own server and transport (the SDK refuses to reuse a stateless transport), nothing is held between
// requests, and the answer is one JSON body, never a stream, so the nginx in front needs nothing special and a restart loses nothing. There is
// no session id and no server-to-client stream: GET and DELETE answer 405.
//
// This is the only file that imports the SDK. The SDK's v1 line is the maintenance line (v2 ships as @modelcontextprotocol/server, with a
// codemod: `npx @modelcontextprotocol/codemod@latest v1-to-v2 .`); moving is a change here.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { DEFAULT_BRAND, resolveBrand } from '../../shared/instance.ts'
import type { Brand } from '../../shared/types.ts'
import { mcpAuthorized } from './auth.ts'
import { TOOLS } from './tools.ts'
import type { McpDeps } from './tools.ts'

const SERVER_INFO = { name: 'ezo-watcher', title: 'EZO Watcher', version: '1.0.0' }

/**
 * The server as this Watch names it (config `brand`): EZO Watcher is `ezo-watcher`, as it always was; another Watch is its brand's name as the title and
 * that name in lower case with dashes as the name (`Infra Wall` is `infra-wall`).
 */
export function serverInfoOf(brand: Brand | undefined): typeof SERVER_INFO {
  const { name } = resolveBrand(brand)
  if (name === DEFAULT_BRAND.name) return { ...SERVER_INFO }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || SERVER_INFO.name
  return { ...SERVER_INFO, name: slug, title: name }
}

/** What the client reads: the tool descriptions and the instructions say "EZO Watcher", which on another Watch is that Watch's name. */
const branded = (text: string, name: string): string => (name === DEFAULT_BRAND.name ? text : text.replaceAll(DEFAULT_BRAND.name, name))

/** A real call is a few hundred bytes; a comment is at most 4000 characters. Anything over this is refused before it is parsed. */
export const MCP_MAX_BODY_BYTES = 64 * 1024
/** One answer is cut here, with a line that says so: an incident with a long history must not fill an agent's context. */
export const MCP_MAX_ANSWER_CHARS = 100_000

const INSTRUCTIONS = [
  'EZO Watcher is the alert wall for the operator infrastructure. Start with watch_state: it lists what is firing and gives the incident keys every other tool takes.',
  'Read freely. Write only as yourself: every write needs `by` ("agent: <who>") and is shown on the tile, in the incident sheet and in History.',
  'Acknowledge an incident while you are actively working it. Comment your findings, links and fix commits. Silence only what is known to be expected, for at most 4 hours, never to quiet a real problem. Park an incident (any source) only after you fixed it or reached a verdict on it, for at most 72 hours, saying why; never to hide a live problem.',
  'You cannot resolve, delete or edit an alert; only its source does. `resolve` marks an incident resolved by hand and Watch reopens it if the source still reports it; `park` is for a fix the source cannot show yet, and does not reopen. After a source resolves an incident, confirm_resolution records that you checked.'
].join(' ')

const clip = (text: string): string => (text.length <= MCP_MAX_ANSWER_CHARS ? text : `${text.slice(0, MCP_MAX_ANSWER_CHARS)}\n... cut at ${MCP_MAX_ANSWER_CHARS} characters; ask for fewer rows or one incident.`)

/** A server with every tool registered, over `d`. One per request. */
export function buildServer(d: McpDeps): McpServer {
  const info = serverInfoOf(d.cfg.brand)
  const server = new McpServer(info, { instructions: branded(INSTRUCTIONS, info.title) })
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      { title: t.title, description: branded(t.description, info.title), inputSchema: t.shape, annotations: { title: t.title, ...t.hints } },
      async (args: Record<string, unknown>) => {
        try {
          const r = await t.run(d, args ?? {})
          return r.ok
            ? { content: [{ type: 'text' as const, text: clip(JSON.stringify(r.data, null, 1)) }] }
            : { content: [{ type: 'text' as const, text: r.error }], isError: true }
        } catch (err) {
          d.log(`mcp: ${t.name} failed (${err instanceof Error ? err.name : 'Error'})`)
          return { content: [{ type: 'text' as const, text: `${t.name} hit an error inside Watch. Read the incident again before repeating a write: it may have landed.` }], isError: true }
        }
      }
    )
  }
  return server
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } })

/**
 * The handler Hono mounts at /mcp. `token` is WATCHER_MCP_TOKEN as the process read it: with none (or a short one) every request is a 401.
 * Authentication comes first, before the method, the body or the SDK are looked at.
 */
export function createMcpHandler(d: McpDeps, token: () => string | undefined): (req: Request) => Promise<Response> {
  return async (req) => {
    if (!mcpAuthorized(req.headers.get('authorization'), token())) {
      return json(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer realm="ezo-watcher-mcp"' })
    }
    if (req.method !== 'POST') {
      return json(405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this MCP server is stateless; POST JSON-RPC to /mcp' }, id: null }, { Allow: 'POST' })
    }
    const server = buildServer(d)
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MCP_MAX_BODY_BYTES })
    try {
      await server.connect(transport)
      return await transport.handleRequest(req)
    } catch (err) {
      d.log(`mcp: request failed (${err instanceof Error ? err.name : 'Error'})`)
      return json(500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
    } finally {
      void transport.close().catch(() => undefined)
      void server.close().catch(() => undefined)
    }
  }
}
