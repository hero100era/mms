import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'
import {
  clearStepUpThrottle,
  isStepUpThrottled,
  recordStepUpAttempt,
  getStepUpRetryAfter,
  STEP_UP_MAX_ATTEMPTS,
} from '../auth/service.ts'

describe('Step-Up Throttle Service', () => {
  before(() => {
    clearStepUpThrottle()
  })

  after(() => {
    clearStepUpThrottle()
  })

  it('throttles step-up attempts independently and isolates user sessions', async () => {
    let userA = 'user-a'
    let userB = 'user-b'
    let ip = '127.0.0.1'
    let sessionA = 'session-a'
    let sessionB = 'session-b'

    // Initially neither is throttled
    assert.equal(await isStepUpThrottled(userA, ip, sessionA), false)
    assert.equal(await isStepUpThrottled(userB, ip, sessionB), false)

    // Fail userA 5 times on sessionA
    for (let i = 0; i < STEP_UP_MAX_ATTEMPTS; i++) {
      await recordStepUpAttempt(userA, ip, false, sessionA)
    }

    assert.equal(await isStepUpThrottled(userA, ip, sessionA), true)
    let retryAfter = getStepUpRetryAfter(userA, ip, sessionA)
    assert.ok(retryAfter > 0)

    // Fail userB 5 times on sessionB
    for (let i = 0; i < STEP_UP_MAX_ATTEMPTS; i++) {
      await recordStepUpAttempt(userB, ip, false, sessionB)
    }
    assert.equal(await isStepUpThrottled(userB, ip, sessionB), true)

    // Clear userA only: userA is unthrottled, userB session remains throttled!
    clearStepUpThrottle(userA)
    assert.equal(await isStepUpThrottled(userA, ip, sessionA), false)
    assert.equal(await isStepUpThrottled(userB, ip, sessionB), true)

    // Clear userB
    clearStepUpThrottle(userB)
    assert.equal(await isStepUpThrottled(userB, ip, sessionB), false)
  })
})
