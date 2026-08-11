import { useCallback, useEffect, useRef, useState } from 'react'
import type { AutoSaveState } from './AutoSaveBadge'

export interface UseAutoSaveOptions {
  /**
   * Performs the actual save. The latest value should be read here (typically
   * from a ref updated in the change handler) so retries send current data.
   * Return `false` to signal "nothing was persisted" — the badge then clears to
   * null instead of asserting 保存済み (e.g. no active draft server-side). Any
   * other resolved value (an object result, a boolean true, or void) counts as
   * saved.
   */
  save: () => Promise<unknown>
  /** Debounce before a scheduled save fires. Default 500ms. */
  debounceMs?: number
}

export interface UseAutoSaveApi {
  /** Current badge state, owned by the hook. */
  state: AutoSaveState
  /** Mark the field as editing and (re)arm the debounced save. */
  schedule: () => void
  /** Save immediately, bypassing the debounce (retry button, non-debounced fields). */
  flush: () => void
  /** Cancel a pending/in-flight save and clear the badge (target gone: dismiss, draft left 'ready', unmount-like resets). */
  reset: () => void
}

/**
 * #84: the shared autosave state machine (saving → saved/error, monotonic
 * last-write-wins guard, unmount safety, retry). Extracted so ReplyForm, the
 * settings prompt editor, the conversation tone/prompt editors, and the internal
 * note editor stop hand-rolling five slightly-divergent copies of it.
 */
export function useAutoSave({ save, debounceMs = 500 }: UseAutoSaveOptions): UseAutoSaveApi {
  const [state, setState] = useState<AutoSaveState>(null)
  // Monotonic save ID — only the latest save's completion may write state, so a
  // slow in-flight save can't clobber a newer one's result.
  const saveIdRef = useRef(0)
  const mountedRef = useRef(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Keep the latest save closure without re-arming flush/schedule identities.
  const saveRef = useRef(save)
  saveRef.current = save

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const saveId = ++saveIdRef.current
    setState('saving')
    void (async () => {
      try {
        const result = await saveRef.current()
        if (!mountedRef.current || saveIdRef.current !== saveId) return
        setState(result === false ? null : 'saved')
      } catch {
        if (!mountedRef.current || saveIdRef.current !== saveId) return
        setState('error')
      }
    })()
  }, [])

  const schedule = useCallback(() => {
    setState('editing')
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      flush()
    }, debounceMs)
  }, [flush, debounceMs])

  const reset = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    // Invalidate any in-flight save so its late completion can't set state.
    saveIdRef.current++
    setState(null)
  }, [])

  return { state, schedule, flush, reset }
}
