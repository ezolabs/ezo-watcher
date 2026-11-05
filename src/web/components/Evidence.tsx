// The evidence controls of the drill-down: the command and its captured output as one block, the secondary link controls
// of Evidence and What to do, the compact controls of one instance row, and the small "Also in the chat panel" line. They all
// render the models in src/shared/evidence-links.ts and src/shared/story.ts, so the sheet and the notification email offer
// the same links with the same labels. A chat link is a text link at the very bottom, never a button.

import { BookOpen, Check, ChartLine, Copy, ExternalLink } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { evidenceLinks } from '../../shared/evidence-links.ts'
import type { EvidenceKind, EvidenceLink, EvidenceSource } from '../../shared/evidence-links.ts'
import { MAX_OUTPUT_CHARS } from '../../shared/story.ts'
import { readMs } from '../lib/tokens.ts'

const ICON: Record<EvidenceKind, LucideIcon> = {
  source: ChartLine,
  report: ExternalLink,
  runbook: BookOpen,
  evidence: ExternalLink,
  reference: ExternalLink
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * A copy button that acknowledges once: its label becomes "Copied" and a status line says so, then it settles back.
 * `idle` is the visible label at rest; `name` is the accessible name at rest, which starts with that label.
 */
export function CopyButton({ text, what, onResult, idle = 'Copy', name }: { text: string; what: string; onResult: (message: string) => void; idle?: string; name?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = (): void => {
    void copyText(text).then((ok) => {
      onResult(ok ? `Copied the ${what}.` : `Could not copy. Select the ${what} and copy it.`)
      setCopied(ok)
      window.clearTimeout(timer.current)
      if (ok) {
        timer.current = window.setTimeout(() => {
          setCopied(false)
          onResult('')
        }, readMs('--duration-ack'))
      }
    })
  }
  return (
    <button type="button" className="btn" onClick={copy} aria-label={name && !copied ? name : undefined}>
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {copied ? 'Copied' : idle}
      {!name && <span className="sr-only"> the {what}</span>}
    </button>
  )
}

/**
 * The proof, inline: the command that reproduces it with one Copy control, and under it the output it printed in a
 * monospaced block that scrolls past about 12 lines. Command and output share one surface, so the output reads as what
 * the command printed. The command wraps whole (it is the thing a person copies).
 */
export function Terminal({ command, output, clipped }: { command?: string; output?: string; clipped?: boolean }) {
  const [message, setMessage] = useState('')
  return (
    <div className="term">
      {command !== undefined && (
        <div className="term__cmd">
          <span className="term__prompt" aria-hidden="true">
            $
          </span>
          <code className="term__text">{command}</code>
          <CopyButton text={command} what="evidence command" onResult={setMessage} />
          <span className="sr-only" role="status">
            {message}
          </span>
        </div>
      )}
      {output !== undefined && (
        <pre className="term__out" role="region" aria-label="Captured output" tabIndex={0}>
          {output}
        </pre>
      )}
      {clipped && <p className="term__note">Output cut at {MAX_OUTPUT_CHARS / 1024} KB. The full payload is under Raw.</p>}
    </div>
  )
}

/** An instance row's copy control: one labelled button, no command text. The whole command is one tap away on that instance. */
function CopyCommand({ link, forName }: { link: EvidenceLink; forName: string }) {
  const [message, setMessage] = useState('')
  const what = `${link.label.toLowerCase()} for ${forName}`
  return (
    <>
      <CopyButton text={link.text ?? ''} what={what} onResult={setMessage} idle="Copy command" name={`Copy command for ${forName}`} />
      <span className="sr-only" role="status">
        {message}
      </span>
    </>
  )
}

/** A secondary link control: an icon and the label. The label says what the link is ("Open in Grafana", "Runbook"). */
export function LinkControl({ link, compact, forName }: { link: EvidenceLink; compact?: boolean; forName?: string }) {
  const Icon = ICON[link.kind]
  // A compact control shows one word; its accessible name is the full label, which starts with that word.
  return (
    <a className="btn" data-kind={link.kind} href={link.url} target="_blank" rel="noopener noreferrer" aria-label={compact ? `${link.label}${forName ? ` for ${forName}` : ''} (opens in a new tab)` : undefined}>
      <Icon aria-hidden="true" />
      <span>{compact ? link.short : link.label}</span>
      {!compact && <span className="sr-only"> (opens in a new tab)</span>}
    </a>
  )
}

/** The compact controls of one instance row: its own evidence link and its probe command. The chat report is on the instance's own page. */
export function InstanceLinks({ source, name }: { source: EvidenceSource; name: string }) {
  // an instance named by its summary is long: the accessible name of each control keeps the first words of it
  const who = name.length > 40 ? `${name.slice(0, 37)}...` : name
  const links = evidenceLinks(source).filter((l) => l.kind === 'source' || l.kind === 'evidence')
  const urls = links.filter((l) => l.url)
  const cmds = links.filter((l) => l.text !== undefined)
  if (urls.length === 0 && cmds.length === 0) return null
  return (
    <div className="inst__links">
      {urls.map((l) => (
        <LinkControl key={l.id} link={l} compact forName={who} />
      ))}
      {cmds.map((l) => (
        <CopyCommand key={l.id} link={l} forName={who} />
      ))}
    </div>
  )
}

/** The small bottom line: the chat panel report and topic as text links. The page is complete without them. */
export function ChatLine({ links }: { links: EvidenceLink[] }) {
  if (links.length === 0) return null
  return (
    <p className="also">
      Also in the chat panel:{' '}
      {links.map((l, k) => (
        <Fragment key={l.id}>
          {k > 0 && (k === links.length - 1 ? ' and ' : ', ')}
          <a className="link" href={l.url} target="_blank" rel="noopener noreferrer">
            {l.label}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </Fragment>
      ))}
    </p>
  )
}
