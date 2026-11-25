import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { assertPlan, runtimePlan, runtimeRole } from './runtime.ts'

describe('Card H-11: runtime roles separate the web, worker and sealer deployments', () => {
  it('defaults to one process outside production so npm run dev still works', () => {
    assert.equal(runtimeRole({ NODE_ENV: 'development' }), 'all')
    assert.deepEqual(runtimePlan({ NODE_ENV: 'development' }), {
      role: 'all',
      http: true,
      jobs: true,
      sealer: true,
    })
  })

  it('defaults to the web tier in production, so a missing manifest entry does not co-locate everything', () => {
    assert.equal(runtimeRole({ NODE_ENV: 'production' }), 'web')
    let plan = runtimePlan({ NODE_ENV: 'production' })
    assert.equal(plan.jobs, false, 'the web tier must not start the worker schedulers by default')
    assert.equal(plan.sealer, false, 'the web tier must not seal by default')
  })

  it('a worker serves no HTTP and does not seal', () => {
    let plan = runtimePlan({ NODE_ENV: 'production', MMS_RUNTIME_ROLE: 'worker' })
    assert.deepEqual(plan, { role: 'worker', http: false, jobs: true, sealer: false })
    assert.doesNotThrow(() => assertPlan(plan))
  })

  it('the sealer serves no HTTP and runs no application jobs', () => {
    let plan = runtimePlan({ NODE_ENV: 'production', MMS_RUNTIME_ROLE: 'sealer' })
    assert.deepEqual(plan, { role: 'sealer', http: false, jobs: false, sealer: true })
    assert.doesNotThrow(() => assertPlan(plan))
  })

  it('accepts the role case-insensitively and trims it', () => {
    assert.equal(runtimeRole({ MMS_RUNTIME_ROLE: '  SeAlEr ' }), 'sealer')
  })

  it('refuses an unknown role instead of falling back to a permissive default', () => {
    assert.throws(
      () => runtimeRole({ MMS_RUNTIME_ROLE: 'worker,sealer' }),
      /MMS_RUNTIME_ROLE must be one of web, worker, sealer or all/,
    )
  })

  it('the sealer cannot be tricked into serving HTTP', () => {
    assert.throws(
      () => assertPlan({ role: 'sealer', http: true, jobs: false, sealer: true }),
      /must not serve HTTP/,
    )
  })

  it('a worker cannot be tricked into serving HTTP', () => {
    assert.throws(
      () => assertPlan({ role: 'worker', http: true, jobs: true, sealer: false }),
      /must not serve HTTP/,
    )
  })
})
