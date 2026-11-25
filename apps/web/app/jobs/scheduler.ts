// One scheduler for every background loop in the app.
//
// Each job used to own a module-level timer, an `inFlight` boolean, a
// `.catch().finally()` chain, an `unref()` call and a `stop()` function. Five
// copies drifted: the break-glass drill checker had no overlap guard at all,
// and the sealer deliberately kept its timer referenced. This module owns all
// of that mechanics behind a single interface; a job supplies only what varies
// (its cadence, its work, and how it reports a failure).
export type SchedulerPhase = 'startup' | 'scheduled'

export type SchedulerOptions = {
  intervalMs: number
  /** Used in the default error message. */
  label: string
  /** The work performed on every tick. May be sync or async. */
  run: () => unknown | Promise<unknown>
  /** Run once as part of `start()` (in addition to the periodic tick). */
  runImmediately?: boolean
  /** A distinct one-off startup task (e.g. an overdue check) instead of `run`. */
  onStart?: () => unknown | Promise<unknown>
  /** Keep the process alive between ticks. Default: unref the timer. */
  keepAlive?: boolean
  /** Preserve per-job log wording; defaults to a generic message. */
  onError?: (error: unknown, phase: SchedulerPhase) => void
}

export type Scheduler = {
  readonly running: boolean
  /** Overrides the configured cadence and optional keepAlive (used by tests and daemons). */
  start(intervalMs?: number, startOptions?: { keepAlive?: boolean }): void
  stop(): void
  /** Stops future ticks and awaits any currently executing run up to timeoutMs. */
  drain(timeoutMs?: number): Promise<void>
  /** Run the work now, subject to the same overlap guard as a tick. */
  trigger(): Promise<void>
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  let {
    intervalMs,
    label,
    run,
    runImmediately = false,
    onStart,
    keepAlive = false,
    onError,
  } = options

  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight = false
  let activePromise: Promise<void> | null = null
  let stopped = true

  function report(error: unknown, phase: 'startup' | 'scheduled'): void {
    if (onError) {
      onError(error, phase)
      return
    }
    console.error(`${label} ${phase} run error:`, error)
  }

  function invoke(work: () => unknown | Promise<unknown>, phase: 'startup' | 'scheduled'): Promise<void> {
    // A slow run must never be interleaved with the next tick: every job here
    // mutates shared state (outbox rows, scan ledgers, seal chain heads).
    if (inFlight) return Promise.resolve()
    inFlight = true
    let runPromise: Promise<void> | null = null
    runPromise = (async () => {
      try {
        await work()
      } catch (error) {
        report(error, phase)
      } finally {
        inFlight = false
        if (activePromise === runPromise) activePromise = null
      }
    })()
    activePromise = runPromise
    return runPromise
  }

  function tick(): void {
    void invoke(run, 'scheduled')
  }

  return {
    get running() {
      return !stopped
    },
    start(overrideIntervalMs, startOptions) {
      if (timer) return
      stopped = false
      let effectiveKeepAlive = startOptions?.keepAlive ?? keepAlive
      // A startup hook and an immediate run belong to one guarded pass, so both
      // happen, neither overlaps a tick, and neither blocks the other.
      let startupWork: Array<() => unknown | Promise<unknown>> = []
      if (onStart) startupWork.push(onStart)
      if (runImmediately) startupWork.push(run)
      if (startupWork.length > 0) {
        void invoke(async () => {
          for (let work of startupWork) await work()
        }, 'startup')
      }
      timer = setInterval(() => {
        if (!stopped) tick()
      }, overrideIntervalMs ?? intervalMs)
      if (!effectiveKeepAlive) timer.unref()
    },
    stop() {
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
    },
    async drain(timeoutMs = 15_000) {
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
      if (!activePromise) return
      let timerId: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          activePromise,
          new Promise<void>((resolve) => {
            timerId = setTimeout(resolve, timeoutMs)
            timerId.unref()
          }),
        ])
      } finally {
        if (timerId) clearTimeout(timerId)
      }
    },
    trigger() {
      return invoke(run, 'scheduled')
    },
  }
}
