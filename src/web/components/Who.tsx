// The two places a person gives their name: the one-time prompt the first time they acknowledge (a native modal dialog, so focus is trapped,
// Escape cancels and focus returns to the control), and the small field on the Notifications page that changes it later. Watch has no
// login; the name is kept in this browser and sent as the `by` of an acknowledge (lib/who.ts).

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { FALLBACK_NAME, NAME_MAX, cleanName } from '../../shared/who.ts'
import { answerName, promptOpen, savedName, saveName, subscribePrompt } from '../lib/who.ts'

/** The prompt. Mounted once, at the root: it renders nothing until an acknowledge needs a name. */
export function NamePrompt() {
  const open = useSyncExternalStore(subscribePrompt, promptOpen, () => false)
  const ref = useRef<HTMLDialogElement>(null)
  const [value, setValue] = useState('')
  const titleId = useId()
  const fieldId = useId()
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      setValue(savedName() ?? '')
      d.showModal()
    }
    if (!open && d.open) d.close()
  }, [open])
  const named = cleanName(value) !== ''
  return (
    <dialog
      ref={ref}
      className="prompt"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault()
        answerName('cancel')
      }}
    >
      {open && (
        <form
          className="prompt__form"
          onSubmit={(e) => {
            e.preventDefault()
            if (named) answerName({ save: value })
          }}
        >
          <h2 className="prompt__title" id={titleId}>
            Who is acknowledging?
          </h2>
          <p className="note">
            Watch has no login. Your name goes on the tile, in History and in the chat panel, so a teammate can see who has it. It stays in this
            browser, and you can change it on the Notifications page.
          </p>
          <div className="field">
            <label className="field__label" htmlFor={fieldId}>
              Your name
            </label>
            <input
              id={fieldId}
              className="field__input"
              type="text"
              value={value}
              maxLength={NAME_MAX}
              autoComplete="name"
              autoFocus
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <div className="actions">
            <button type="submit" className="btn" data-variant="primary" disabled={!named}>
              Save and acknowledge
            </button>
            <button type="button" className="btn" onClick={() => answerName('skip')}>
              {`Skip, use ${FALLBACK_NAME}`}
            </button>
            <button type="button" className="btn" onClick={() => answerName('cancel')}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </dialog>
  )
}

/** The Notifications page's field: change the name this browser acknowledges as. Saving an empty field goes back to "this browser". */
export function NameField() {
  const [kept, setKept] = useState(() => savedName())
  const [value, setValue] = useState(() => savedName() ?? '')
  const [said, setSaid] = useState('')
  const fieldId = useId()
  const save = (): void => {
    const now = saveName(value)
    setKept(now)
    setValue(now ?? '')
    setSaid(now ? `Saved. Your acknowledgements read ${now}.` : `Cleared. Your acknowledgements read ${FALLBACK_NAME}.`)
  }
  useEffect(() => {
    setSaid('')
  }, [value])
  return (
    <form
      className="field"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <label className="field__label" htmlFor={fieldId}>
        Your name
      </label>
      <div className="actions">
        <input id={fieldId} className="field__input" type="text" value={value} maxLength={NAME_MAX} autoComplete="name" onChange={(e) => setValue(e.target.value)} />
        <button type="submit" className="btn" disabled={cleanName(value) === (kept ?? '')}>
          Save name
        </button>
      </div>
      <p className="note">
        Acknowledging as {kept ?? FALLBACK_NAME}. The name stays in this browser and goes on the tile, in History and in the chat panel.
      </p>
      <p className="note" role="status">
        {said}
      </p>
    </form>
  )
}
