// The body of the incident sheet, told as a story: what happened, where, the evidence inline, what to do, then the
// debug material folded away. One alert speaks (the worst instance, or the one the person opened). Every section is
// derived by src/shared/story.ts, which has a fallback for every field, so no section is ever shown empty.

import { Box, ChevronRight, Globe, Layers, RadioTower, Server } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useId } from 'react'
import type { ReactNode } from 'react'
import type { ChipKind, Story } from '../../shared/story.ts'
import type { Alert } from '../../shared/types.ts'
import { durationText, stampText } from '../lib/format.ts'
import { LinkControl, Terminal } from './Evidence.tsx'
import { WhatHappened } from './SheetDetail.tsx'

const CHIP_ICON: Record<ChipKind, LucideIcon> = {
  host: Server,
  service: Layers,
  env: Globe,
  namespace: Globe,
  cluster: Globe,
  component: Box,
  source: RadioTower
}

/** Text with `backticked` runs drawn as inline code: the sweep writes its commands that way inside a step or a sentence. */
export function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(/`([^`\n]+)`/).map((part, k) => (k % 2 === 1 ? <code key={k}>{part}</code> : part))}
    </>
  )
}

/** A titled block of the sheet. The title is the section's accessible name. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section className="section" aria-labelledby={id}>
      <h3 className="section__title" id={id}>
        {title}
      </h3>
      {children}
    </section>
  )
}

/** When it started and for how long, and who saw it: the always-present part of the evidence. */
function factsText(a: Alert, nowMs: number): string {
  const seen = [...new Set(a.via.map((v) => v.source))].join(', ')
  const span = a.resolvedAt
    ? `Started ${stampText(a.startsAt)}, resolved ${stampText(a.resolvedAt)} after ${durationText((Date.parse(a.resolvedAt) - Date.parse(a.startsAt)) / 1000)}.`
    : `Started ${stampText(a.startsAt)}, firing for ${durationText((nowMs - Date.parse(a.startsAt)) / 1000)}.`
  return seen ? `${span} Seen by ${seen}.` : span
}

/** What happened, Where, Evidence, What to do: the first blocks of the sheet, in that order. */
export function StoryBlocks({ story, alert, nowMs }: { story: Story; alert: Alert; nowMs: number }) {
  const evidenceLinks = [...story.links.source, ...story.links.evidence]
  const todoLinks = [...story.links.runbook, ...story.links.reference]
  const ev = story.evidence
  return (
    <>
      <Section title="What happened">
        <WhatHappened text={story.what.paragraphs.join('\n\n')} />
      </Section>

      <Section title="Where">
        <ul className="chips" aria-label="Where it runs">
          {story.chips.map((c) => {
            const Icon = CHIP_ICON[c.kind]
            return (
              <li key={c.kind}>
                <span className="chip" data-kind={c.kind}>
                  <Icon aria-hidden="true" />
                  <span className="sr-only">{c.label}: </span>
                  {c.text}
                </span>
              </li>
            )
          })}
        </ul>
        <p className="prose">{story.where}</p>
      </Section>

      <Section title="Evidence">
        {(ev.command !== undefined || ev.output !== undefined) && <Terminal command={ev.command} output={ev.output} clipped={ev.clipped} />}
        {ev.values.length > 0 && (
          <dl className="kv vals" aria-label="Firing values">
            {ev.values.map((v) => (
              <div key={v.name} style={{ display: 'contents' }}>
                <dt>{v.name === 'Value' ? 'Firing value' : `Value ${v.name}`}</dt>
                <dd>{v.value}</dd>
              </div>
            ))}
            {ev.threshold && (
              <>
                <dt>Threshold</dt>
                <dd>{ev.threshold}</dd>
              </>
            )}
          </dl>
        )}
        <p className="note">{factsText(alert, nowMs)}</p>
        {evidenceLinks.length > 0 && (
          <div className="actions">
            {evidenceLinks.map((l) => (
              <LinkControl key={l.id} link={l} />
            ))}
          </div>
        )}
      </Section>

      {(story.steps.length > 0 || todoLinks.length > 0) && (
        <Section title="What to do">
          {story.steps.length > 0 && (
            <ol className="steps">
              {story.steps.map((s, k) => (
                <li key={k}>
                  <Inline text={s} />
                </li>
              ))}
            </ol>
          )}
          {todoLinks.length > 0 && (
            <div className="actions">
              {todoLinks.map((l) => (
                <LinkControl key={l.id} link={l} />
              ))}
            </div>
          )}
        </Section>
      )}
    </>
  )
}

/** A native disclosure with a chevron: closed by default, so the debug material is one tap away and out of the way. */
function Fold({ id, title, count, children }: { id: string; title: string; count: number; children: ReactNode }) {
  return (
    <details className="fold" id={id}>
      <summary>
        <ChevronRight aria-hidden="true" />
        {title} ({count})
      </summary>
      <div className="fold__body">{children}</div>
    </details>
  )
}

function Pairs({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * Labels (n) and Raw (n), collapsed. Labels holds the labels, the annotations as sent and the fingerprint; Raw holds the
 * payload each source delivered. A fold with nothing in it is not drawn.
 */
export function Disclosures({ alert, speaks }: { alert: Alert; speaks?: string }) {
  const labels = Object.entries(alert.labels)
  const annotations = Object.entries(alert.annotations)
  const raws = Object.entries((alert.raw ?? {}) as Record<string, unknown>)
  return (
    <>
      <Fold id="labels" title="Labels" count={labels.length}>
        {speaks && <p className="note">These belong to the worst instance, {speaks}.</p>}
        <Pairs rows={[['fingerprint', alert.fingerprint], ['state', alert.status.state], ['origin', alert.origin], ...labels]} />
        {annotations.length > 0 && (
          <>
            <h4 className="fold__title">Annotations as sent</h4>
            <Pairs rows={annotations} />
          </>
        )}
      </Fold>
      {raws.length > 0 && (
        <Fold id="raw" title="Raw" count={raws.length}>
          {raws.map(([src, body]) => (
            <div key={src} className="section">
              <p className="note">{src}</p>
              <pre className="raw" tabIndex={0}>
                {JSON.stringify(body, null, 2)}
              </pre>
            </div>
          ))}
        </Fold>
      )}
    </>
  )
}
