import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createScheduler } from './scheduler.ts'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('createScheduler', () => {
  it('ticks on the interval and stops cleanly', async () => {
    let runs = 0
    let scheduler = createScheduler({ label: 'test', intervalMs: 10, run: () => { runs++ } })

    scheduler.start()
    assert.equal(scheduler.running, true)
    await wait(45)
    scheduler.stop()

    let atStop = runs
    assert.ok(atStop >= 2, `expected several ticks, got ${atStop}`)
    await wait(30)
    assert.equal(runs, atStop, 'no ticks after stop()')
    assert.equal(scheduler.running, false)
  })

  it('start() is idempotent and honours an interval override', async () => {
    let runs = 0
    let scheduler = createScheduler({ label: 'test', intervalMs: 1000, run: () => { runs++ } })

    scheduler.start(10)
    scheduler.start(10) // must not install a second timer
    await wait(45)
    scheduler.stop()

    assert.ok(runs >= 2 && runs <= 5, `expected one timer's worth of ticks, got ${runs}`)
  })

  it('never overlaps a slow run', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    let calls = 0
    let scheduler = createScheduler({
      label: 'test',
      intervalMs: 10,
      async run() {
        calls++
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await wait(60)
        concurrent--
      },
    })

    scheduler.start()
    await wait(40) // shorter than one run, but several ticks have fired
    scheduler.stop()
    await wait(30) // let the in-flight run finish without a timer running

    assert.equal(maxConcurrent, 1, 'runs overlapped')
    assert.equal(calls, 1, 'a tick was started while the previous run was in flight')
  })

  it('routes failures through onError and keeps ticking', async () => {
    let errors: Array<{ message: string; phase: string }> = []
    let calls = 0
    let scheduler = createScheduler({
      label: 'test',
      intervalMs: 10,
      run: () => {
        calls++
        throw new Error(`boom ${calls}`)
      },
      onError(error, phase) {
        errors.push({ message: (error as Error).message, phase })
      },
    })

    scheduler.start()
    await wait(45)
    scheduler.stop()

    assert.ok(calls >= 2, `expected recovery after a failure, got ${calls} calls`)
    assert.equal(errors.length, calls)
    assert.ok(errors.every((entry) => entry.phase === 'scheduled'))
    assert.deepEqual(errors.map((entry) => entry.message), [
      ...Array.from({ length: calls }, (_, index) => `boom ${index + 1}`),
    ])
  })

  it('fires an immediate run and a distinct startup hook', async () => {
    let phases: string[] = []
    let scheduler = createScheduler({
      label: 'test',
      intervalMs: 1000,
      run: () => { phases.push('tick') },
      runImmediately: true,
      onStart: () => { phases.push('startup') },
    })

    scheduler.start()
    await wait(5)
    scheduler.stop()

    assert.deepEqual(phases, ['startup', 'tick'])
  })
})
