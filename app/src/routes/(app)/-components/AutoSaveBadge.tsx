import { m } from '~/paraglide/messages'

export type AutoSaveState = 'editing' | 'saving' | 'saved' | null

interface AutoSaveBadgeProps {
  state: AutoSaveState
}

export function AutoSaveBadge({ state }: AutoSaveBadgeProps) {
  if (!state) return null

  const label =
    state === 'editing'
      ? m.autosave_editing()
      : state === 'saving'
        ? m.autosave_saving()
        : m.autosave_saved()

  const colorClass =
    state === 'saved'
      ? 'text-[var(--color-green-ink)]'
      : state === 'saving'
        ? 'text-[var(--color-ink-3)]'
        : 'text-[var(--color-ink-4)]'

  return (
    <span className={`text-xs font-medium transition-colors ${colorClass}`} aria-live="polite">
      {label}
    </span>
  )
}
