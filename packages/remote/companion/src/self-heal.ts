/** Idempotent repair loop for private state that another activation can delete. */

/** Hooks owned by the Companion activation that starts this loop. */
export interface SelfHealOptions {
  /** Milliseconds between repair attempts. */
  readonly intervalMs: number
  /** Restore the private state when it is missing or no longer names this boot. */
  readonly ensure: () => Promise<void>
  /** Report one failed attempt without stopping later ones. */
  readonly onError: (error: unknown) => void
  /** Whether the owning activation was disposed and must stop writing. */
  readonly isDisposed: () => boolean
}

/**
 * Run `ensure` on a fixed interval and return the disposer that stops it.
 * Attempts never overlap, a rejected attempt does not stop later ones, and a
 * disposed activation stops writing even before the timer is cleared. The
 * timer is unref'ed so a short-lived profile load, such as a plugin-manager
 * run, still exits on its own.
 */
export function startSelfHeal(options: SelfHealOptions): () => void {
  let pending: Promise<void> | undefined
  const attempt = (): void => {
    if (options.isDisposed() || pending !== undefined) return
    pending = options.ensure()
      .catch((error: unknown) => { options.onError(error) })
      .finally(() => { pending = undefined })
  }
  const timer = setInterval(attempt, options.intervalMs)
  timer.unref()
  return () => { clearInterval(timer) }
}
