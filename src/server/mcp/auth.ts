// The one gate in front of /mcp: `Authorization: Bearer <WATCHER_MCP_TOKEN>`. The token is compared by digest in constant time. A host with no
// token configured, or one shorter than MIN_TOKEN_CHARS, refuses every request: the endpoint is never open, and never answers "not configured"
// differently from "wrong token", so a probe learns nothing. The token is never logged, echoed or put in an error.

import { createHash, timingSafeEqual } from 'node:crypto'

/** `openssl rand -hex 32` is 64 characters; anything under 32 is not a token worth trusting with writes. */
export const MIN_TOKEN_CHARS = 32

const digest = (text: string): Buffer => createHash('sha256').update(text).digest()

/** The bearer token of an Authorization header, or null when the header is not `Bearer <token>`. */
export function bearerOf(header: string | null | undefined): string | null {
  if (typeof header !== 'string') return null
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header)
  return m ? m[1] : null
}

/** True only for the configured token. False when none is configured, when it is too short, and for any other header. */
export function mcpAuthorized(header: string | null | undefined, expected: string | undefined): boolean {
  const want = (expected ?? '').trim()
  if (want.length < MIN_TOKEN_CHARS) return false
  const got = bearerOf(header)
  if (got === null) return false
  return timingSafeEqual(digest(got), digest(want))
}
