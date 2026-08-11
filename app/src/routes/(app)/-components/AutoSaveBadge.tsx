import { m } from '~/paraglide/messages'

export type AutoSaveState = 'editing' | 'saving' | 'saved' | 'error' | null

interface AutoSaveBadgeProps {
  state: AutoSaveState
  /** Renders a retry button next to the error label. Only used when state is 'error'. */
  onRetry?: () => void
}

export function AutoSaveBadge({ state, onRetry }: AutoSaveBadgeProps) {
  if (!state) return null

  if (state === 'error') {
    return (
      <span
        role="alert"
        className="text-xs font-medium text-[var(--color-rose-ink)]"
      >
        {m.autosave_error()}
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="ml-1.5 cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-[var(--color-rose-ink)] underline"
          >
            {m.autosave_retry()}
          </button>
        )}
      </span>
    )
  }

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
