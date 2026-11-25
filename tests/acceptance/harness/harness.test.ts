/**
 * tests/acceptance/harness/harness.test.ts
 *
 * Baseline smoke verification test suite for MMS Acceptance Test Harness.
 * Validates:
 * - Server handshake detection (/__acceptance/health + fallback)
 * - AcceptanceClient HTTP mechanics, cookie persistence, and CSRF extraction
 * - Real persona logins via /dev/login (customer.a, surveyor.shanghai, manager.shanghai, sysadmin.test, breakglass.test)
 * - Strict assertion utilities (assertStatus, assertRedirect, assertProblemDetails)
 * - Security invariant enforcement (blocking SQL leaks, stack traces, and local paths)
 * - Content-Type negotiation (HTML vs Problem Details)
 */

import assert from 'node:assert/strict'
import {
  AcceptanceClient,
  CookieJar,
  createAcceptanceClient,
  createAnonymousClient,
  createPersonaClient,
  extractCsrfToken,
} from './client.ts'
import {
  assertHeader,
  assertHtmlContains,
  assertHtmlNotContains,
  assertProblemDetails,
  assertRedirect,
  assertSecurityInvariants,
  assertStatus,
} from './assertions.ts'
import { probePostgrest, probeWebServer } from './handshake.ts'

export interface HarnessTestContext {
  baseUrl: string
  pgrstUrl: string
}

export async function runHarnessSmokeSuite(context: HarnessTestContext): Promise<{ total: number; passed: number; failed: number }> {
  const { baseUrl, pgrstUrl } = context
  let passed = 0
  let failed = 0

  async function step(name: string, fn: () => Promise<void>): Promise<void> {
    const start = Date.now()
    try {
      await fn()
      const elapsed = Date.now() - start
      console.log(`  ✓ [Harness] ${name} (${elapsed}ms)`)
      passed++
    } catch (err) {
      const elapsed = Date.now() - start
      console.error(`  ✗ [Harness] ${name} (${elapsed}ms):`, err)
      failed++
    }
  }

  console.log('----------------------------------------------------------------')
  console.log('Running Acceptance Test Harness Smoke Suite:')
  console.log('----------------------------------------------------------------')

  // 1. Server Handshake & Health Probe
  await step('Server handshake probe detects active web server and PostgREST', async () => {
    const webProbe = await probeWebServer(baseUrl)
    assert.ok(webProbe.healthy, `Web server at ${baseUrl} should be healthy: ${webProbe.detail}`)
    assert.ok(
      webProbe.status === 200 || webProbe.status === 302,
      `Web probe should return 200 or 302, got ${webProbe.status}`,
    )

    const pgrstProbe = await probePostgrest(pgrstUrl)
    assert.ok(pgrstProbe.healthy, `PostgREST at ${pgrstUrl} should be reachable: ${pgrstProbe.detail}`)
  })

  // 2. CookieJar Mechanics & Persistence
  await step('CookieJar stores, expires, and formats cookie headers accurately', async () => {
    const jar = new CookieJar()
    jar.parseSetCookie(
      '__mms_sid=test-session-uuid-1234; Path=/; HttpOnly; SameSite=Lax; Expires=Wed, 21 Oct 2099 07:28:00 GMT',
    )
    assert.equal(jar.get('__mms_sid'), 'test-session-uuid-1234')
    assert.equal(jar.getCookieHeader(), '__mms_sid=test-session-uuid-1234')

    // Expired cookie handling
    jar.parseSetCookie('expired_cookie=val; Path=/; Expires=Wed, 21 Oct 2020 07:28:00 GMT')
    assert.equal(jar.get('expired_cookie'), undefined)

    // Jar cloning
    const cloned = jar.clone()
    assert.equal(cloned.get('__mms_sid'), 'test-session-uuid-1234')
    cloned.set('__mms_sid', 'mutated-val')
    assert.equal(jar.get('__mms_sid'), 'test-session-uuid-1234')
    assert.equal(cloned.get('__mms_sid'), 'mutated-val')
  })

  // 3. CSRF Token Extraction from HTML
  await step('extractCsrfToken parses hidden inputs and meta tags', async () => {
    const html1 = '<form><input type="hidden" name="_csrf" value="csrf-token-1111" /></form>'
    assert.equal(extractCsrfToken(html1), 'csrf-token-1111')

    const html2 = '<form><input type="hidden" value="csrf-token-2222" name="_csrf" /></form>'
    assert.equal(extractCsrfToken(html2), 'csrf-token-2222')

    const html3 = '<head><meta name="csrf-token" content="csrf-token-3333" /></head>'
    assert.equal(extractCsrfToken(html3), 'csrf-token-3333')

    const htmlEmpty = '<div><p>No token here</p></div>'
    assert.equal(extractCsrfToken(htmlEmpty), undefined)
  })

  // 4. Anonymous Client Requests & Security Invariants
  await step('Anonymous client executes GET /login and verifies security invariants', async () => {
    const client = createAnonymousClient({ baseUrl })
    const res = await client.get('/login', { accept: 'html' })
    await assertStatus(res, 200)

    const contentType = assertHeader(res, 'content-type')
    assert.ok(contentType.includes('text/html'))

    const html = await res.text()
    assert.ok(html.length > 0)
    assert.ok(client.sessionId !== undefined, 'Server should have set __mms_sid session cookie')

    // Verify security invariants: no SQL errors, internal file paths, or credentials
    await assertSecurityInvariants(html)
  })

  // 5. Persona Login: customer.a
  await step('Persona login for customer.a establishes authenticated session and accesses profile', async () => {
    const client = await createPersonaClient('customer.a', { baseUrl })
    assert.ok(client.sessionId, 'Client must have active session ID after login')
    assert.ok(client.csrfToken, 'Client must capture CSRF token after login')
    assert.equal(client.personaKey, 'customer.a')

    const profileRes = await client.get('/profile', { accept: 'html' })
    await assertStatus(profileRes, 200)

    const profileHtml = await profileRes.text()
    await assertHtmlContains(profileHtml, 'Active role: ext_user')
    await assertHtmlContains(profileHtml, '00000000-0000-4000-8000-000000000101')
    await assertSecurityInvariants(profileHtml)
  })

  // 6. Multi-Persona Login Verification (Station, Management, Sysadmin, Breakglass)
  await step('Persona login succeeds across surveyor, manager, sysadmin, and breakglass roles', async () => {
    const personasToTest = [
      { key: 'surveyor.shanghai', userId: '00000000-0000-4000-8000-000000000103', role: 'int_surveyor' },
      { key: 'manager.shanghai', userId: '00000000-0000-4000-8000-000000000105', role: 'int_manager' },
      { key: 'sysadmin.test', userId: '00000000-0000-4000-8000-000000000113', role: 'int_sysadmin' },
      { key: 'breakglass.test', userId: '00000000-0000-4000-8000-000000000115', role: 'int_viewer' },
    ]

    for (const p of personasToTest) {
      const client = await createPersonaClient(p.key, { baseUrl })
      assert.ok(client.sessionId, `Persona ${p.key} must obtain session ID`)

      const profileRes = await client.get('/profile', { accept: 'html' })
      await assertStatus(profileRes, 200)
      const html = await profileRes.text()
      assert.ok(html.includes(`Active role: ${p.role}`), `Profile must include Active role: ${p.role}`)
      assert.ok(html.includes(p.userId), `Profile must include User: ${p.userId}`)
    }
  })

  // 7. Strict Assertion Utilities (assertStatus, assertRedirect)
  await step('Strict assertion utilities accurately validate statuses and catch mismatches', async () => {
    const mock200 = new Response('OK', { status: 200 })
    await assertStatus(mock200, 200) // Should pass

    let statusFailed = false
    try {
      await assertStatus(mock200, 404)
    } catch {
      statusFailed = true
    }
    assert.ok(statusFailed, 'assertStatus must fail when expected status does not match')

    const mockRedirect = new Response(null, {
      status: 302,
      headers: { Location: '/profile' },
    })
    const loc = assertRedirect(mockRedirect, '/profile', 302)
    assert.equal(loc, '/profile')
  })

  // 8. RFC 9457 Problem Details Schema Assertion
  await step('assertProblemDetails validates RFC 9457 fields, types, and correlation IDs', async () => {
    const correlationId = 'test-corr-id-9999'
    const problemJson = {
      type: 'https://mms.local/problems/bad-request',
      title: 'Bad Request',
      status: 400,
      detail: 'The provided parameter was invalid.',
      correlationId,
    }

    const mockProblemRes = new Response(JSON.stringify(problemJson), {
      status: 400,
      headers: {
        'Content-Type': 'application/problem+json; charset=utf-8',
        'X-Correlation-Id': correlationId,
      },
    })

    const parsed = await assertProblemDetails(
      mockProblemRes,
      400,
      'https://mms.local/problems/bad-request',
      'invalid',
    )

    assert.equal(parsed.status, 400)
    assert.equal(parsed.title, 'Bad Request')
    assert.equal(parsed.correlationId, correlationId)
  })

  // 9. Security Invariants Assertion Catches Injected Leaks
  await step('assertSecurityInvariants catches injected SQL, stack trace, and filesystem leaks', async () => {
    // Clean string passes
    await assertSecurityInvariants('{"status":"ok","message":"Operation completed."}')

    // Injected SQL keyword must throw
    let sqlCaught = false
    try {
      await assertSecurityInvariants('Error: syntax error at or near "SELECT"')
    } catch {
      sqlCaught = true
    }
    assert.ok(sqlCaught, 'assertSecurityInvariants must reject raw SQL syntax error strings')

    // Injected absolute path must throw
    let pathCaught = false
    try {
      await assertSecurityInvariants('Fatal error in /home/joshua/mms/db/file.ts')
    } catch {
      pathCaught = true
    }
    assert.ok(pathCaught, 'assertSecurityInvariants must reject /home/joshua local paths')

    // Injected database connection string must throw
    let credsCaught = false
    try {
      await assertSecurityInvariants('Connection string: postgresql://postgres:supersecret@127.0.0.1:5432/db')
    } catch {
      credsCaught = true
    }
    assert.ok(credsCaught, 'assertSecurityInvariants must reject database connection strings with passwords')
  })

  // 10. Content Negotiation (API vs HTML)
  await step('Content negotiation distinguishes HTML and API request behaviors', async () => {
    const client = createAcceptanceClient({ baseUrl })

    // HTML accept header
    const htmlRes = await client.get('/login', { accept: 'html' })
    await assertStatus(htmlRes, 200)
    const htmlType = htmlRes.headers.get('content-type') ?? ''
    assert.ok(htmlType.includes('text/html'), 'Expected text/html content-type for HTML client')

    // API protected route unauthenticated request
    const apiRes = await client.post('/api/uploads/prepare', null, { accept: 'problem' })
    // Protected API route without auth returns 401 or redirect
    assert.ok(
      apiRes.status === 401 || apiRes.status === 302 || apiRes.status === 403,
      `Unauthenticated API request must be rejected (401/403/302), got ${apiRes.status}`,
    )
  })

  return { total: passed + failed, passed, failed }
}

if (process.argv[1] && process.argv[1].endsWith('harness.test.ts')) {
  const baseUrl = process.env.APPLICATION_BASE_URL ?? 'http://localhost:44100'
  const pgrstUrl = process.env.MMS_PGRST_URL ?? 'http://127.0.0.1:3001'

  runHarnessSmokeSuite({ baseUrl, pgrstUrl })
    .then((result) => {
      console.log(`\nHarness Smoke Result: ${result.passed}/${result.total} passed.`)
      process.exit(result.failed > 0 ? 1 : 0)
    })
    .catch((err) => {
      console.error('Harness Smoke execution failed:', err)
      process.exit(1)
    })
}
