// The demo's "What agents see": what an agent reads when it dials this Watcher, live from the wall as the visitor left it. The session brief
// (`watcher status --brief`, which the SessionStart hook runs), the first MCP call (`watch_state`, an excerpt), the way into one incident's
// fix brief (its sheet, opened on the agent view), and the tools. An acknowledgement or a park changes all of it: that is the point.
// Opened by `#/agents`, so a link (and the README's picture) lands on it.

import { ChevronRight, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { summarizeWall } from '../../server/mcp/shape.ts'
import { incidentTitle } from '../../shared/incident.ts'
import { byPhrase } from '../../shared/who.ts'
import type { Attention, WallState } from '../../shared/types.ts'
import { AgentBrief, AgentLoading, CallLine } from '../components/AgentView.tsx'
import { Sheet } from '../components/Sheets.tsx'
import { Section } from '../components/StorySheet.tsx'
import { Glyph, SkeletonRows } from '../components/ui.tsx'
import { useFetch } from '../lib/api.ts'
import { AGENT_TOOLS, BRIEF_COMMAND, mcpCall, mcpText, statusBrief } from '../lib/agent-brief.ts'
import { href } from '../lib/route.ts'

/** The hash that opens the panel. Any other hash is the wall's own route. */
export const AGENTS_HASH = '#/agents'

export const isAgentsHash = (hash: string): boolean => hash === AGENTS_HASH || hash === `${AGENTS_HASH}/`

/** Who has an incident, in the words of a row: the brief's `attention` value, said. */
const ATTENTION_WORDS: Record<Attention, string> = { none: 'unattended', acked: 'acknowledged', silenced: 'silenced', parked: 'parked' }

/**
 * The part of `watch_state` that moves when someone takes an incident: its one line, its counts, and who has each incident. The whole
 * answer (`summarizeWall`, the code the MCP tool runs) also carries the header, each row's 27 fields and the sources.
 */
export function watchStateExcerpt(wall: WallState) {
  const s = summarizeWall(wall, new Map(), '')
  return {
    text: s.text,
    counts: s.counts,
    incidents: s.incidents.map((r) => ({ key: r.key, severity: r.severity, attention: r.attention, ackedBy: r.ackedBy, parkedBy: r.parkedBy, unattendedSec: r.unattendedSec }))
  }
}

/** The panel's body, for a wall: also what the test renders. */
export function AgentPanelBody({ wall }: { wall: WallState | null }) {
  const brief = wall ? statusBrief(wall, Date.parse(wall.generatedAt)) : []
  const reads = AGENT_TOOLS.filter((t) => t.reads).length
  return (
    <>
      <Section title="At the start of every session">
        <p className="note">
          <code>watcher hooks install</code> runs this when a Claude Code session opens (for Codex it goes into AGENTS.md). One line per open
          incident; nothing at all on a quiet wall.
        </p>
        <div className="term agent__term">
          <CallLine via="$" call={BRIEF_COMMAND} what="command" />
          {wall === null ? (
            <AgentLoading />
          ) : brief.length > 0 ? (
            <AgentBrief text={brief.join('\n')} label="What watcher status --brief prints" what="session brief" json={false} />
          ) : (
            <p className="term__note agent__state">It prints nothing: no incident is open.</p>
          )}
        </div>
      </Section>

      <Section title="The first call: watch_state">
        <p className="note">The whole wall in one answer. Here, the part that moves when someone takes an incident: its line, its counts and who has each one.</p>
        <div className="term agent__term">
          <CallLine via="mcp" call={mcpCall('watch_state', {})} what="MCP call" />
          {wall === null ? <AgentLoading /> : <AgentBrief text={mcpText(watchStateExcerpt(wall))} label="An excerpt of what watch_state answers" what="excerpt" />}
        </div>
      </Section>

      <Section title="One incident: get_fix_context">
        <p className="note">Everything needed to fix it without asking a person. Open one to read its brief, character for character.</p>
        {wall === null ? (
          <SkeletonRows n={3} />
        ) : wall.incidents.length === 0 ? (
          <p className="note">
            Nothing is firing, so there is no brief to read.{' '}
            <a className="link" href={href({ view: 'history' })}>
              Open history
            </a>
          </p>
        ) : (
          <div className="rows">
            {wall.incidents.map((i) => (
              <a key={i.key} className="row" href={href({ view: 'wall', incident: i.key, agent: true })} data-tone={i.severity} style={{ textDecoration: 'none' }}>
                <Glyph severity={i.severity} />
                <span>
                  <span className="row__title">{incidentTitle(i)}</span>
                  <br />
                  <span className="row__sub">
                    {i.service}, {ATTENTION_WORDS[i.state.attention]}
                    {i.state.attention === 'acked' ? byPhrase(i.ackedBy) : i.state.attention === 'parked' ? byPhrase(i.state.park?.by) : ''}
                  </span>
                </span>
                <span className="row__aside agent__go">
                  Its brief
                  <ChevronRight aria-hidden="true" />
                </span>
              </a>
            ))}
          </div>
        )}
      </Section>

      <Section title={`The tools (${AGENT_TOOLS.length})`}>
        <p className="note">
          What an agent finds on the Watcher's MCP endpoint. The first {reads} only read; the other {AGENT_TOOLS.length - reads} act, and the
          wall names the agent that did.
        </p>
        <dl className="agent__tools">
          {AGENT_TOOLS.map((t) => (
            <div key={t.name} className="agent__tool">
              <dt>
                <code>{t.name}</code>
              </dt>
              <dd>{t.line}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </>
  )
}

/** The panel: the app's own sheet, over the wall. Closing it goes back to the wall. */
export function AgentPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data } = useFetch<WallState>(open ? '/api/state' : null, 5000)
  return (
    <Sheet open={open} onClose={onClose} titleId="agents-title">
      <div className="sheet__body">
        <div className="sheet__head">
          <div className="sheet__bar">
            <span className="note">Demo</span>
            <button type="button" className="btn" onClick={onClose}>
              <X aria-hidden="true" />
              Close
            </button>
          </div>
          <h2 className="sheet__title" id="agents-title">
            What agents see
          </h2>
          <p className="note">
            An agent dials the Watcher through MCP or the CLI and reads plain text. This is that text, live from the wall behind this panel:
            acknowledge or park an incident and it changes here.
          </p>
        </div>
        <AgentPanelBody wall={data} />
      </div>
    </Sheet>
  )
}

/** The panel as the demo mounts it: open while the hash is `#/agents`; its Close (and Escape) go back to the wall. */
export function DemoAgents() {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const on = (): void => setHash(location.hash)
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return <AgentPanel open={isAgentsHash(hash)} onClose={() => (location.hash = href({ view: 'wall' }))} />
}
