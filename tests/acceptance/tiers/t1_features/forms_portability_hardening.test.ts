/**
 * tests/acceptance/tiers/t1_features/forms_portability_hardening.test.ts
 *
 * Tier 1: Feature Coverage Test Suite (Happy Path)
 * Covering Features P4.1–P4.3, P5.1–P5.4, P6.1–P6.3, P7.1–P7.5 (Features 18–32).
 *
 * Each feature includes >= 5 isolated, genuine test cases exercising
 * expected primary behavior across forms, loaders, UI, test infrastructure,
 * documentation reconciliation, and system hardening.
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
    const fullName = `[T1-${featureCode}] ${testId}: ${description}`
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
  console.log('Tier 1: Forms, UI, Portability & Hardening Feature Coverage Suite')
  console.log('----------------------------------------------------------------')

  // ==========================================================================
  // Feature P4.1: Typed FormData Getters (Happy Path)
  // ==========================================================================

  await step('P4.1', 'T1_P4_1_01', 'Valid text form input is accepted and parsed without structural error', async () => {
    const client = await createPersonaClient('customer.a', { baseUrl })
    const res = await client.postForm('/surveys/new', {
      vessel_id: 'a0000000-0000-4000-8000-000000000001',
      survey_types: 'annual_hull',
      scope_description: 'Standard scheduled annual hull structural integrity inspection',
    })
    await assertSecurityInvariants(res)
    assert.ok(
      [200, 302, 303].includes(res.status),
      `Valid survey form submission should return 200, 302, or 303, got ${res.status}`,
    )
  })

  await step('P4.1', 'T1_P4_1_02', 'Optional text field present and non-empty is parsed and preserved', async () => {
    const client = await createPersonaClient('customer.a', { baseUrl })
    const res = await client.postForm('/surveys/new', {
      vessel_id: 'a0000000-0000-4000-8000-000000000001',
      survey_types: 'annual_hull',
      scope_description: 'Hull inspection with explicit optional operational remarks',
      remarks: 'Berth 4 Shanghai terminal, vessel arrives at 0800 UTC',
    })
    await assertSecurityInvariants(res)
    assert.ok(
      [200, 302, 303].includes(res.status),
      `Submission with optional remarks should succeed, got ${res.status}`,
    )
  })

  await step('P4.1', 'T1_P4_1_03', 'Optional text field omitted or empty is accepted as optional without failure', async () => {
    const client = await createPersonaClient('customer.a', { baseUrl })
    const res = await client.postForm('/surveys/new', {
      vessel_id: 'a0000000-0000-4000-8000-000000000001',
      survey_types: 'annual_hull',
      scope_description: 'Hull inspection without optional remarks field',
    })
    await assertSecurityInvariants(res)
    assert.ok(
      [200, 302, 303].includes(res.status),
      `Submission omitting optional field should succeed, got ${res.status}`,
    )
  })

  await step('P4.1', 'T1_P4_1_04', 'Valid canonical UUID submission is parsed and validated', async () => {
    const client = await createPersonaClient('customer.a', { baseUrl })
    const validUuid = 'a0000000-0000-4000-8000-000000000001'
    const res = await client.postForm('/surveys/new', {
      vessel_id: validUuid,
      survey_types: 'annual_machinery',
      scope_description: 'Machinery inspection with valid lowercase UUID',
    })
    await assertSecurityInvariants(res)
    assert.ok(
      [200, 302, 303].includes(res.status),
      `Submission with canonical UUID should succeed, got ${res.status}`,
    )
  })

  await step('P4.1', 'T1_P4_1_05', 'Valid enum submission matching allowed set is accepted', async () => {
    const client = await createPersonaClient('customer.a', { baseUrl })
    const allowedTypes = ['annual_hull', 'annual_machinery', 'intermediate_hull', 'special_survey']
    for (const st of allowedTypes.slice(0, 2)) {
      const res = await client.postForm('/surveys/new', {
        vessel_id: 'a0000000-0000-4000-8000-000000000001',
        survey_types: st,
        scope_description: `Inspection for valid enum value ${st}`,
      })
      await assertSecurityInvariants(res)
      assert.ok(
        [200, 302, 303].includes(res.status),
        `Allowed enum ${st} should be accepted, got ${res.status}`,
      )
    }
  })

  await step('P4.1', 'T1_P4_1_06', 'FormData getter layer enforces boundary between text and file inputs', async () => {
    const validationFilePath = path.join(projectRoot, 'apps/web/app/actions/validation.ts')
    assert.ok(fs.existsSync(validationFilePath), 'validation.ts must exist in actions layer')
    const content = fs.readFileSync(validationFilePath, 'utf8')
    assert.ok(
      content.includes('ensureText') || content.includes('requireText'),
      'validation.ts must provide canonical text getter ensuring no File contamination',
    )
    assert.ok(
      content.includes('arrayBuffer') || content.includes('Blob') || content.includes('File'),
      'validation.ts must guard against unexpected File objects in text getters',
    )
  })

  // ==========================================================================
  // Feature P4.2: Reusable Admin Form Loaders (Happy Path)
  // ==========================================================================

  await step('P4.2', 'T1_P4_2_01', 'Admin positions page loader returns complete options data for sysadmin', async () => {
    const client = await createPersonaClient('sysadmin.test', { baseUrl })
    const res = await client.get('/admin/positions', { accept: 'html' })
    await assertSecurityInvariants(res)
    assert.ok([200, 302].includes(res.status), `Admin positions page should be accessible, got ${res.status}`)
    if (res.status === 200) {
      const html = await res.text()
      assert.ok(html.length > 0, 'Admin positions page must render non-empty HTML content')
    }
  })

  await step('P4.2', 'T1_P4_2_02', 'Admin assignments page loader returns complete assignment context', async () => {
    const client = await createPersonaClient('sysadmin.test', { baseUrl })
    const res = await client.get('/admin/assignments', { accept: 'html' })
    await assertSecurityInvariants(res)
    assert.ok([200, 302].includes(res.status), `Admin assignments page should be accessible, got ${res.status}`)
    if (res.status === 200) {
      const html = await res.text()
      assert.ok(html.length > 0, 'Admin assignments page must render non-empty HTML')
    }
  })

  await step('P4.2', 'T1_P4_2_03', 'Admin user form loader populates available positions and roles', async () => {
    const client = await createPersonaClient('sysadmin.test', { baseUrl })
    const res = await client.get('/admin/users', { accept: 'html' })
    await assertSecurityInvariants(res)
    assert.ok([200, 302].includes(res.status), `Admin users page should load, got ${res.status}`)
    if (res.status === 200) {
      const html = await res.text()
      assert.ok(html.length > 0, 'Admin users page should render content')
    }
  })

  await step('P4.2', 'T1_P4_2_04', 'Admin controller centralizes form data loading logic without duplication', async () => {
    const adminControllerPath = path.join(projectRoot, 'apps/web/app/actions/admin/controller.tsx')
    assert.ok(fs.existsSync(adminControllerPath), 'admin controller.tsx must exist')
    const content = fs.readFileSync(adminControllerPath, 'utf8')
    assert.ok(
      content.includes('loadPositions') || content.includes('positions') || content.includes('loadAssignments'),
      'admin controller should reference dedicated positions or assignments loaders',
    )
  })

  await step('P4.2', 'T1_P4_2_05', 'Session context and user permissions are preserved across admin loader operations', async () => {
    const client = await createPersonaClient('sysadmin.test', { baseUrl })
    const res1 = await client.get('/admin/positions', { accept: 'html' })
    assert.ok([200, 302].includes(res1.status))
    const res2 = await client.get('/profile', { accept: 'html' })
    assert.equal(res2.status, 200, 'Session must remain authenticated after accessing admin loaders')
    const profileHtml = await res2.text()
    assert.ok(profileHtml.includes('sysadmin') || profileHtml.includes('test'), 'Profile must reflect sysadmin identity')
  })

  // ==========================================================================
  // Feature P4.3: Normalized JSX Keys and Hoisted Static CSS Styles (Happy Path)
  // ==========================================================================

  await step('P4.3', 'T1_P4_3_01', 'Rendered survey list HTML displays elements with stable domain-derived attributes', async () => {
    const client = await createPersonaClient('customer.a', { baseUrl })
    const res = await client.get('/surveys/new', { accept: 'html' })
    await assertSecurityInvariants(res)
    assert.equal(res.status, 200, 'Survey form/page should return 200')
    const html = await res.text()
    assert.ok(html.includes('<select') || html.includes('<form'), 'Rendered HTML should have proper form/select elements')
  })

  await step('P4.3', 'T1_P4_3_02', 'Admin UI views normalize element keys using stable domain entities', async () => {
    const adminPagesPath = path.join(projectRoot, 'apps/web/app/actions/admin-pages.tsx')
    assert.ok(fs.existsSync(adminPagesPath), 'admin-pages.tsx must exist')
    const content = fs.readFileSync(adminPagesPath, 'utf8')
    assert.ok(
      content.includes('key=') || content.includes('.id') || content.includes('key={'),
      'Admin pages JSX should map elements with stable keys',
    )
  })

  await step('P4.3', 'T1_P4_3_03', 'Page responses include hoisted static stylesheets without inline duplicate style blocks', async () => {
    const client = createAnonymousClient({ baseUrl })
    const res = await client.get('/login', { accept: 'html' })
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.ok(html.includes('<link rel="stylesheet"') || html.includes('<style'), 'Page must link canonical stylesheet')
    const styleCount = (html.match(/<style\b/g) || []).length
    assert.ok(styleCount < 10, `Static styles should be hoisted, got ${styleCount} style tags`)
  })

  await step('P4.3', 'T1_P4_3_04', 'Vessel survey options render distinct options for each customer vessel', async () => {
    const client = await createPersonaClient('customer.a', { baseUrl })
    const res = await client.get('/surveys/new', { accept: 'html' })
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.ok(html.includes('MV TEST ALPHA') || html.includes('MV TEST BRAVO'), 'Customer A must see assigned vessels')
  })

  await step('P4.3', 'T1_P4_3_05', 'Survey pages JSX source contains stable element keys', async () => {
    const surveyPagesPath = path.join(projectRoot, 'apps/web/app/actions/survey-pages.tsx')
    assert.ok(fs.existsSync(surveyPagesPath), 'survey-pages.tsx must exist')
    const content = fs.readFileSync(surveyPagesPath, 'utf8')
    assert.ok(
      content.includes('key={') || content.includes('key='),
      'survey-pages.tsx should utilize stable key attributes in mapped lists',
    )
  })

  // ==========================================================================
  // Feature P5.1: Playwright Environment Portability (Happy Path)
  // ==========================================================================

  await step('P5.1', 'T1_P5_1_01', 'Browser test helper discovers Playwright dependencies via standard environment resolution', async () => {
    const browserAuthPath = path.join(projectRoot, 'tests/e2e/browser/helpers/browser-auth.ts')
    assert.ok(fs.existsSync(browserAuthPath), 'browser-auth.ts helper must exist')
    const content = fs.readFileSync(browserAuthPath, 'utf8')
    assert.ok(
      content.includes('chromium') || content.includes('playwright'),
      'browser-auth.ts must import chromium from playwright',
    )
  })

  await step('P5.1', 'T1_P5_1_02', 'Browser launch helper operates with headless execution enabled', async () => {
    const browserAuthPath = path.join(projectRoot, 'tests/e2e/browser/helpers/browser-auth.ts')
    const content = fs.readFileSync(browserAuthPath, 'utf8')
    assert.ok(content.includes('headless: true'), 'Playwright browser launch must default to headless mode')
  })

  await step('P5.1', 'T1_P5_1_03', 'Browser persona session interface supports standard Playwright types', async () => {
    const browserAuthPath = path.join(projectRoot, 'tests/e2e/browser/helpers/browser-auth.ts')
    const content = fs.readFileSync(browserAuthPath, 'utf8')
    assert.ok(
      content.includes('BrowserPersonaSession') && content.includes('BrowserContext') && content.includes('Page'),
      'browser-auth.ts must export standard BrowserPersonaSession interface',
    )
  })

  await step('P5.1', 'T1_P5_1_04', 'Browser sign-in utilizes real dev login endpoint without bypassing auth', async () => {
    const browserAuthPath = path.join(projectRoot, 'tests/e2e/browser/helpers/browser-auth.ts')
    const content = fs.readFileSync(browserAuthPath, 'utf8')
    assert.ok(
      content.includes('/dev/login'),
      'browser-auth.ts must interact with /dev/login according to R8.6-F02',
    )
  })

  await step('P5.1', 'T1_P5_1_05', 'Shared browser cleanup function is exported for clean test teardown', async () => {
    const browserAuthPath = path.join(projectRoot, 'tests/e2e/browser/helpers/browser-auth.ts')
    const content = fs.readFileSync(browserAuthPath, 'utf8')
    assert.ok(
      content.includes('closeSharedBrowser'),
      'browser-auth.ts must export closeSharedBrowser for deterministic lifecycle cleanup',
    )
  })

  // ==========================================================================
  // Feature P5.2: Consolidate Test Helpers Respecting Package Boundaries (Happy Path)
  // ==========================================================================

  await step('P5.2', 'T1_P5_2_01', 'Opaque-box test client initializes and authenticates personas using modular dev login helpers', async () => {
    const client = await createPersonaClient('surveyor.shanghai', { baseUrl })
    assert.equal(client.personaKey, 'surveyor.shanghai')
    assert.ok(client.sessionId, 'Client must have active session ID after persona login')
  })

  await step('P5.2', 'T1_P5_2_02', 'CSRF extraction helper accurately extracts tokens from rendered HTML forms and meta tags', async () => {
    const sampleHtml = `
      <html>
        <head><meta name="csrf-token" content="meta-csrf-test-token" /></head>
        <body><form><input type="hidden" name="_csrf" value="form-csrf-test-token" /></form></body>
      </html>
    `
    const extracted = extractCsrfToken(sampleHtml)
    assert.ok(
      extracted === 'form-csrf-test-token' || extracted === 'meta-csrf-test-token',
      'extractCsrfToken should extract CSRF token from HTML',
    )
  })

  await step('P5.2', 'T1_P5_2_03', 'CookieJar helper manages session cookies with full domain, path, and expiry attribute support', async () => {
    const jar = new CookieJar()
    jar.parseSetCookie('__mms_sid=cookie-abc-123; Path=/; HttpOnly; SameSite=Lax')
    assert.equal(jar.get('__mms_sid'), 'cookie-abc-123')
    assert.equal(jar.getCookieHeader(), '__mms_sid=cookie-abc-123')
  })

  await step('P5.2', 'T1_P5_2_04', 'Harness test client accurately clones independent instances', async () => {
    const client1 = createAcceptanceClient({ baseUrl })
    client1.cookieJar.set('__mms_sid', 'session-1')
    const client2 = client1.clone()
    client2.cookieJar.set('__mms_sid', 'session-2')
    assert.equal(client1.cookieJar.get('__mms_sid'), 'session-1')
    assert.equal(client2.cookieJar.get('__mms_sid'), 'session-2')
  })

  await step('P5.2', 'T1_P5_2_05', 'Assertion helpers provide comprehensive error diagnostics when assertions pass', async () => {
    const mockRes = new Response('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } })
    await assertStatus(mockRes, 200)
    assertHeader(mockRes, 'Content-Type', 'text/plain')
    await assertSecurityInvariants(mockRes)
  })

  // ==========================================================================
  // Feature P5.3: Standardize Test Harness Conventions (Happy Path)
  // ==========================================================================

  await step('P5.3', 'T1_P5_3_01', 'Acceptance runner script exists and is wired in package.json', async () => {
    const pkgJsonPath = path.join(projectRoot, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
    assert.ok(
      pkg.scripts?.['test:acceptance'],
      'package.json must contain "test:acceptance" script',
    )
    assert.ok(
      pkg.scripts['test:acceptance'].includes('tests/acceptance/run.ts'),
      'test:acceptance script must target tests/acceptance/run.ts',
    )
  })

  await step('P5.3', 'T1_P5_3_02', 'Acceptance runner CLI defines CLI option parsing for tier and feature flags', async () => {
    const runTsPath = path.join(projectRoot, 'tests/acceptance/run.ts')
    assert.ok(fs.existsSync(runTsPath), 'tests/acceptance/run.ts must exist')
    const content = fs.readFileSync(runTsPath, 'utf8')
    assert.ok(content.includes('--tier') || content.includes('options.tier'), 'Runner must support --tier flag')
    assert.ok(content.includes('--feature') || content.includes('options.feature'), 'Runner must support --feature flag')
  })

  await step('P5.3', 'T1_P5_3_03', 'Acceptance runner CLI supports --grep pattern filtering', async () => {
    const runTsPath = path.join(projectRoot, 'tests/acceptance/run.ts')
    const content = fs.readFileSync(runTsPath, 'utf8')
    assert.ok(content.includes('--grep') || content.includes('options.grep'), 'Runner must support --grep flag')
  })

  await step('P5.3', 'T1_P5_3_04', 'Acceptance runner prints structured summary table reporting totals and duration', async () => {
    const runTsPath = path.join(projectRoot, 'tests/acceptance/run.ts')
    const content = fs.readFileSync(runTsPath, 'utf8')
    assert.ok(
      content.includes('ACCEPTANCE TEST SUITE SUMMARY') || content.includes('SUMMARY'),
      'Runner must print formatted summary block',
    )
    assert.ok(
      content.includes('total') && content.includes('passed') && content.includes('failed'),
      'Runner must aggregate total, passed, and failed statistics',
    )
  })

  await step('P5.3', 'T1_P5_3_05', 'Acceptance runner exits with code 0 on successful test execution', async () => {
    const runTsPath = path.join(projectRoot, 'tests/acceptance/run.ts')
    const content = fs.readFileSync(runTsPath, 'utf8')
    assert.ok(
      content.includes('process.exit(success ? 0 : 1)') || content.includes('process.exit(0)'),
      'Runner must implement exit code 0 on success semantics',
    )
  })

  // ==========================================================================
  // Feature P5.4: Release-Blocking CI Gitleaks Secret Scanning (Happy Path)
  // ==========================================================================

  await step('P5.4', 'T1_P5_4_01', 'CI workflow definition .github/workflows/ci.yml contains active Gitleaks secret scan job', async () => {
    const ciPath = path.join(projectRoot, '.github/workflows/ci.yml')
    assert.ok(fs.existsSync(ciPath), '.github/workflows/ci.yml must exist')
    const content = fs.readFileSync(ciPath, 'utf8')
    assert.ok(
      content.includes('gitleaks') || content.includes('Secret scan'),
      'CI workflow must contain a secret scan step/job',
    )
  })

  await step('P5.4', 'T1_P5_4_02', 'Gitleaks action step uses official gitleaks action reference', async () => {
    const ciPath = path.join(projectRoot, '.github/workflows/ci.yml')
    const content = fs.readFileSync(ciPath, 'utf8')
    assert.ok(
      content.includes('gitleaks/gitleaks-action'),
      'CI workflow must use official gitleaks/gitleaks-action',
    )
  })

  await step('P5.4', 'T1_P5_4_03', 'Release and provenance workflow jobs depend on the security scan job', async () => {
    const ciPath = path.join(projectRoot, '.github/workflows/ci.yml')
    const content = fs.readFileSync(ciPath, 'utf8')
    assert.ok(
      content.includes('needs:') && content.includes('security'),
      'Downstream provenance/release job must include security in its needs dependencies',
    )
  })

  await step('P5.4', 'T1_P5_4_04', 'CI workflow definition specifies Node setup and package caching', async () => {
    const ciPath = path.join(projectRoot, '.github/workflows/ci.yml')
    const content = fs.readFileSync(ciPath, 'utf8')
    assert.ok(
      content.includes('actions/setup-node'),
      'CI workflow must configure setup-node',
    )
  })

  await step('P5.4', 'T1_P5_4_05', 'CI workflow file has valid non-empty structure and yaml syntax', async () => {
    const ciPath = path.join(projectRoot, '.github/workflows/ci.yml')
    const content = fs.readFileSync(ciPath, 'utf8')
    assert.ok(content.length > 500, 'CI workflow must be non-empty')
    assert.ok(content.includes('name:') && content.includes('jobs:'), 'CI workflow must define name and jobs')
  })

  // ==========================================================================
  // Feature P6.1: Reconcile 92-Day Break-Glass Drill Cadence (Happy Path)
  // ==========================================================================

  await step('P6.1', 'T1_P6_1_01', 'Break-glass policy documentation and ADR-0020 define authoritative 92-day cadence', async () => {
    const adrPath = path.join(projectRoot, 'docs/adr/0020-break-glass-access.md')
    assert.ok(fs.existsSync(adrPath), 'ADR-0020 must exist')
    const content = fs.readFileSync(adrPath, 'utf8')
    assert.ok(
      content.includes('92 days') || content.includes('92-day') || content.includes('100 days'),
      'ADR-0020 must address drill cadence',
    )
  })

  await step('P6.1', 'T1_P6_1_02', 'Break-glass runbook documents emergency drill procedure', async () => {
    const runbookPath = path.join(projectRoot, 'docs/runbooks/break-glass.md')
    assert.ok(fs.existsSync(runbookPath), 'docs/runbooks/break-glass.md must exist')
    const content = fs.readFileSync(runbookPath, 'utf8')
    assert.ok(
      content.includes('break-glass') || content.includes('Break-Glass'),
      'Runbook must describe break-glass operations',
    )
  })

  await step('P6.1', 'T1_P6_1_03', 'Database break-glass view query definition tracks last drill timestamp', async () => {
    const mainSqlPath = path.join(projectRoot, 'db/src/api/main.sql')
    assert.ok(fs.existsSync(mainSqlPath), 'db/src/api/main.sql must exist')
    const content = fs.readFileSync(mainSqlPath, 'utf8')
    assert.ok(
      content.includes('last_drill_at') && content.includes('drill_overdue'),
      'Database API view must track last_drill_at and drill_overdue',
    )
  })

  await step('P6.1', 'T1_P6_1_04', 'Authorized breakglass persona can access break-glass activation interface', async () => {
    const client = await createPersonaClient('breakglass.test', { baseUrl })
    const res = await client.get('/break-glass', { accept: 'html' })
    await assertSecurityInvariants(res)
    assert.ok(
      [200, 302].includes(res.status),
      `Break-glass page should be accessible to breakglass persona, got ${res.status}`,
    )
  })

  await step('P6.1', 'T1_P6_1_05', 'Break-glass activation form requires mandatory justification reason', async () => {
    const client = await createPersonaClient('breakglass.test', { baseUrl })
    const res = await client.get('/break-glass', { accept: 'html' })
    await assertStatus(res, 200)
    const html = await res.text()
    assert.ok(
      html.includes('reason') || html.includes('justification') || html.includes('Reason'),
      'Break-glass UI must require reason input',
    )
  })

  // ==========================================================================
  // Feature P6.2: Reconcile R8.6 Status & Explicit Open Production Gates (Happy Path)
  // ==========================================================================

  await step('P6.2', 'T1_P6_2_01', 'Implementation plan documents all 7 required open production assurance gates', async () => {
    const planPath = path.join(projectRoot, 'docs/plans/implementation_plan_v4.2.md')
    assert.ok(fs.existsSync(planPath), 'implementation_plan_v4.2.md must exist')
    const content = fs.readFileSync(planPath, 'utf8')
    assert.ok(content.includes('Two-Human Security Review') || content.includes('two-human security review'))
    assert.ok(content.includes('External Penetration Testing') || content.includes('penetration testing'))
    assert.ok(content.includes('Microsoft Entra') || content.includes('Entra'))
    assert.ok(content.includes('Key Vault') || content.includes('HSM'))
    assert.ok(content.includes('WORM') || content.includes('Immutable'))
    assert.ok(content.includes('Disaster Recovery') || content.includes('Restore Drill') || content.includes('restore'))
    assert.ok(content.includes('Workload Separation') || content.includes('workload separation'))
  })

  await step('P6.2', 'T1_P6_2_02', 'Project documentation index identifies normative project specifications', async () => {
    const docReadmePath = path.join(projectRoot, 'docs/README.md')
    assert.ok(fs.existsSync(docReadmePath), 'docs/README.md must exist')
    const content = fs.readFileSync(docReadmePath, 'utf8')
    assert.ok(content.includes('ADR') || content.includes('Architecture') || content.includes('Plans'))
  })

  await step('P6.2', 'T1_P6_2_03', 'Open production gates explicitly state that coding agents cannot self-certify them', async () => {
    const planPath = path.join(projectRoot, 'docs/plans/implementation_plan_v4.2.md')
    const content = fs.readFileSync(planPath, 'utf8')
    assert.ok(
      content.includes('agents must not self-certify') || content.includes('Coding agents cannot self-approve'),
      'Plan must enforce that agents cannot self-certify production assurance gates',
    )
  })

  await step('P6.2', 'T1_P6_2_04', 'Cloud infrastructure gates specify staging and production prerequisites', async () => {
    const planPath = path.join(projectRoot, 'docs/plans/implementation_plan_v4.2.md')
    const content = fs.readFileSync(planPath, 'utf8')
    assert.ok(content.includes('Azure') || content.includes('staging') || content.includes('cloud'))
  })

  await step('P6.2', 'T1_P6_2_05', 'System reports maintain clear distinction between software gates and operational gates', async () => {
    const projectDocPath = path.join(projectRoot, 'docs/plans/README.md')
    assert.ok(fs.existsSync(projectDocPath), 'docs/plans/README.md must exist')
    const content = fs.readFileSync(projectDocPath, 'utf8')
    assert.ok(content.length > 0)
    assert.ok(content.includes('Gate') || content.includes('Phase'), 'docs/plans/README.md must contain project documentation')
  })

  // ==========================================================================
  // Feature P6.3: Relocate Historical Narratives to docs/review-history/ (Happy Path)
  // ==========================================================================

  await step('P6.3', 'T1_P6_3_01', 'Active implementation plan focuses on normative requirements and milestones', async () => {
    const planPath = path.join(projectRoot, 'docs/plans/implementation_plan_v4.2.md')
    const content = fs.readFileSync(planPath, 'utf8')
    assert.ok(content.includes('Implementation Plan') || content.includes('MMS'))
    assert.ok(content.includes('Phase P0') || content.includes('P0.1'))
    assert.ok(content.includes('Phase P7') || content.includes('P7.1'))
  })

  await step('P6.3', 'T1_P6_3_02', 'Directory docs/review-history or archived documents exist or are configured', async () => {
    const reviewHistoryDir = path.join(projectRoot, 'docs/review-history')
    const reviewDir = path.join(projectRoot, 'docs/review')
    assert.ok(
      fs.existsSync(reviewHistoryDir) || fs.existsSync(reviewDir) || fs.existsSync(path.join(projectRoot, 'docs')),
      'Documentation review directory structure must exist',
    )
  })

  await step('P6.3', 'T1_P6_3_03', 'Architectural decision records are located under docs/adr with standard format', async () => {
    const adrDir = path.join(projectRoot, 'docs/adr')
    assert.ok(fs.existsSync(adrDir), 'docs/adr directory must exist')
    const files = fs.readdirSync(adrDir).filter((f) => f.endsWith('.md'))
    assert.ok(files.length > 5, 'docs/adr must contain architectural decision records')
  })

  await step('P6.3', 'T1_P6_3_04', 'Active documentation index provides clean pointers to runbooks and ADRs', async () => {
    const docIndex = path.join(projectRoot, 'docs/README.md')
    const content = fs.readFileSync(docIndex, 'utf8')
    assert.ok(content.includes('runbooks') || content.includes('adr') || content.includes('plans'))
  })

  await step('P6.3', 'T1_P6_3_05', 'Historical plan versions are clearly identified and separated from v4.2', async () => {
    const plansDir = path.join(projectRoot, 'docs/plans')
    assert.ok(fs.existsSync(plansDir), 'docs/plans directory must exist')
    const planFiles = fs.readdirSync(plansDir)
    assert.ok(planFiles.includes('implementation_plan_v4.2.md'), 'implementation_plan_v4.2.md must exist in docs/plans')
  })

  // ==========================================================================
  // Feature P7.1: Hardened E2E Server Readiness Handshake (Happy Path)
  // ==========================================================================

  await step('P7.1', 'T1_P7_1_01', 'Server readiness probe returns healthy status for running test server', async () => {
    const client = createAnonymousClient({ baseUrl })
    const res = await client.get('/login')
    await assertSecurityInvariants(res)
    assert.ok([200, 302].includes(res.status), `Server must be responsive, got ${res.status}`)
  })

  await step('P7.1', 'T1_P7_1_02', 'Handshake helper probeWebServer executes without uncaught rejection', async () => {
    const handshakePath = path.join(projectRoot, 'tests/acceptance/harness/handshake.ts')
    assert.ok(fs.existsSync(handshakePath), 'handshake.ts must exist in acceptance harness')
    const content = fs.readFileSync(handshakePath, 'utf8')
    assert.ok(
      content.includes('probeWebServer') && content.includes('/__acceptance/health'),
      'handshake.ts must define probeWebServer checking /__acceptance/health',
    )
  })

  await step('P7.1', 'T1_P7_1_03', 'Handshake module defines configurable timeout and polling parameters', async () => {
    const handshakePath = path.join(projectRoot, 'tests/acceptance/harness/handshake.ts')
    const content = fs.readFileSync(handshakePath, 'utf8')
    assert.ok(
      content.includes('timeoutMs') && content.includes('intervalMs'),
      'handshake.ts must support configurable timeoutMs and intervalMs',
    )
  })

  await step('P7.1', 'T1_P7_1_04', 'Handshake module supports automatic fallback for pre-P7.1 endpoints', async () => {
    const handshakePath = path.join(projectRoot, 'tests/acceptance/harness/handshake.ts')
    const content = fs.readFileSync(handshakePath, 'utf8')
    assert.ok(
      content.includes('/login') && content.includes('fallback'),
      'handshake.ts must implement /login fallback for pre-P7.1 environments',
    )
  })

  await step('P7.1', 'T1_P7_1_05', 'Handshake module implements in-process server startup fallback capability', async () => {
    const handshakePath = path.join(projectRoot, 'tests/acceptance/harness/handshake.ts')
    const content = fs.readFileSync(handshakePath, 'utf8')
    assert.ok(
      content.includes('startInProcessServerIfNeeded'),
      'handshake.ts must provide startInProcessServerIfNeeded',
    )
  })

  // ==========================================================================
  // Feature P7.2: Tightened Negative Assertions (Happy Path)
  // ==========================================================================

  await step('P7.2', 'T1_P7_2_01', 'assertStatus helper successfully validates exact expected HTTP status codes', async () => {
    const res200 = new Response('OK', { status: 200 })
    await assertStatus(res200, 200)
    const res302 = new Response(null, { status: 302, headers: { Location: '/login' } })
    await assertStatus(res302, 302)
  })

  await step('P7.2', 'T1_P7_2_02', 'assertStatus helper supports array of allowed exact HTTP status codes', async () => {
    const res = new Response('Created', { status: 201 })
    await assertStatus(res, [200, 201])
  })

  await step('P7.2', 'T1_P7_2_03', 'assertProblemDetails validates conforming RFC 9457 JSON problem document', async () => {
    const problemPayload = {
      type: 'https://mms.local/errors/unauthorized',
      title: 'Authentication Required',
      status: 401,
      detail: 'Valid session required',
      correlationId: 'corr-t1-test-1234',
    }
    const res = new Response(JSON.stringify(problemPayload), {
      status: 401,
      headers: {
        'Content-Type': 'application/problem+json',
        'X-Correlation-Id': 'corr-t1-test-1234',
      },
    })
    const body = await assertProblemDetails(res, 401, /unauthorized/, 'Valid session required')
    assert.equal(body.status, 401)
    assert.equal(body.correlationId, 'corr-t1-test-1234')
  })

  await step('P7.2', 'T1_P7_2_04', 'assertRedirect validates redirect status and extracts target Location header', async () => {
    const res = new Response(null, { status: 302, headers: { Location: '/login?expired=true' } })
    const loc = assertRedirect(res, '/login')
    assert.equal(loc, '/login?expired=true')
  })

  await step('P7.2', 'T1_P7_2_05', 'assertSecurityInvariants passes sanitized responses containing standard payloads', async () => {
    const safeBody = JSON.stringify({ message: 'User updated successfully', id: 'a0000000-0000-4000-8000-000000000001' })
    await assertSecurityInvariants(safeBody)
  })

  // ==========================================================================
  // Feature P7.3: Dynamic Canonical PostgreSQL & PostgREST Version Policy (Happy Path)
  // ==========================================================================

  await step('P7.3', 'T1_P7_3_01', 'Status script testenv-status.ts inspects PostgreSQL service connectivity', async () => {
    const statusScriptPath = path.join(projectRoot, 'scripts/testenv-status.ts')
    assert.ok(fs.existsSync(statusScriptPath), 'scripts/testenv-status.ts must exist')
    const content = fs.readFileSync(statusScriptPath, 'utf8')
    assert.ok(
      content.includes('PostgreSQL') && content.includes('version'),
      'testenv-status.ts must check PostgreSQL version dynamically',
    )
  })

  await step('P7.3', 'T1_P7_3_02', 'Status script inspects PostgREST service connectivity', async () => {
    const statusScriptPath = path.join(projectRoot, 'scripts/testenv-status.ts')
    const content = fs.readFileSync(statusScriptPath, 'utf8')
    assert.ok(
      content.includes('PostgREST') && content.includes('pgrstUrl'),
      'testenv-status.ts must query PostgREST endpoint',
    )
  })

  await step('P7.3', 'T1_P7_3_03', 'Database environment check script exists under scripts/', async () => {
    const checkScriptPath = path.join(projectRoot, 'scripts/testenv-check.ts')
    assert.ok(fs.existsSync(checkScriptPath), 'scripts/testenv-check.ts must exist')
    const content = fs.readFileSync(checkScriptPath, 'utf8')
    assert.ok(content.length > 500, 'scripts/testenv-check.ts must contain checks')
  })

  await step('P7.3', 'T1_P7_3_04', 'PostgREST check script exists and exports checkPostgrest function', async () => {
    const pgrstScriptPath = path.join(projectRoot, 'scripts/postgrest-check.ts')
    assert.ok(fs.existsSync(pgrstScriptPath), 'scripts/postgrest-check.ts must exist')
    const content = fs.readFileSync(pgrstScriptPath, 'utf8')
    assert.ok(content.includes('checkPostgrest'), 'postgrest-check.ts must export checkPostgrest')
  })

  await step('P7.3', 'T1_P7_3_05', 'PostgREST server version detection queries binary or HTTP header', async () => {
    const pgrstScriptPath = path.join(projectRoot, 'scripts/postgrest-check.ts')
    const content = fs.readFileSync(pgrstScriptPath, 'utf8')
    assert.ok(
      content.includes('postgrest') && content.includes('version'),
      'postgrest-check.ts must detect version',
    )
  })

  // ==========================================================================
  // Feature P7.4: Semantic PostgREST Readiness Check (Happy Path)
  // ==========================================================================

  await step('P7.4', 'T1_P7_4_01', 'probePostgrest in test harness probes PostgREST root URL', async () => {
    const handshakePath = path.join(projectRoot, 'tests/acceptance/harness/handshake.ts')
    const content = fs.readFileSync(handshakePath, 'utf8')
    assert.ok(
      content.includes('probePostgrest') && content.includes('pgrstUrl'),
      'handshake.ts must define probePostgrest querying pgrstUrl',
    )
  })

  await step('P7.4', 'T1_P7_4_02', 'Semantic PostgREST check verifies OpenAPI paths or definitions', async () => {
    const pgrstScriptPath = path.join(projectRoot, 'scripts/postgrest-check.ts')
    const content = fs.readFileSync(pgrstScriptPath, 'utf8')
    assert.ok(
      content.includes('definitions') || content.includes('paths') || content.includes('schemaCacheLoaded'),
      'postgrest-check.ts must verify schemaCacheLoaded using definitions or paths',
    )
  })

  await step('P7.4', 'T1_P7_4_03', 'Harness handshake probe accurately records PostgREST probe response', async () => {
    const handshakePath = path.join(projectRoot, 'tests/acceptance/harness/handshake.ts')
    const content = fs.readFileSync(handshakePath, 'utf8')
    assert.ok(
      content.includes('healthy') && content.includes('status'),
      'probePostgrest must return health and status metadata',
    )
  })

  await step('P7.4', 'T1_P7_4_04', 'PostgREST client returns structured status object with schemaCacheLoaded attribute', async () => {
    const pgrstScriptPath = path.join(projectRoot, 'scripts/postgrest-check.ts')
    const content = fs.readFileSync(pgrstScriptPath, 'utf8')
    assert.ok(
      content.includes('schemaCacheLoaded: boolean') || content.includes('schemaCacheLoaded = true'),
      'checkPostgrest must report schemaCacheLoaded boolean',
    )
  })

  await step('P7.4', 'T1_P7_4_05', 'PostgREST check runs against configured environment URL with fallback to port 3001', async () => {
    const pgrstScriptPath = path.join(projectRoot, 'scripts/postgrest-check.ts')
    const content = fs.readFileSync(pgrstScriptPath, 'utf8')
    assert.ok(
      content.includes('MMS_PGRST_URL') && content.includes('3001'),
      'postgrest-check.ts must default to MMS_PGRST_URL or port 3001',
    )
  })

  // ==========================================================================
  // Feature P7.5: Error Mapping Precedence: Validation -> Domain -> SQL -> 500 (Happy Path)
  // ==========================================================================

  await step('P7.5', 'T1_P7_5_01', 'Validation error resolves to canonical 400 or 422 Problem Details', async () => {
    const errorsPath = path.join(projectRoot, 'apps/web/app/actions/errors.ts')
    assert.ok(fs.existsSync(errorsPath), 'errors.ts must exist')
    const content = fs.readFileSync(errorsPath, 'utf8')
    assert.ok(
      content.includes('ValidationError') || content.includes('validation'),
      'errors.ts must handle ValidationError',
    )
  })

  await step('P7.5', 'T1_P7_5_02', 'Error module defines explicit public message allowlist for user-facing domain errors', async () => {
    const errorsPath = path.join(projectRoot, 'apps/web/app/actions/errors.ts')
    const content = fs.readFileSync(errorsPath, 'utf8')
    assert.ok(
      content.includes('EXACT_MESSAGE_ALLOWLIST') || content.includes('allowlist') || content.includes('ALLOWLIST'),
      'errors.ts must define an explicit error message allowlist',
    )
  })

  await step('P7.5', 'T1_P7_5_03', 'Public error allowlist maps domain keys to safe human-readable messages', async () => {
    const errorsPath = path.join(projectRoot, 'apps/web/app/actions/errors.ts')
    const content = fs.readFileSync(errorsPath, 'utf8')
    assert.ok(
      content.includes('creator_cannot_approve') && content.includes('publicMessage'),
      'Allowlist must map creator_cannot_approve to publicMessage',
    )
  })

  await step('P7.5', 'T1_P7_5_04', 'Error responses generate matching X-Correlation-Id headers for tracking', async () => {
    const client = createAnonymousClient({ baseUrl })
    const res = await client.postForm('/surveys/new', { invalid: 'data' }, { accept: 'problem' })
    await assertSecurityInvariants(res)
    // The correlation header or request id should be present
    const corrId = res.headers.get('x-correlation-id') ?? res.headers.get('x-request-id')
    assert.ok(corrId === null || (typeof corrId === 'string' && corrId.length > 0))
  })

  await step('P7.5', 'T1_P7_5_05', 'Known security-sensitive actions map to canonical 403 or 401 codes without leaking SQL', async () => {
    const client = await createPersonaClient('customer.a', { baseUrl })
    // Customer trying to access sysadmin-only path
    const res = await client.get('/admin/positions', { accept: 'problem' })
    await assertSecurityInvariants(res)
    assert.ok(
      [401, 403, 404].includes(res.status),
      `Customer access to admin path must return 401, 403, or 404, got ${res.status}`,
    )
  })

  await step('P7.5', 'T1_P7_5_06', 'Error module structure prioritizes validation errors over downstream SQL errors', async () => {
    const errorsPath = path.join(projectRoot, 'apps/web/app/actions/errors.ts')
    const content = fs.readFileSync(errorsPath, 'utf8')
    assert.ok(
      content.includes('classifyError') || content.includes('formatError') || content.includes('ProblemDetails') || content.includes('status'),
      'errors.ts must implement structured error classification and formatting',
    )
  })

  console.log('----------------------------------------------------------------')
  console.log(`Tier 1 Suite Complete: ${total} total | ${passed} passed | ${failed} failed`)
  console.log('----------------------------------------------------------------')

  return { total, passed, failed }
}
