import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RequestContext } from 'remix/router'

import {
  actionErrorToResponse,
  actionProblemResponse,
  domainCodeToStatus,
  isJsonOrProblemRequest,
  problemResponse,
  toDomainErrorCode,
  toProblemDetails,
  DOMAIN_ERROR_METADATA,
} from './errors.ts'
import { RequestIdKey } from './context.ts'
import { ValidationError } from './validation.ts'

describe('R3.4: Stable domain error codes and HTTP mapping', () => {
  it('maps validation errors to 422 VALIDATION_FAILED', () => {
    let err = new ValidationError({ field: 'invalid' })
    let code = toDomainErrorCode(err)
    assert.equal(code, 'VALIDATION_FAILED')
    assert.equal(domainCodeToStatus(code), 422)

    let res = actionErrorToResponse(err, 'Bad input')
    assert.equal(res.status, 422)
  })

  it('maps 401 and PT401 to 401 UNAUTHORIZED', () => {
    let pgrstErr = { code: 'PT401', status: 401 }
    let code = toDomainErrorCode(pgrstErr)
    assert.equal(code, 'UNAUTHORIZED')
    assert.equal(domainCodeToStatus(code), 401)

    let res = actionErrorToResponse(pgrstErr, 'Unauthorized')
    assert.equal(res.status, 401)
  })

  it('maps 42501 and PT403 to 403 FORBIDDEN', () => {
    let sqlErr = { code: '42501' }
    let code = toDomainErrorCode(sqlErr)
    assert.equal(code, 'FORBIDDEN')
    assert.equal(domainCodeToStatus(code), 403)

    let res = actionErrorToResponse(sqlErr, 'Forbidden', 'corr-123')
    assert.equal(res.status, 403)
    assert.equal(res.headers.get('X-Correlation-Id'), 'corr-123')
  })

  it('maps PGRST116 and 42883 to 404 NOT_FOUND', () => {
    let notFoundErr = { code: 'PGRST116' }
    let code = toDomainErrorCode(notFoundErr)
    assert.equal(code, 'NOT_FOUND')
    assert.equal(domainCodeToStatus(code), 404)

    let res = actionErrorToResponse(notFoundErr, 'Not Found')
    assert.equal(res.status, 404)
  })

  it('maps 23505 and 55P03 to 409 CONFLICT', () => {
    let dupErr = { code: '23505' }
    let code = toDomainErrorCode(dupErr)
    assert.equal(code, 'CONFLICT')
    assert.equal(domainCodeToStatus(code), 409)

    let res = actionErrorToResponse(dupErr, 'Conflict')
    assert.equal(res.status, 409)
  })

  it('maps generic errors to 500 INTERNAL_ERROR', () => {
    let genericErr = new Error('boom')
    let code = toDomainErrorCode(genericErr)
    assert.equal(code, 'INTERNAL_ERROR')
    assert.equal(domainCodeToStatus(code), 500)

    let res = actionErrorToResponse(genericErr, 'Server error')
    assert.equal(res.status, 500)
  })
})

describe('R4.2: RFC 9457 Problem Details standardization', () => {
  it('formats ValidationError into RFC 9457 Problem Details object with field errors', () => {
    let valErr = new ValidationError({ email: 'invalid email address', reason: 'reason too short' })
    let problem = toProblemDetails(valErr, {
      correlationId: 'req-abc-123',
      instance: '/api/test',
    })

    assert.equal(problem.type, 'https://mms.local/problems/validation-failed')
    assert.equal(problem.title, 'Validation Failed')
    assert.equal(problem.status, 422)
    assert.equal(problem.code, 'VALIDATION_FAILED')
    assert.equal(problem.correlationId, 'req-abc-123')
    assert.equal(problem.requestId, 'req-abc-123')
    assert.equal(problem.instance, '/api/test')
    assert.deepEqual(problem.errors, {
      email: 'invalid email address',
      reason: 'reason too short',
    })
  })

  it('formats SQL / PostgREST errors into RFC 9457 Problem Details with stable URIs without leaking internals', () => {
    let internalSqlErr = new Error('syntax error at or near "SELECT" in table iam.app_user')
    let problem = toProblemDetails(internalSqlErr, {
      fallbackMessage: 'An internal error occurred',
      correlationId: 'corr-999',
    })

    assert.equal(problem.type, DOMAIN_ERROR_METADATA.INTERNAL_ERROR.type)
    assert.equal(problem.title, 'Internal Server Error')
    assert.equal(problem.status, 500)
    assert.equal(problem.code, 'INTERNAL_ERROR')
    assert.equal(problem.correlationId, 'corr-999')
    // Leaked SQL syntax / table name must NOT be present in detail
    assert.ok(!problem.detail.includes('SELECT'))
    assert.ok(!problem.detail.includes('iam.app_user'))
    assert.equal(problem.detail, 'An internal error occurred')
  })

  it('problemResponse emits application/problem+json and no-store with correlation headers', async () => {
    let err = { code: '42501' }
    let res = problemResponse(err, {
      detail: 'Permission denied for this operation',
      correlationId: 'req-corr-777',
    })

    assert.equal(res.status, 403)
    assert.equal(res.headers.get('Content-Type'), 'application/problem+json; charset=utf-8')
    assert.equal(res.headers.get('Cache-Control'), 'no-store')
    assert.equal(res.headers.get('X-Correlation-Id'), 'req-corr-777')
    assert.equal(res.headers.get('X-Request-Id'), 'req-corr-777')

    let body = await res.json()
    assert.equal(body.type, 'https://mms.local/problems/forbidden')
    assert.equal(body.title, 'Forbidden')
    assert.equal(body.status, 403)
    assert.equal(body.code, 'FORBIDDEN')
    assert.equal(body.detail, 'Permission denied for this operation')
    assert.equal(body.correlationId, 'req-corr-777')
  })

  it('actionProblemResponse retrieves correlationId from RequestContext automatically', async () => {
    let reqCtx = new RequestContext(new Request('http://localhost/survey/action'))
    reqCtx.set(RequestIdKey, 'auto-req-id-555')

    let res = actionProblemResponse(reqCtx, new Error('invalid_state'), {
      status: 400,
      detail: 'State transition rejected',
      extra: { error: 'invalid_state' },
    })

    assert.equal(res.status, 400)
    assert.equal(res.headers.get('Content-Type'), 'application/problem+json; charset=utf-8')
    assert.equal(res.headers.get('X-Request-Id'), 'auto-req-id-555')

    let body = await res.json()
    assert.equal(body.correlationId, 'auto-req-id-555')
    assert.equal(body.error, 'invalid_state')
  })

  it('isJsonOrProblemRequest recognizes JSON and problem content negotiations', () => {
    assert.equal(isJsonOrProblemRequest(null), false)

    let htmlReq = new Request('http://localhost/', { headers: { accept: 'text/html' } })
    assert.equal(isJsonOrProblemRequest(htmlReq), false)

    let jsonReq = new Request('http://localhost/', { headers: { accept: 'application/json' } })
    assert.equal(isJsonOrProblemRequest(jsonReq), true)

    let problemReq = new Request('http://localhost/', { headers: { accept: 'application/problem+json' } })
    assert.equal(isJsonOrProblemRequest(problemReq), true)

    let postJsonReq = new Request('http://localhost/', { headers: { 'content-type': 'application/json' } })
    assert.equal(isJsonOrProblemRequest(postJsonReq), true)
  })

  it('P0.3: Public Error Surface Allowlist strictly prevents sensitive string leakage', () => {
    // 1. Database connection string with credentials
    let connErr = new Error('failed to connect to postgresql://postgres:super_secret_pw@10.0.0.5:5432/mms_prod')
    let p1 = toProblemDetails(connErr, { correlationId: 'corr-leak-1' })
    assert.equal(p1.status, 500)
    assert.equal(p1.code, 'INTERNAL_ERROR')
    assert.equal(p1.title, 'Internal Server Error')
    assert.equal(p1.detail, 'Internal Server Error')
    assert.ok(!JSON.stringify(p1).includes('super_secret_pw'))
    assert.ok(!JSON.stringify(p1).includes('10.0.0.5'))

    // 2. Filesystem path leakage
    let pathErr = new Error('could not open file /var/lib/postgresql/data/base/16384/2673: disk read error')
    let p2 = toProblemDetails(pathErr, { correlationId: 'corr-leak-2' })
    assert.equal(p2.status, 500)
    assert.ok(!p2.detail.includes('/var/lib/postgresql'))

    // 3. Multiline stack trace
    let stackErr = new Error('Unexpected crash\n    at Object.run (/app/secret/runner.ts:42:15)\n    at processTicksAndRejections')
    let p3 = toProblemDetails(stackErr, { correlationId: 'corr-leak-3' })
    assert.equal(p3.status, 500)
    assert.ok(!p3.detail.includes('/app/secret'))

    // 4. Allowlisted exact domain errors correctly map to publicMessage
    let sodErr1 = new Error('creator_cannot_approve')
    let pSod1 = toProblemDetails(sodErr1, { correlationId: 'corr-sod-1' })
    assert.equal(pSod1.code, 'FORBIDDEN')
    assert.equal(pSod1.status, 403)
    assert.match(pSod1.detail, /creator_cannot_approve/)

    let sodErr2 = new Error('cannot_confirm_own_proposal')
    let pSod2 = toProblemDetails(sodErr2, { correlationId: 'corr-sod-2' })
    assert.equal(pSod2.code, 'FORBIDDEN')
    assert.equal(pSod2.status, 403)
    assert.match(pSod2.detail, /cannot_confirm_own_proposal/)
  })
})
