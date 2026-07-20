import { useCallback, useEffect, useRef, useState } from 'react'
import { AutoSaveBadge, type AutoSaveState } from '~/routes/(app)/-components/AutoSaveBadge'
import { NOTE_MAX } from '~/lib/settings/char-limits'
import { updateConversationSettingsFn } from '../-lib/update-conversation-settings.fn'
import { m } from '~/paraglide/messages'

interface InternalNoteEditorProps {
  conversationId: string
  /** Initial value only — read at mount. Remount with key={conversationId} to reset. */
  note: string | null
}

const DEBOUNCE_MS = 500

export function InternalNoteEditor({ conversationId, note: initialNote }: InternalNoteEditorProps) {
  // Local state is the sole source of truth after mount — server values must
  // never overwrite it while the user is viewing this conversation (#72).
  const [note, setNote] = useState(initialNote ?? '')
  const [saveState, setSaveState] = useState<AutoSaveState>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  // Latest value for the error-badge retry button (#84).
  const noteRef = useRef(note)
  // Monotonic save ID — only the latest save's completion updates the badge, so
  // a slow in-flight save can't overwrite a newer one's state.
  const saveIdRef = useRef(0)

  // Cancel pending debounce on unmount; an already in-flight save still
  // completes server-side, but must not set state afterwards (key remount).
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  // #84: shared by the debounce and the error-badge retry button — save failures
  // must surface instead of silently dropping the note.
  const saveNote = useCallback(async () => {
    const saveId = ++saveIdRef.current
    setSaveState('saving')
    try {
      await updateConversationSettingsFn({ data: { conversationId, note: noteRef.current } })
      if (!mountedRef.current || saveIdRef.current !== saveId) return
      setSaveState('saved')
    } catch {
      if (!mountedRef.current || saveIdRef.current !== saveId) return
      setSaveState('error')
    }
  }, [conversationId])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setNote(value)
    noteRef.current = value
    setSaveState('editing')
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      void saveNote()
    }, DEBOUNCE_MS)
  }, [saveNote])

  const remaining = NOTE_MAX - note.length

  return (
    <div style={{ padding: '12px 16px' }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--color-ink-3)',
          marginBottom: 8,
        }}
      >
        {m.cp_section_note()}
      </div>
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 4,
          }}
        >
          <label style={{ fontSize: 12, color: 'var(--color-ink-2)' }}>
            {m.cp_note_label()}
          </label>
          <AutoSaveBadge state={saveState} onRetry={() => void saveNote()} />
        </div>
        <textarea
          value={note}
          onChange={handleChange}
          maxLength={NOTE_MAX}
          placeholder={m.cp_note_placeholder()}
          rows={3}
          style={{
            width: '100%',
            resize: 'vertical',
            fontSize: 12,
            lineHeight: 1.5,
            padding: '6px 8px',
            borderRadius: 6,
            border: '1px solid var(--color-line)',
            background: 'var(--color-bg-raised)',
            color: 'var(--color-ink)',
            boxSizing: 'border-box',
            fontFamily: 'inherit',
          }}
        />
        <div style={{ fontSize: 11, color: 'var(--color-ink-4)', textAlign: 'right', marginTop: 2 }}>
          {m.settings_chars_remaining({ remaining })}
        </div>
      </div>
    </div>
  )
}
