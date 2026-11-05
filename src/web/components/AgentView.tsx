// "What your agent sees", in the incident sheet: the fix brief exactly as the MCP tool `get_fix_context` answers it, the call that
// fetches it, and the CLI's way to the same brief. A fold, closed until asked for, and read only while it is open.

import { ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useFetch } from '../lib/api.ts'
import { cliFixContext, fixContextPath, mcpCall, mcpText } from '../lib/agent-brief.ts'
import { CopyButton } from './Evidence.tsx'

/** One call line on the brief's surface: the way the call is made (`mcp`, or `$` for a shell), the call, and its Copy. */
export function CallLine({ via, call, what }: { via: string; call: string; what: string }) {
  const [message, setMessage] = useState('')
  return (
    <div className="term__cmd">
      <span className="term__prompt" aria-label={via === '$' ? 'shell' : via}>
        {via}
      </span>
      <code className="term__text">{call}</code>
      <CopyButton text={call} what={what} onResult={setMessage} />
      <span className="sr-only" role="status">
        {message}
      </span>
    </div>
  )
}

/**
 * The text an agent reads, whole: monospaced, scrolling past `--agent-lines`, with its own Copy under it. JSON wraps its long strings and
 * says how long it is (most of it is below the fold); a command's lines (`json` false) wrap under a hanging indent, so each still reads as
 * one line.
 */
export function AgentBrief({ text, label, what = 'brief', json = true }: { text: string; label: string; what?: string; json?: boolean }) {
  const [message, setMessage] = useState('')
  return (
    <>
      <pre className={json ? 'term__out agent__out' : 'term__out agent__out agent__out--lines'} role="region" aria-label={label} tabIndex={0}>
        {json
          ? text
          : text.split('\n').map((line, n) => (
              // keyed by place: lines of one text, in order, and two may be the same
              <span key={n} className="agent__line">
                {line}
              </span>
            ))}
      </pre>
      <div className="agent__foot">
        {json && <span className="agent__count num">{text.split('\n').length} lines of JSON</span>}
        <CopyButton text={text} what={what} onResult={setMessage} />
        <span className="sr-only" role="status">
          {message}
        </span>
      </div>
    </>
  )
}

/**
 * The sheet's fold. `revision` is what a person can change from the sheet (who has the incident): the brief says it too, so a change reads
 * the brief again at once instead of at the next poll. `asked` is the route's `agent` flag (`#/i/<key>/agent`): the fold opens and scrolls
 * into view, on the sheet's first paint or when a link asks while the sheet is already open.
 */
export function AgentFold({ incidentKey, asked, revision }: { incidentKey: string; asked: boolean; revision: string }) {
  const [open, setOpen] = useState(asked)
  const ref = useRef<HTMLDetailsElement>(null)
  const { data, error, reload } = useFetch<unknown>(open ? fixContextPath(incidentKey) : null, 5000)
  const seen = useRef(revision)
  useEffect(() => {
    if (seen.current === revision) return
    seen.current = revision
    if (open) reload()
  }, [revision, open, reload])
  useEffect(() => {
    if (!asked) return
    setOpen(true)
    ref.current?.scrollIntoView({ block: 'start' })
  }, [asked])
  return (
    <details className="fold agent" id="agent" ref={ref} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <ChevronRight aria-hidden="true" />
        What your agent sees
      </summary>
      <AgentFoldBody incidentKey={incidentKey} brief={data} error={error} reading={open} />
    </details>
  )
}

/** Loading lines in the brief's place, on its surface. */
export function AgentLoading() {
  return (
    <div className="agent__loading" role="status" aria-label="Reading what the agent sees">
      {['92%', '64%', '78%'].map((w) => (
        <div key={w} className="skeleton skel-line" style={{ width: w }} aria-hidden="true" />
      ))}
    </div>
  )
}

/** The fold's inside, for one answer of the fix-context read: the brief once it is in, why it is not, or its loading lines while `reading`. */
export function AgentFoldBody({ incidentKey, brief, error, reading }: { incidentKey: string; brief: unknown; error: string | null; reading: boolean }) {
  return (
    <div className="fold__body">
      <p className="note">
        An agent fixing this reads one brief: the source and its config, the check that failed, the last good and last bad answer, and the
        commands that check it again. This is that brief, character for character.
      </p>
      <div className="term agent__term">
        <CallLine via="mcp" call={mcpCall('get_fix_context', { key: incidentKey })} what="MCP call" />
        {brief !== null ? (
          <AgentBrief text={mcpText(brief)} label="The brief get_fix_context answers" />
        ) : error ? (
          <p className="term__note agent__state">
            {error === '404' ? 'The Watcher no longer holds this incident, so there is no brief for it.' : 'The brief could not be read. It is tried again every few seconds.'}
          </p>
        ) : (
          reading && <AgentLoading />
        )}
      </div>
      <p className="note">From a shell, the same brief:</p>
      <div className="term">
        <CallLine via="$" call={cliFixContext(incidentKey)} what="command" />
      </div>
    </div>
  )
}
