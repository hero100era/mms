/**
 * tests/acceptance/harness/assertions.ts
 *
 * Strict assertion library for MMS Acceptance Tests.
 * Enforces exact status codes, RFC 9457 Problem Details schemas,
 * and security invariants (preventing SQL leaks, stack traces, and filesystem paths).
 */

import assert from 'node:assert/strict'

export interface ProblemDetailsBody {
  type: string
  title: string
  status: number
  detail?: string
  instance?: string
  code?: string
  correlationId?: string
  requestId?: string
  errors?: Record<string, unknown> | unknown[]
  [key: string]: unknown
}

/**
 * Asserts that the response has an exact HTTP status code.
 * Rejects loose inequalities (e.g. status >= 400).
 */
export async function assertStatus(
  res: Response,
  expectedStatus: number | number[],
  customMessage?: string,
): Promise<void> {
  const expectedList = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus]
  if (!expectedList.includes(res.status)) {
    let bodySnippet = ''
    try {
      const cloned = res.clone()
      const text = await cloned.text()
      bodySnippet = text.length > 500 ? `${text.slice(0, 500)}...` : text
    } catch {
      bodySnippet = '<body could not be read>'
    }

    const msg =
      customMessage ??
      `Expected HTTP status ${expectedList.join(' or ')}, but got ${res.status}.\nResponse Body: ${bodySnippet}`
    assert.fail(msg)
  }
}

/**
 * Asserts that a response is a redirect (301, 302, 303, 307, 308) and optionally verifies Location.
 */
export function assertRedirect(
  res: Response,
  expectedLocation?: string | RegExp,
  expectedStatus: number = 302,
): string {
  const isRedirect = [301, 302, 303, 307, 308].includes(res.status)
  assert.ok(
    isRedirect,
    `Expected redirect HTTP status (301, 302, 303, 307, 308), got HTTP ${res.status}`,
  )

  if (expectedStatus) {
    assert.equal(res.status, expectedStatus, `Expected redirect status ${expectedStatus}, got ${res.status}`)
  }

  const location = res.headers.get('location')
  assert.ok(location, 'Expected Location header in redirect response')

  if (typeof expectedLocation === 'string') {
    assert.ok(
      location.startsWith(expectedLocation) || location === expectedLocation,
      `Expected Location '${location}' to match or start with '${expectedLocation}'`,
    )
  } else if (expectedLocation instanceof RegExp) {
    assert.match(location, expectedLocation, `Expected Location '${location}' to match regex ${expectedLocation}`)
  }

  return location
}

/**
 * Asserts that a response contains an expected header matching a string or pattern.
 */
export function assertHeader(
  res: Response,
  headerName: string,
  expectedPattern?: string | RegExp,
): string {
  const value = res.headers.get(headerName)
  assert.ok(value !== null, `Expected response header '${headerName}' to be present`)

  if (typeof expectedPattern === 'string') {
    assert.equal(value, expectedPattern, `Expected header '${headerName}' to equal '${expectedPattern}', got '${value}'`)
  } else if (expectedPattern instanceof RegExp) {
    assert.match(value, expectedPattern, `Expected header '${headerName}' ('${value}') to match pattern ${expectedPattern}`)
  }

  return value
}

/**
 * Asserts that a response is a conforming RFC 9457 Problem Details object.
 * Validates Content-Type, HTTP status, required fields, and correlation ID symmetry.
 */
export async function assertProblemDetails(
  res: Response,
  expectedStatus: number,
  expectedType?: string | RegExp,
  detailPattern?: string | RegExp,
): Promise<ProblemDetailsBody> {
  // 1. Status code assertion
  assert.equal(
    res.status,
    expectedStatus,
    `Problem Details HTTP status mismatch: expected ${expectedStatus}, got ${res.status}`,
  )

  // 2. Content-Type assertion
  const contentType = res.headers.get('content-type') ?? ''
  assert.ok(
    contentType.includes('application/problem+json'),
    `Expected Content-Type 'application/problem+json', got '${contentType}'`,
  )

  // 3. Body parse and validation
  const cloned = res.clone()
  let body: ProblemDetailsBody
  try {
    body = (await cloned.json()) as ProblemDetailsBody
  } catch (err) {
    const raw = await res.clone().text().catch(() => '')
    assert.fail(`Response body is not valid JSON Problem Details: ${err}. Raw: ${raw.slice(0, 300)}`)
  }

  assert.ok(body && typeof body === 'object', 'Problem Details body must be a JSON object')
  assert.equal(body.status, expectedStatus, `Problem Details 'status' field must equal ${expectedStatus}, got ${body.status}`)
  assert.ok(typeof body.title === 'string' && body.title.length > 0, `Problem Details 'title' must be non-empty string, got '${body.title}'`)
  assert.ok(typeof body.type === 'string' && body.type.length > 0, `Problem Details 'type' must be non-empty string, got '${body.type}'`)

  // 4. Type URI pattern check
  if (expectedType) {
    if (typeof expectedType === 'string') {
      assert.equal(body.type, expectedType, `Problem Details 'type' expected '${expectedType}', got '${body.type}'`)
    } else {
      assert.match(body.type, expectedType, `Problem Details 'type' '${body.type}' did not match pattern ${expectedType}`)
    }
  }

  // 5. Detail pattern check
  if (detailPattern && body.detail !== undefined) {
    if (typeof detailPattern === 'string') {
      assert.ok(
        body.detail.includes(detailPattern),
        `Problem Details 'detail' ('${body.detail}') expected to include '${detailPattern}'`,
      )
    } else {
      assert.match(body.detail, detailPattern, `Problem Details 'detail' ('${body.detail}') did not match ${detailPattern}`)
    }
  }

  // 6. Correlation ID symmetry check (if X-Correlation-Id or X-Request-Id header is present)
  const headerCorrelation = res.headers.get('x-correlation-id') ?? res.headers.get('x-request-id')
  if (headerCorrelation && (body.correlationId || body.requestId)) {
    const bodyCorrelation = body.correlationId ?? body.requestId
    assert.equal(
      bodyCorrelation,
      headerCorrelation,
      `Correlation ID in body ('${bodyCorrelation}') does not match header ('${headerCorrelation}')`,
    )
  }

  // 7. Security invariants check on problem body
  await assertSecurityInvariants(JSON.stringify(body))

  return body
}

export interface SecurityInvariantOptions {
  allowSqlKeywords?: boolean
  allowPaths?: boolean
  allowStackTraces?: boolean
}

/**
 * Asserts security invariants across response body or text:
 * - No SQL error leaks (syntax error, relation does not exist, constraint names)
 * - No filesystem path leaks (/var/lib/postgresql, /home/joshua, etc.)
 * - No database connection string leaks (postgresql://)
 * - No internal Node/V8 stack traces
 */
export async function assertSecurityInvariants(
  resOrBody: Response | string | object,
  options?: SecurityInvariantOptions,
): Promise<void> {
  let content = ''
  if (resOrBody instanceof Response) {
    const cloned = resOrBody.clone()
    content = await cloned.text()
  } else if (typeof resOrBody === 'string') {
    content = resOrBody
  } else if (resOrBody && typeof resOrBody === 'object') {
    content = JSON.stringify(resOrBody)
  }

  const lower = content.toLowerCase()

  // 1. Raw SQL and Postgres internal keywords
  if (!options?.allowSqlKeywords) {
    const sqlLeaks = [
      'syntax error at or near',
      'relation "',
      'column "',
      'pg_catalog',
      'pg_class',
      'violates foreign key constraint',
      'violates not-null constraint',
      'violates check constraint',
      'violates unique constraint',
      'operator does not exist',
      'function does not exist',
      'current_schema()',
    ]

    for (const leak of sqlLeaks) {
      if (lower.includes(leak)) {
        assert.fail(`Security Invariant Violation: Leaked SQL keyword/error '${leak}' found in response body: ${content.slice(0, 300)}`)
      }
    }
  }

  // 2. Sensitive filesystem paths
  if (!options?.allowPaths) {
    const pathLeaks = [
      '/var/lib/postgresql',
      '/home/joshua',
      '/etc/passwd',
      '/etc/shadow',
      '\\app\\actions\\',
      '/apps/web/app/',
    ]

    for (const leak of pathLeaks) {
      if (content.includes(leak)) {
        assert.fail(`Security Invariant Violation: Leaked internal filesystem path '${leak}' found in response body: ${content.slice(0, 300)}`)
      }
    }
  }

  // 3. Database connection string credentials
  if (content.includes('postgresql://') || content.includes('postgres:')) {
    // Only fail if it looks like a connection string with auth
    if (/postgresql:\/\/[^:]+:[^@]+@/i.test(content) || /postgres:\/\/[^:]+:[^@]+@/i.test(content)) {
      assert.fail(`Security Invariant Violation: Leaked database credentials connection string in response body: ${content.slice(0, 300)}`)
    }
  }

  // 4. Raw stack trace traces
  if (!options?.allowStackTraces) {
    if (/\bat (?:async )?[a-zA-Z0-9_$.]+\s+\([^)]+\.ts:\d+:\d+\)/.test(content)) {
      assert.fail(`Security Invariant Violation: Stack trace found in response body: ${content.slice(0, 300)}`)
    }
  }
}

/** Asserts that an HTML response contains an expected text or matches a pattern. */
export async function assertHtmlContains(
  resOrHtml: Response | string,
  expectedPattern: string | RegExp,
): Promise<string> {
  const html = typeof resOrHtml === 'string' ? resOrHtml : await resOrHtml.text()

  if (typeof expectedPattern === 'string') {
    assert.ok(
      html.includes(expectedPattern),
      `Expected HTML response to contain '${expectedPattern}'. HTML snippet: ${html.slice(0, 400)}`,
    )
  } else {
    assert.match(
      html,
      expectedPattern,
      `Expected HTML response to match ${expectedPattern}. HTML snippet: ${html.slice(0, 400)}`,
    )
  }

  return html
}

/** Asserts that an HTML response does NOT contain a forbidden text or pattern. */
export async function assertHtmlNotContains(
  resOrHtml: Response | string,
  forbiddenPattern: string | RegExp,
): Promise<string> {
  const html = typeof resOrHtml === 'string' ? resOrHtml : await resOrHtml.text()

  if (typeof forbiddenPattern === 'string') {
    assert.ok(
      !html.includes(forbiddenPattern),
      `Forbidden pattern '${forbiddenPattern}' was found in HTML response. HTML snippet: ${html.slice(0, 400)}`,
    )
  } else {
    assert.ok(
      !forbiddenPattern.test(html),
      `Forbidden pattern ${forbiddenPattern} matched HTML response. HTML snippet: ${html.slice(0, 400)}`,
    )
  }

  return html
}
