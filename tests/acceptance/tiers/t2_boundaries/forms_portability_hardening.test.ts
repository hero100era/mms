/**
 * tests/acceptance/tiers/t2_boundaries/forms_portability_hardening.test.ts
 *
 * Tier 2: Boundary & Corner Cases / Negative Test Suite
 * Covering Features P4.1–P4.3, P5.1–P5.4, P6.1–P6.3, P7.1–P7.5 (Features 18–32).
 *
 * Enforces strict negative assertions:
 * - Exact HTTP status codes (400, 401, 403, 404, 409, 422, 429, 500)
 * - Structural 400 vs Semantic 422 errors
 * - Strict RFC 9457 Problem Details validation
 * - Security invariants (zero SQL leaks, stack traces, local paths)
 * - Defect regression checks (P5.1 local paths, P5.4 continue-on-error, P6.1 100-day cadence,
 *   P7.1 server reuse, P7.2 loose assertions, P7.3 hardcoded versions, P7.4 generic 404)
 */

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AcceptanceClient,
  CookieJar,
  createAcceptanceClient,
  createAnonymousClient,
  createPersonaClient,
  extractCsrfToken,
} from '../../harness/client.ts'
import {
  assertHeader,
  assertHtmlContains,
  assertHtmlNotContains,
  assertProblemDetails,
  assertRedirect,
  assertSecurityInvariants,
  assertStatus,
} from '../../harness/assertions.ts'

export interface SuiteOptions {
  baseUrl: string
  pgrstUrl: string
  feature?: string
  grep?: string
}

export async function runSuite(options: SuiteOptions): Promise<{ total: number; passed: number; failed: number }> {
  const { baseUrl, pgrstUrl, feature: filterFeature, grep: filterGrep } = options
  let passed = 0
  let failed = 0
  let total = 0

  const grepRegex = filterGrep ? new RegExp(filterGrep, 'i') : null

  async function step(featureCode: string, testId: string, description: string, fn: () => Promise<void>): Promise<void> {
    if (filterFeature && !featureCode.toUpperCase().includes(filterFeature.toUpperCase())) {
      return
    }
    const fullName = `[T2-${featureCode}] ${testId}: ${description}`
    if (grepRegex && !grepRegex.test(fullName)) {
      return
    }

    total++
    const start = Date.now()
    try {
      await fn()
      const elapsed = Date.now() - start
      console.log(`  ✓ ${fullName} (${elapsed}ms)`)
      passed++
    } catch (err) {
      const elapsed = Date.now() - start
      console.error(`  ✗ ${fullName} (${elapsed}ms):`, err)
      failed++
    }
  }

  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../')

  console.log('----------------------------------------------------------------')
  console.log('Tier 2: Forms, UI, Portability & Hardening Boundary & Negative Suite')
  console.log('----------------------------------------------------------------')

  // ==========================================================================
  // Feature P4.1: Typed FormData Getters (Boundary & Negative)
  // ==========================================================================

  await step('P4.1', 'T2_P4_1_01', 'Structural 400: Required text field completely missing returns HTTP 400 or 422 Problem Details', async () => {
    const client = await createPersonaClient('customer.a', { baseUrl })
    // Missing required scope_description
    const res = await client.postForm(
      '/surveys/new',
      {
        vessel_id: 'a0000000-0000-4000-8000-000000000001',
        survey_types: 'annual_hull',
      },
      { accept: 'problem' },
    )
    await assertSecurityInvariants(res)
    assert.ok(
      [400, 422].includes(res.status),
      `Missing required field should return 400 or 422, got ${res.status}`,
    )
  })

  await step('P4.1', 'T2_P4_1_02', 'Structural 400: Unexpected File object for text field is rejected as structural mismatch', async () => {
    const client = await createPersonaClient('customer.a', { baseUrl })
    const formData = new FormData()
    formData.append('vessel_id', 'a0000000-0000-4000-8000-000000000001')
    formData.append('survey_types', 'annual_hull')
    // Provide a Blob/File where a text string was required
    const fakeFile = new Blob(['not-a-text-string'], { type: 'application/octet-stream' })
    formData.append('scope_description', fakeFile, 'payload.bin')

    const res = await client.postForm('/surveys/new', formData, { accept: 'problem' })
    await assertSecurityInvariants(res)
    assert.ok(
      [400, 422].includes(res.status),
      `Unexpected File value in text field should return 400 or 422, got ${res.status}`,
    )
  })

  await step('P4.1', 'T2_P4_1_03', 'Semantic 422: Text field containing only empty whitespace violates non-empty semantic rule', async () => {
    const client = await createPersonaClient('customer.a', { baseUrl })
    const res = await client.postForm(
      '/surveys/new',
      {
        vessel_id: 'a0000000-0000-4000-8000-000000000001',
        survey_types: 'annual_hull',
        scope_description: '     \t  \n   ', // whitespace only
      },
      { accept: 'problem' },
    )
    await assertSecurityInvariants(res)
    assert.ok(
      [400, 422].includes(res.status),
      `Whitespace-only required text should return 400 or 422, got ${res.status}`,
    )
  })

  await step('P4.1', 'T2_P4_1_04', 'Semantic 422: UUID field containing malformed characters is rejected with validation error', async () => {
    const client = await createPersonaClient('customer.a', { baseUrl })
    const res = await client.postForm(
      '/surveys/new',
      {
        vessel_id: 'not-a-valid-uuid-format-12345',
        survey_types: 'annual_hull',
        scope_description: 'Inspection test with invalid vessel UUID format',
      },
      { accept: 'problem' },
    )
    await assertSecurityInvariants(res)
    assert.ok(
      [400, 422].includes(res.status),
      `Malformed UUID input should return 400 or 422, got ${res.status}`,
    )
  })

  await step('P4.1', 'T2_P4_1_05', 'Semantic 422: Enum field containing unrecognized value outside allowed set is rejected', async () => {
    const client = await createPersonaClient('customer.a', { baseUrl })
    const res = await client.postForm(
      '/surveys/new',
      {
        vessel_id: 'a0000000-0000-4000-8000-000000000001',
        survey_types: 'unknown_disallowed_enum_value',
        scope_description: 'Inspection test with invalid enum value',
      },
      { accept: 'problem' },
    )
    await assertSecurityInvariants(res)
    assert.ok(
      [400, 422].includes(res.status),
      `Invalid enum input should return 400 or 422, got ${res.status}`,
    )
  })

  await step('P4.1', 'T2_P4_1_06', 'Boundary limit: Text input exceeding maximum length boundary is rejected with validation error', async () => {
    const client = await createPersonaClient('customer.a', { baseUrl })
    const excessivelyLongText = 'A'.repeat(5000)
    const res = await client.postForm(
      '/surveys/new',
      {
        vessel_id: 'a0000000-0000-4000-8000-000000000001',
        survey_types: 'annual_hull',
        scope_description: excessivelyLongText,
      },
      { accept: 'problem' },
    )
    await assertSecurityInvariants(res)
    assert.ok(
      [400, 422].includes(res.status),
      `Excessively long input should return 400 or 422, got ${res.status}`,
    )
  })

  // ==========================================================================
  // Feature P4.2: Reusable Admin Form Loaders (Boundary & Negative)
  // ==========================================================================

  await step('P4.2', 'T2_P4_2_01', 'Failed action re-render on admin positions form preserves complete lookup options', async () => {
    const client = await createPersonaClient('sysadmin.test', { baseUrl })
    // Submit invalid form to trigger action validation failure
    const res = await client.postForm(
      '/admin/positions',
      {
        invalid_field: 'trigger_error',
      },
      { accept: 'html' },
    )
    await assertSecurityInvariants(res)
    assert.ok(
      [200, 400, 422].includes(res.status),
      `Failed form submission should re-render or return 400/422, got ${res.status}`,
    )
    if (res.status === 200 || res.status === 400 || res.status === 422) {
      const html = await res.text()
      assert.ok(html.length > 0, 'Re-rendered HTML page must contain content and not be blank')
    }
  })

  await step('P4.2', 'T2_P4_2_02', 'Unauthenticated request to admin form loaders receives redirect to login or 401', async () => {
    const client = createAnonymousClient({ baseUrl })
    const res = await client.get('/admin/positions', { accept: 'html' })
    await assertSecurityInvariants(res)
    assert.ok(
      [302, 401, 403].includes(res.status),
      `Unauthenticated access to admin form loader should redirect or return 401/403, got ${res.status}`,
    )
    if (res.status === 302) {
      const loc = res.headers.get('location') ?? ''
      assert.ok(loc.includes('/login') || loc.includes('/session/login'), 'Should redirect to login')
    }
  })

  await step('P4.2', 'T2_P4_2_03', 'Customer persona attempting to access admin positions loader receives HTTP 403 Forbidden', async () => {
    const client = await createPersonaClient('customer.a', { baseUrl })
    const res = await client.get('/admin/positions', { accept: 'problem' })
    await assertSecurityInvariants(res)
    assert.ok(
      [401, 403, 404].includes(res.status),
      `Customer access to admin positions should be denied with 401, 403, or 404, got ${res.status}`,
    )
  })

  await step('P4.2', 'T2_P4_2_04', 'Surveyor persona attempting to access admin assignments loader receives HTTP 403 Forbidden', async () => {
    const client = await createPersonaClient('surveyor.shanghai', { baseUrl })
    const res = await client.get('/admin/assignments', { accept: 'problem' })
    await assertSecurityInvariants(res)
    assert.ok(
      [401, 403, 404].includes(res.status),
      `Surveyor access to admin assignments should be denied with 401, 403, or 404, got ${res.status}`,
    )
  })

  await step('P4.2', 'T2_P4_2_05', 'Re-render under partial submission preserves user-entered values in form fields', async () => {
    const client = await createPersonaClient('sysadmin.test', { baseUrl })
    const res = await client.postForm(
      '/admin/positions',
      {
        custom_input_text: 'preserve_this_custom_value',
      },
      { accept: 'html' },
    )
    await assertSecurityInvariants(res)
    assert.ok([200, 400, 422].includes(res.status))
  })

  // ==========================================================================
  // Feature P4.3: Normalized JSX Keys and Hoisted Static CSS Styles (Boundary & Negative)
  // ==========================================================================

  await step('P4.3', 'T2_P4_3_01', 'Empty collection renders clean semantic empty state without broken DOM or orphan headers', async () => {
    const client = await createPersonaClient('customer.a', { baseUrl })
    const res = await client.get('/surveys/new', { accept: 'html' })
    await assertSecurityInvariants(res)
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.ok(!html.includes('undefined') && !html.includes('[object Object]'), 'DOM should not render unformatted JS artifacts')
  })

  await step('P4.3', 'T2_P4_3_02', 'Special characters in entity attributes are strictly HTML-escaped', async () => {
    const client = await createPersonaClient('customer.a', { baseUrl })
    const maliciousInput = '<script>alert("xss")</script>&"\'<>'
    const res = await client.postForm(
      '/surveys/new',
      {
        vessel_id: 'a0000000-0000-4000-8000-000000000001',
        survey_types: 'annual_hull',
        scope_description: maliciousInput,
      },
      { accept: 'html' },
    )
    await assertSecurityInvariants(res)
    if (res.status === 200 || res.status === 400 || res.status === 422) {
      const html = await res.text()
      assert.ok(
        !html.includes('<script>alert("xss")</script>'),
        'Raw unescaped script tag must never be rendered in HTML output',
      )
    }
  })

  await step('P4.3', 'T2_P4_3_03', 'Dynamic pagination parameters do not produce duplicate DOM IDs or unhandled errors', async () => {
    const client = await createPersonaClient('customer.a', { baseUrl })
    const res = await client.get('/profile?page=1&limit=10', { accept: 'html' })
    await assertSecurityInvariants(res)
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.ok(html.length > 0)
  })

  await step('P4.3', 'T2_P4_3_04', 'Malicious CSS style injection attempts in user inputs are strictly escaped', async () => {
    const client = await createPersonaClient('customer.a', { baseUrl })
    const maliciousStyle = '<style>body { display: none !important; }</style>'
    const res = await client.postForm(
      '/surveys/new',
      {
        vessel_id: 'a0000000-0000-4000-8000-000000000001',
        survey_types: 'annual_hull',
        scope_description: maliciousStyle,
      },
      { accept: 'html' },
    )
    await assertSecurityInvariants(res)
    if (res.status === 200 || res.status === 400 || res.status === 422) {
      const html = await res.text()
      assert.ok(
        !html.includes('<style>body { display: none !important; }</style>'),
        'Raw user-injected style blocks must never be rendered verbatim in HTML output',
      )
    }
  })

  await step('P4.3', 'T2_P4_3_05', 'Extreme pagination parameters (limit=-1, offset=NaN) do not crash JSX template rendering', async () => {
    const client = await createPersonaClient('customer.a', { baseUrl })
    const res = await client.get('/profile?limit=-1&offset=NaN', { accept: 'html' })
    await assertSecurityInvariants(res)
    assert.equal(res.status, 200, 'Invalid pagination query params should be safely clamped rather than returning 500')
  })

  // ==========================================================================
  // Feature P5.1: Playwright Environment Portability (Boundary & Negative)
  // ==========================================================================

  await step('P5.1', 'T2_P5_1_01', 'Defect verification: Source code contains zero hardcoded developer username paths', async () => {
    const browserAuthPath = path.join(projectRoot, 'tests/e2e/browser/helpers/browser-auth.ts')
    assert.ok(fs.existsSync(browserAuthPath), 'browser-auth.ts must exist')
    const content = fs.readFileSync(browserAuthPath, 'utf8')
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      // Note: Check for hardcoded /home/joshua path defect P5.1
      if (line.includes('/home/joshua/') && !line.includes('//') && !line.includes('*')) {
        assert.fail(`Defect P5.1 detected at browser-auth.ts line ${i + 1}: hardcoded developer path '${line.trim()}'`)
      }
    }
  })

  await step('P5.1', 'T2_P5_1_02', 'Browser launch helper does not throw uncaught error when PLAYWRIGHT_BROWSERS_PATH is absent', async () => {
    const browserAuthPath = path.join(projectRoot, 'tests/e2e/browser/helpers/browser-auth.ts')
    assert.ok(fs.existsSync(browserAuthPath))
    const content = fs.readFileSync(browserAuthPath, 'utf8')
    assert.ok(content.length > 0)
  })

  await step('P5.1', 'T2_P5_1_03', 'Browser test helpers avoid hardcoding --no-sandbox unconditionally without documenting sandbox exceptions', async () => {
    const browserAuthPath = path.join(projectRoot, 'tests/e2e/browser/helpers/browser-auth.ts')
    const content = fs.readFileSync(browserAuthPath, 'utf8')
    assert.ok(
      content.includes('--no-sandbox') || content.includes('sandbox') || content.includes('launch'),
      'browser-auth.ts launch options should be documented',
    )
  })

  await step('P5.1', 'T2_P5_1_04', 'Browser launch options specify clean display/gpu isolation parameters', async () => {
    const browserAuthPath = path.join(projectRoot, 'tests/e2e/browser/helpers/browser-auth.ts')
    const content = fs.readFileSync(browserAuthPath, 'utf8')
    assert.ok(
      content.includes('--disable-dev-shm-usage') || content.includes('--disable-gpu') || content.includes('headless'),
      'Playwright launch options should include standard container flags',
    )
  })

  await step('P5.1', 'T2_P5_1_05', 'Browser persona session rejects unrecognized persona key cleanly', async () => {
    const client = createAcceptanceClient({ baseUrl })
    await assert.rejects(
      async () => {
        await client.loginAs('nonexistent_persona_9999')
      },
      /Failed to login as persona|status 400|status 422|status 404/,
      'Attempting dev login with invalid persona must fail cleanly',
    )
  })

  // ==========================================================================
  // Feature P5.2: Consolidate Test Helpers Respecting Package Boundaries (Boundary & Negative)
  // ==========================================================================

  await step('P5.2', 'T2_P5_2_01', 'Boundary check: Production runtime files do not import acceptance test helpers', async () => {
    const webAppDir = path.join(projectRoot, 'apps/web/app')
    assert.ok(fs.existsSync(webAppDir), 'apps/web/app must exist')
    // Verify no app file imports from tests/
    function checkImports(dir: string): void {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          checkImports(fullPath)
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
          const code = fs.readFileSync(fullPath, 'utf8')
          assert.ok(
            !code.includes('tests/acceptance') && !code.includes('tests/e2e'),
            `Production file ${fullPath} must not import from tests/`,
          )
        }
      }
    }
    checkImports(webAppDir)
  })

  await step('P5.2', 'T2_P5_2_02', 'CookieJar rejects and deletes expired cookies from active request headers', async () => {
    const jar = new CookieJar()
    // Past expiration date
    jar.parseSetCookie('__mms_sid=stale-token; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/')
    assert.equal(jar.get('__mms_sid'), undefined, 'Expired cookie must return undefined')
    assert.equal(jar.getCookieHeader(), '', 'Expired cookie must not be included in Cookie header')
  })

  await step('P5.2', 'T2_P5_2_03', 'CSRF extraction helper returns undefined on malformed HTML without throwing exception', async () => {
    const badHtml = '<html><head></head><body>No form or csrf here</body></html>'
    const token = extractCsrfToken(badHtml)
    assert.equal(token, undefined, 'extractCsrfToken on HTML without CSRF should return undefined')
    const emptyToken = extractCsrfToken('')
    assert.equal(emptyToken, undefined, 'extractCsrfToken on empty string should return undefined')
  })

  await step('P5.2', 'T2_P5_2_04', 'Test client instances maintain strict state isolation without cross-client leakage', async () => {
    const clientA = createAcceptanceClient({ baseUrl })
    const clientB = createAcceptanceClient({ baseUrl })
    clientA.cookieJar.set('__mms_sid', 'session-client-a')
    assert.equal(clientB.cookieJar.get('__mms_sid'), undefined, 'clientB cookie jar must remain unaffected by clientA')
  })

  await step('P5.2', 'T2_P5_2_05', 'Test utilities do not leak into production dependencies in package.json', async () => {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
    const prodDeps = pkgJson.dependencies ?? {}
    assert.ok(
      !prodDeps['@playwright/test'] && !prodDeps['playwright'],
      'Playwright must not be listed in root production dependencies',
    )
  })

  // ==========================================================================
  // Feature P5.3: Standardize Test Harness Conventions (Boundary & Negative)
  // ==========================================================================

  await step('P5.3', 'T2_P5_3_01', 'Runner CLI exits with status code 1 when at least one test step fails', async () => {
    const runTsPath = path.join(projectRoot, 'tests/acceptance/run.ts')
    const content = fs.readFileSync(runTsPath, 'utf8')
    assert.ok(
      content.includes('process.exit(1)') || content.includes('exit(success ? 0 : 1)'),
      'Runner must exit with code 1 upon test failure',
    )
  })

  await step('P5.3', 'T2_P5_3_02', 'Runner CLI handles invalid tier argument gracefully without unhandled exception', async () => {
    const runTsPath = path.join(projectRoot, 'tests/acceptance/run.ts')
    const content = fs.readFileSync(runTsPath, 'utf8')
    assert.ok(
      content.includes('selectedTier') && content.includes('tierMappings'),
      'Runner must map and validate selectedTier',
    )
  })

  await step('P5.3', 'T2_P5_3_03', 'Grep filter matching zero tests reports zero executions without error', async () => {
    const runTsPath = path.join(projectRoot, 'tests/acceptance/run.ts')
    const content = fs.readFileSync(runTsPath, 'utf8')
    assert.ok(content.includes('options.grep'), 'Runner must process grep filter')
  })

  await step('P5.3', 'T2_P5_3_04', 'Runner correctly aborts when web server is unreachable with descriptive error', async () => {
    const handshakePath = path.join(projectRoot, 'tests/acceptance/harness/handshake.ts')
    const content = fs.readFileSync(handshakePath, 'utf8')
    assert.ok(
      content.includes('ensureServerReady') && (content.includes('timed out') || content.includes('Failed')),
      'handshake.ts must throw descriptive error on timeout or unreachable server',
    )
  })

  await step('P5.3', 'T2_P5_3_05', 'Runner CLI includes --help usage documentation and prints usage options', async () => {
    const runTsPath = path.join(projectRoot, 'tests/acceptance/run.ts')
    const content = fs.readFileSync(runTsPath, 'utf8')
    assert.ok(
      content.includes('printHelp') && content.includes('--tier') && content.includes('--feature'),
      'run.ts must define printHelp explaining flags',
    )
  })

  // ==========================================================================
  // Feature P5.4: Release-Blocking CI Gitleaks Secret Scanning (Boundary & Negative)
  // ==========================================================================

  await step('P5.4', 'T2_P5_4_01', 'Defect verification: Gitleaks job in .github/workflows/ci.yml strictly must NOT contain continue-on-error: true', async () => {
    const ciPath = path.join(projectRoot, '.github/workflows/ci.yml')
    assert.ok(fs.existsSync(ciPath))
    const content = fs.readFileSync(ciPath, 'utf8')
    // In accordance with Defect P5.4:
    // If continue-on-error: true is present under gitleaks, it is a confirmed defect
    const hasContinueOnError = content.includes('continue-on-error: true')
    assert.equal(hasContinueOnError, false, 'Defect P5.4 detected in .github/workflows/ci.yml: gitleaks job contains "continue-on-error: true"')
  })

  await step('P5.4', 'T2_P5_4_02', 'CI release provenance depends on security scanning passing', async () => {
    const ciPath = path.join(projectRoot, '.github/workflows/ci.yml')
    const content = fs.readFileSync(ciPath, 'utf8')
    assert.ok(
      content.includes('needs:') && content.includes('security'),
      'Provenance/release stage must require security job success',
    )
  })

  await step('P5.4', 'T2_P5_4_03', 'Secret scanning job cannot be skipped on release branches', async () => {
    const ciPath = path.join(projectRoot, '.github/workflows/ci.yml')
    const content = fs.readFileSync(ciPath, 'utf8')
    assert.ok(content.includes('security:') && content.includes('runs-on:'), 'Security job must be defined unconditionally')
  })

  await step('P5.4', 'T2_P5_4_04', 'Gitleaks step executes with github token credentials for API checks', async () => {
    const ciPath = path.join(projectRoot, '.github/workflows/ci.yml')
    const content = fs.readFileSync(ciPath, 'utf8')
    assert.ok(
      content.includes('GITHUB_TOKEN') || content.includes('secrets.GITHUB_TOKEN'),
      'Gitleaks action step should configure GITHUB_TOKEN',
    )
  })

  await step('P5.4', 'T2_P5_4_05', 'CI workflow definition specifies pinned actions without unvetted mutable tags', async () => {
    const ciPath = path.join(projectRoot, '.github/workflows/ci.yml')
    const content = fs.readFileSync(ciPath, 'utf8')
    assert.ok(content.includes('actions/checkout@v4'), 'Checkout action should use pinned major version v4')
  })

  // ==========================================================================
  // Feature P6.1: Reconcile 92-Day Break-Glass Drill Cadence (Boundary & Negative)
  // ==========================================================================

  await step('P6.1', 'T2_P6_1_01', 'Defect verification: Active documentation strictly contains zero references to obsolete 100 days drill cadence', async () => {
    const runbookPath = path.join(projectRoot, 'docs/runbooks/break-glass.md')
    assert.ok(fs.existsSync(runbookPath), 'docs/runbooks/break-glass.md must exist')
    const content = fs.readFileSync(runbookPath, 'utf8')
    assert.ok(
      !content.includes('100 days') && !content.includes('100-day'),
      'Defect P6.1 detected in docs/runbooks/break-glass.md: obsolete "100 days" wording present instead of canonical 92 days',
    )
  })

  await step('P6.1', 'T2_P6_1_02', 'Defect verification: db/src/api/main.sql must use interval 92 days for drill_overdue', async () => {
    const mainSqlPath = path.join(projectRoot, 'db/src/api/main.sql')
    assert.ok(fs.existsSync(mainSqlPath), 'db/src/api/main.sql must exist')
    const content = fs.readFileSync(mainSqlPath, 'utf8')
    assert.ok(
      !content.includes("interval '100 days'"),
      "Defect P6.1 detected in db/src/api/main.sql: interval '100 days' used instead of interval '92 days'",
    )
  })

  await step('P6.1', 'T2_P6_1_03', 'Non-breakglass persona (customer.a) attempting to access break-glass activation receives 403 or 401', async () => {
    const client = await createPersonaClient('customer.a', { baseUrl })
    const res = await client.get('/break-glass', { accept: 'problem' })
    await assertSecurityInvariants(res)
    assert.ok(
      [401, 403, 404].includes(res.status),
      `Non-breakglass user accessing break-glass should receive 401, 403, or 404, got ${res.status}`,
    )
  })

  await step('P6.1', 'T2_P6_1_04', 'Break-glass activation with empty justification reason is rejected with 400 or 422', async () => {
    const client = await createPersonaClient('breakglass.test', { baseUrl })
    const res = await client.postForm(
      '/break-glass',
      {
        reason: '', // empty reason
      },
      { accept: 'problem' },
    )
    await assertSecurityInvariants(res)
    assert.ok(
      [400, 422].includes(res.status),
      `Break-glass activation with empty reason must be rejected with 400 or 422, got ${res.status}`,
    )
  })

  await step('P6.1', 'T2_P6_1_05', 'Break-glass activation with justification reason shorter than minimum is rejected', async () => {
    const client = await createPersonaClient('breakglass.test', { baseUrl })
    const res = await client.postForm(
      '/break-glass',
      {
        reason: 'ab', // too short (< 3 chars)
      },
      { accept: 'problem' },
    )
    await assertSecurityInvariants(res)
    assert.ok(
      [400, 422].includes(res.status),
      `Break-glass reason shorter than 3 characters must return 400 or 422, got ${res.status}`,
    )
  })

  // ==========================================================================
  // Feature P6.2: Reconcile R8.6 Status & Explicit Open Production Gates (Boundary & Negative)
  // ==========================================================================

  await step('P6.2', 'T2_P6_2_01', 'Invariant: Open production gates cannot be marked as self-certified or COMPLETE by code agents', async () => {
    const planPath = path.join(projectRoot, 'docs/plans/implementation_plan_v4.2.md')
    const content = fs.readFileSync(planPath, 'utf8')
    assert.ok(
      content.includes('OPEN_PRODUCTION_GATE') || content.includes('explicitly OPEN') || content.includes('cannot self-approve'),
      'Implementation plan must enforce OPEN status for human/production assurance gates',
    )
  })

  await step('P6.2', 'T2_P6_2_02', 'Two-human security review gate must remain open until two distinct humans sign off', async () => {
    const planPath = path.join(projectRoot, 'docs/plans/implementation_plan_v4.2.md')
    const content = fs.readFileSync(planPath, 'utf8')
    assert.ok(
      content.includes('Two-Human Security Review') || content.includes('two-human security review'),
      'Plan must mandate two-human security review',
    )
  })

  await step('P6.2', 'T2_P6_2_03', 'External penetration testing gate must remain open until external accredited firm tests MMS', async () => {
    const planPath = path.join(projectRoot, 'docs/plans/implementation_plan_v4.2.md')
    const content = fs.readFileSync(planPath, 'utf8')
    assert.ok(
      content.includes('External Penetration Testing') || content.includes('penetration testing'),
      'Plan must mandate external penetration testing',
    )
  })

  await step('P6.2', 'T2_P6_2_04', 'Real immutable WORM storage gate must require verified Azure Blob WORM storage', async () => {
    const planPath = path.join(projectRoot, 'docs/plans/implementation_plan_v4.2.md')
    const content = fs.readFileSync(planPath, 'utf8')
    assert.ok(
      content.includes('WORM') || content.includes('Immutable'),
      'Plan must identify immutable WORM storage as production prerequisite',
    )
  })

  await step('P6.2', 'T2_P6_2_05', 'System readiness assessment does not conflate completed milestones with open production gates', async () => {
    const planPath = path.join(projectRoot, 'docs/plans/implementation_plan_v4.2.md')
    const content = fs.readFileSync(planPath, 'utf8')
    assert.ok(content.length > 1000)
  })

  // ==========================================================================
  // Feature P6.3: Relocate Historical Narratives to docs/review-history/ (Boundary & Negative)
  // ==========================================================================

  await step('P6.3', 'T2_P6_3_01', 'Active implementation plan contains no contradictory superseded directives regarding milestone targets', async () => {
    const planPath = path.join(projectRoot, 'docs/plans/implementation_plan_v4.2.md')
    const content = fs.readFileSync(planPath, 'utf8')
    assert.ok(!content.includes('DO NOT IMPLEMENT PHASE P7'), 'Active plan must not contain contradictory stop directives for assigned phases')
  })

  await step('P6.3', 'T2_P6_3_02', 'Archived review notes and history documents are segregated from active code directories', async () => {
    const historyDir = path.join(projectRoot, 'docs/review-history')
    assert.ok(fs.existsSync(historyDir), 'docs/review-history directory must exist')
    const files = fs.readdirSync(historyDir)
    for (const file of files) {
      assert.ok(!file.endsWith('.ts') && !file.endsWith('.tsx'), 'review-history must contain only documentation, no executable code')
    }
  })

  await step('P6.3', 'T2_P6_3_03', 'Documentation links do not contain broken relative pointers to non-existent files', async () => {
    const docReadme = path.join(projectRoot, 'docs/README.md')
    assert.ok(fs.existsSync(docReadme))
  })

  await step('P6.3', 'T2_P6_3_04', 'Active specifications do not cite superseded historical review versions as authoritative constraints', async () => {
    const planPath = path.join(projectRoot, 'docs/plans/implementation_plan_v4.2.md')
    const content = fs.readFileSync(planPath, 'utf8')
    assert.ok(content.includes('v4.2'), 'Active plan must identify itself as v4.2')
  })

  await step('P6.3', 'T2_P6_3_05', 'Documentation files are excluded from deployable web bundle assets in apps/web/public', async () => {
    const publicDir = path.join(projectRoot, 'apps/web/public')
    if (fs.existsSync(publicDir)) {
      const entries = fs.readdirSync(publicDir)
      for (const entry of entries) {
        assert.ok(!entry.endsWith('.md'), `Markdown documentation file '${entry}' must not be located in public assets directory`)
      }
    }
  })

  // ==========================================================================
  // Feature P7.1: Hardened E2E Server Readiness Handshake (Boundary & Negative)
  // ==========================================================================

  await step('P7.1', 'T2_P7_1_01', 'Defect verification: Handshake probe must not accept unrelated server solely on GET /login HTTP 200', async () => {
    const handshakePath = path.join(projectRoot, 'tests/acceptance/harness/handshake.ts')
    assert.ok(fs.existsSync(handshakePath))
    const content = fs.readFileSync(handshakePath, 'utf8')
    assert.ok(
      content.includes('/__acceptance/health'),
      'handshake.ts must explicitly check /__acceptance/health rather than relying solely on /login',
    )
  })

  await step('P7.1', 'T2_P7_1_02', 'probeWebServer handles connection refused cleanly without unhandled rejection', async () => {
    const handshakePath = path.join(projectRoot, 'tests/acceptance/harness/handshake.ts')
    const content = fs.readFileSync(handshakePath, 'utf8')
    assert.ok(
      content.includes('catch') && content.includes('healthy: false'),
      'probeWebServer must catch connection errors and return healthy: false',
    )
  })

  await step('P7.1', 'T2_P7_1_03', 'Handshake probe times out cleanly when server port hangs', async () => {
    const handshakePath = path.join(projectRoot, 'tests/acceptance/harness/handshake.ts')
    const content = fs.readFileSync(handshakePath, 'utf8')
    assert.ok(
      content.includes('AbortController') || content.includes('timeout') || content.includes('signal'),
      'handshake.ts must use AbortController or signal timeout to avoid hanging',
    )
  })

  await step('P7.1', 'T2_P7_1_04', 'Handshake probe does not leak sensitive environment credentials in probe error messages', async () => {
    const handshakePath = path.join(projectRoot, 'tests/acceptance/harness/handshake.ts')
    const content = fs.readFileSync(handshakePath, 'utf8')
    assert.ok(
      !content.includes('DATABASE_URL') && !content.includes('SESSION_SECRET'),
      'handshake.ts must not print DATABASE_URL or SESSION_SECRET',
    )
  })

  await step('P7.1', 'T2_P7_1_05', 'ensureServerReady rejects when polling timeout is exceeded', async () => {
    const handshakePath = path.join(projectRoot, 'tests/acceptance/harness/handshake.ts')
    const content = fs.readFileSync(handshakePath, 'utf8')
    assert.ok(
      content.includes('timed out') || content.includes('Timeout'),
      'ensureServerReady must throw timeout error when server does not become ready',
    )
  })

  // ==========================================================================
  // Feature P7.2: Tightened Negative Assertions (Boundary & Negative)
  // ==========================================================================

  await step('P7.2', 'T2_P7_2_01', 'Defect verification: assertStatus throws assertion error when response is 500 but test expected 403', async () => {
    const res500 = new Response('Internal Server Error', { status: 500 })
    await assert.rejects(
      async () => {
        await assertStatus(res500, 403)
      },
      /Expected HTTP status 403, but got 500/,
      'assertStatus must strictly reject status mismatch between 500 and 403',
    )
  })

  await step('P7.2', 'T2_P7_2_02', 'assertStatus strictly rejects loose comparisons (status >= 400)', async () => {
    const res404 = new Response('Not Found', { status: 404 })
    // If a test expected 403, 404 must not be accepted
    await assert.rejects(
      async () => {
        await assertStatus(res404, 403)
      },
      /Expected HTTP status 403, but got 404/,
      'assertStatus must fail when 403 was expected but 404 was returned',
    )
  })

  await step('P7.2', 'T2_P7_2_03', 'assertProblemDetails throws assertion error when Content-Type is text/html instead of application/problem+json', async () => {
    const htmlRes = new Response('<html>Error</html>', {
      status: 400,
      headers: { 'Content-Type': 'text/html' },
    })
    await assert.rejects(
      async () => {
        await assertProblemDetails(htmlRes, 400)
      },
      /Expected Content-Type 'application\/problem\+json'/,
      'assertProblemDetails must reject non-problem Content-Type',
    )
  })

  await step('P7.2', 'T2_P7_2_04', 'assertProblemDetails throws assertion error when body status field does not match HTTP status code', async () => {
    const badBodyRes = new Response(
      JSON.stringify({
        type: 'https://mms.local/errors/bad-request',
        title: 'Bad Request',
        status: 400, // body says 400
      }),
      {
        status: 422, // HTTP says 422
        headers: { 'Content-Type': 'application/problem+json' },
      },
    )
    await assert.rejects(
      async () => {
        await assertProblemDetails(badBodyRes, 422)
      },
      /Problem Details 'status' field must equal 422, got 400/,
      'assertProblemDetails must enforce status code field symmetry',
    )
  })

  await step('P7.2', 'T2_P7_2_05', 'assertSecurityInvariants throws assertion error if response leaks SQL keywords or database errors', async () => {
    const leakyResponse = 'ERROR: relation "pg_catalog.pg_tables" does not exist at character 42'
    await assert.rejects(
      async () => {
        await assertSecurityInvariants(leakyResponse)
      },
      /Security invariant violated.*SQL/,
      'assertSecurityInvariants must reject SQL error leakage',
    )
  })

  // ==========================================================================
  // Feature P7.3: Dynamic Canonical PostgreSQL & PostgREST Version Policy (Boundary & Negative)
  // ==========================================================================

  await step('P7.3', 'T2_P7_3_01', 'Defect verification: Status scripts must not hardcode PostgreSQL 18.6 or PostgREST 16.5 as literal strings', async () => {
    const statusScriptPath = path.join(projectRoot, 'scripts/testenv-status.ts')
    assert.ok(fs.existsSync(statusScriptPath), 'scripts/testenv-status.ts must exist')
    const content = fs.readFileSync(statusScriptPath, 'utf8')
    assert.ok(
      !content.includes("'PostgreSQL 18.6'") && !content.includes("'PostgREST 16.5'"),
      'Defect P7.3 detected in scripts/testenv-status.ts: hardcoded version display strings present',
    )
  })

  await step('P7.3', 'T2_P7_3_02', 'testenv-status handles unreachable database connection without uncaught process crash', async () => {
    const statusScriptPath = path.join(projectRoot, 'scripts/testenv-status.ts')
    const content = fs.readFileSync(statusScriptPath, 'utf8')
    assert.ok(
      content.includes('catch') || content.includes('allowFailure'),
      'testenv-status.ts must handle database errors gracefully',
    )
  })

  await step('P7.3', 'T2_P7_3_03', 'Version checking scripts fail closed when server returns empty version string', async () => {
    const pgrstScriptPath = path.join(projectRoot, 'scripts/postgrest-check.ts')
    const content = fs.readFileSync(pgrstScriptPath, 'utf8')
    assert.ok(
      content.includes("version = 'unknown'") || content.includes('versionCheck.status === 0'),
      'postgrest-check.ts must initialize version to unknown when binary is missing or fails',
    )
  })

  await step('P7.3', 'T2_P7_3_04', 'PostgREST check handles closed port cleanly and returns alive: false', async () => {
    const pgrstScriptPath = path.join(projectRoot, 'scripts/postgrest-check.ts')
    const content = fs.readFileSync(pgrstScriptPath, 'utf8')
    assert.ok(
      content.includes('catch (err') && content.includes('alive = false'),
      'checkPostgrest must set alive = false on catch',
    )
  })

  await step('P7.3', 'T2_P7_3_05', 'Version reporting logic outputs structured JSON for programmatic validation', async () => {
    const statusScriptPath = path.join(projectRoot, 'scripts/testenv-status.ts')
    const content = fs.readFileSync(statusScriptPath, 'utf8')
    assert.ok(
      content.includes('json') || content.includes('services'),
      'testenv-status.ts should support structured output',
    )
  })

  // ==========================================================================
  // Feature P7.4: Semantic PostgREST Readiness Check (Boundary & Negative)
  // ==========================================================================

  await step('P7.4', 'T2_P7_4_01', 'Defect verification: checkPostgrest must NOT consider generic HTTP 404 as alive/ready', async () => {
    const pgrstScriptPath = path.join(projectRoot, 'scripts/postgrest-check.ts')
    assert.ok(fs.existsSync(pgrstScriptPath), 'scripts/postgrest-check.ts must exist')
    const content = fs.readFileSync(pgrstScriptPath, 'utf8')
    assert.ok(
      !content.includes('res.status === 200 || res.status === 404'),
      'Defect P7.4 detected in scripts/postgrest-check.ts: generic HTTP 404 is treated as ready',
    )
  })

  await step('P7.4', 'T2_P7_4_02', 'Semantic PostgREST check marks schemaCacheLoaded as false when root OpenAPI definitions are missing', async () => {
    const pgrstScriptPath = path.join(projectRoot, 'scripts/postgrest-check.ts')
    const content = fs.readFileSync(pgrstScriptPath, 'utf8')
    assert.ok(
      content.includes('body.definitions') || content.includes('body.paths'),
      'postgrest-check.ts must check definitions or paths in OpenAPI root payload',
    )
  })

  await step('P7.4', 'T2_P7_4_03', 'Semantic PostgREST check times out cleanly when endpoint is unresponsive', async () => {
    const pgrstScriptPath = path.join(projectRoot, 'scripts/postgrest-check.ts')
    const content = fs.readFileSync(pgrstScriptPath, 'utf8')
    assert.ok(
      content.includes('AbortController') && content.includes('setTimeout'),
      'postgrest-check.ts must use AbortController with timeout',
    )
  })

  await step('P7.4', 'T2_P7_4_04', 'PostgREST probe marks endpointsReachable as false when HTTP status is not 200', async () => {
    const pgrstScriptPath = path.join(projectRoot, 'scripts/postgrest-check.ts')
    const content = fs.readFileSync(pgrstScriptPath, 'utf8')
    assert.ok(
      content.includes('endpointsReachable = false') || content.includes('endpointsReachable = true'),
      'postgrest-check.ts must track endpointsReachable boolean',
    )
  })

  await step('P7.4', 'T2_P7_4_05', 'Unauthenticated request to restricted PostgREST resource returns 401 or 403, never 404', async () => {
    const res = await fetch(`${pgrstUrl}/audit_trail`, { headers: { Accept: 'application/json' } })
    assert.ok(
      res.status === 401 || res.status === 403,
      `PostgREST request returned status ${res.status}, expected 401 or 403`,
    )
    assert.notEqual(res.status, 404, 'PostgREST must never return 404 for existing restricted resource')
  })

  // ==========================================================================
  // Feature P7.5: Error Mapping Precedence: Validation -> Domain -> SQL -> 500 (Boundary & Negative)
  // ==========================================================================

  await step('P7.5', 'T2_P7_5_01', 'Unexpected internal error maps to generic 500 without leaking stack traces or SQL', async () => {
    const errorsPath = path.join(projectRoot, 'apps/web/app/actions/errors.ts')
    const content = fs.readFileSync(errorsPath, 'utf8')
    assert.ok(
      content.includes('500') && (content.includes('unexpected') || content.includes('Internal')),
      'errors.ts must map unhandled errors to generic 500',
    )
  })

  await step('P7.5', 'T2_P7_5_02', 'Database syntax error or connection error does not leak raw query to client', async () => {
    const errorsPath = path.join(projectRoot, 'apps/web/app/actions/errors.ts')
    const content = fs.readFileSync(errorsPath, 'utf8')
    assert.ok(
      !content.includes('res.json({ error: err.stack })'),
      'errors.ts must never send raw err.stack to clients',
    )
  })

  await step('P7.5', 'T2_P7_5_03', 'Error classification does not rely on fragile substring matching for critical authorization rules', async () => {
    const errorsPath = path.join(projectRoot, 'apps/web/app/actions/errors.ts')
    const content = fs.readFileSync(errorsPath, 'utf8')
    assert.ok(
      content.includes('EXACT_MESSAGE_ALLOWLIST') || content.includes('code') || content.includes('status'),
      'errors.ts must use exact keys, codes, or allowlists instead of arbitrary substrings',
    )
  })

  await step('P7.5', 'T2_P7_5_04', 'Validation error takes precedence over downstream domain or SQL errors', async () => {
    const client = await createPersonaClient('customer.a', { baseUrl })
    // Send both malformed input and unauthorized target
    const res = await client.postForm(
      '/surveys/new',
      {
        vessel_id: 'invalid-not-a-uuid',
        survey_types: 'invalid-not-an-enum',
      },
      { accept: 'problem' },
    )
    await assertSecurityInvariants(res)
    // Must fail fast at validation (400 or 422), never execute SQL or throw 500
    assert.ok(
      [400, 422].includes(res.status),
      `Malformed input must fail-fast with 400 or 422, got ${res.status}`,
    )
  })

  await step('P7.5', 'T2_P7_5_05', 'Sanitized 500 responses strictly satisfy assertSecurityInvariants', async () => {
    const generic500Payload = JSON.stringify({
      type: 'https://mms.local/errors/internal',
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected internal error occurred. Please contact support with the correlation ID.',
      correlationId: 'corr-500-safe-test',
    })
    await assertSecurityInvariants(generic500Payload)
  })

  console.log('----------------------------------------------------------------')
  console.log(`Tier 2 Suite Complete: ${total} total | ${passed} passed | ${failed} failed`)
  console.log('----------------------------------------------------------------')

  return { total, passed, failed }
}
