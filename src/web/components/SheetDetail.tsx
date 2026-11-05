// The two things the incident sheet leads with: the error itself (the hero, under the title and the actions) and "What happened" as Markdown a
// tired person can scan. Both only draw what src/web/lib/hero.ts and src/shared/markdown.ts decide. The Markdown is drawn as React elements from
// a tree of plain data, so no alert text is ever parsed as HTML (no raw-HTML setter is used in this file or the two it reads).

import { ChevronRight } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { parseMarkdown, scanOf } from '../../shared/markdown.ts'
import type { Block, Inline } from '../../shared/markdown.ts'
import type { Severity } from '../../shared/types.ts'
import type { Hero } from '../lib/hero.ts'
import { CopyButton } from './Evidence.tsx'

/** The error of the alert, large, in the monospaced face: it wraps and is never cut. The facts under it are one compact row, and Copy takes the error. */
export function ErrorHero({ hero, severity }: { hero: Hero; severity: Severity }) {
  const id = useId()
  const [message, setMessage] = useState('')
  return (
    <section className="hero" aria-labelledby={id} data-tone={severity} data-kind={hero.kind}>
      <h3 className="sr-only" id={id}>
        The error
      </h3>
      <div className="hero__head">
        <p className="hero__line">{hero.line}</p>
        <CopyButton text={hero.copy} what="error" onResult={setMessage} />
        <span className="sr-only" role="status">
          {message}
        </span>
      </div>
      {hero.facts.length > 0 && (
        <dl className="hero__facts" aria-label="About the error">
          {hero.facts.map((f) => (
            <div key={f.name} className="hero__fact">
              <dt>{f.name}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}

/** Inline nodes as React elements: text is escaped by React, a link opens in a new tab with `noopener noreferrer`. */
export function inline(nodes: readonly Inline[]): ReactNode[] {
  return nodes.map((n, k) => {
    switch (n.t) {
      case 'text':
        return n.v
      case 'code':
        return <code key={k}>{n.v}</code>
      case 'strong':
        return <strong key={k}>{inline(n.c)}</strong>
      case 'em':
        return <em key={k}>{inline(n.c)}</em>
      case 'link':
        return (
          <a key={k} className="link" href={n.href} target="_blank" rel="noopener noreferrer">
            {inline(n.c)}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )
      case 'br':
        return <br key={k} />
    }
  })
}

function Blocks({ blocks }: { blocks: readonly Block[] }) {
  return (
    <>
      {blocks.map((b, k) => {
        if (b.t === 'p') return <p key={k} className="md__p">{inline(b.c)}</p>
        if (b.t === 'h') return <p key={k} className="md__h">{inline(b.c)}</p>
        if (b.t === 'code') {
          return (
            <pre key={k} className="md__code" tabIndex={0}>
              <code>{b.v}</code>
            </pre>
          )
        }
        const items = b.items.map((it, j) => (
          <li key={j} className={it.sub ? 'md__sub' : undefined}>
            {inline(it.c)}
          </li>
        ))
        return b.ordered ? (
          <ol key={k} className="md__list" data-ordered="">
            {items}
          </ol>
        ) : (
          <ul key={k} className="md__list">
            {items}
          </ul>
        )
      })}
    </>
  )
}

/** Markdown as it is written, every block drawn in order: bullets, bold, code and links as such, any HTML as the text it is. */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return (
    <div className="md">
      <Blocks blocks={blocks} />
    </div>
  )
}

/**
 * What happened, for a person who has a few seconds. The first sentence is the lead line; when the text is longer than about 280 characters the
 * rest sits behind "More", one sentence to a line. Bullets, bold, code and links render as such. A text that starts with a list is already
 * scannable and is drawn whole.
 */
export function WhatHappened({ text }: { text: string }) {
  const scan = useMemo(() => scanOf(text), [text])
  const rest = scan.rest.length > 0 ? <Blocks blocks={scan.rest} /> : null
  return (
    <div className="md">
      {scan.lead && scan.lead.t === 'p' && <p className="md__lead">{inline(scan.lead.c)}</p>}
      {rest !== null &&
        (scan.fold ? (
          <details className="md__more">
            <summary>
              <ChevronRight aria-hidden="true" />
              More
              <span className="sr-only"> of what happened</span>
            </summary>
            <div className="md__rest">{rest}</div>
          </details>
        ) : (
          rest
        ))}
    </div>
  )
}
