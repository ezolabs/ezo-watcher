// File channel: one JSON line per notification appended to a path under the project. No credential,
// no network, no vendor — the channel a headless install can always prove, so an install never ends
// with zero channels because every credential-bound one was skipped. `watcher test-alert` writes a
// line here like any other channel, and a route that names it delivers for real; the file is the
// record (kind, title, body, severity, the wall link and the ack link), so `tail -f` and `jq` are
// the reader. `.watcher/data/` is gitignored with the rest of the watcher's state.

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { FileChannelConfig } from '../../config.ts'
import type { Channel } from '../types.ts'
import { guarded, stripControl } from './common.ts'
import type { ChannelDeps } from './common.ts'

/** Where a `file` channel writes when the config names no path: under the project's data dir. */
export const DEFAULT_FILE_PATH = '.watcher/data/alerts.jsonl'

export function createFileChannel(cfg: FileChannelConfig, deps: ChannelDeps): Channel {
  // Resolved once, at construction: the server runs with the project as its working directory, and a
  // relative path must mean the project's file, not wherever a later request happens to run.
  const path = resolve(deps.cwd ?? process.cwd(), cfg.path ?? DEFAULT_FILE_PATH)
  return {
    id: cfg.id,
    type: 'file',
    send: (msg, signal) =>
      guarded(deps, signal, async () => {
        const line = JSON.stringify({
          at: new Date(deps.now()).toISOString(),
          kind: msg.kind,
          title: stripControl(msg.title),
          body: stripControl(msg.body),
          severity: msg.severity,
          tag: msg.tag,
          url: msg.url,
          ...(msg.ackUrl ? { ackUrl: msg.ackUrl } : {}),
          ...(msg.service ? { service: msg.service } : {}),
          ...(msg.rule ? { rule: msg.rule } : {})
        })
        await mkdir(dirname(path), { recursive: true })
        await appendFile(path, `${line}\n`, { mode: 0o600 })
        // The status never carries the path: a result is logged beside the incident and the path is the user's.
        return { ok: true, status: 'appended' }
      })
  }
}
