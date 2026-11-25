import * as fs from 'node:fs'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

// Ensure library path is set for Playwright Chromium dependencies
const depsLibPath = process.env.PLAYWRIGHT_DEPS_LIB_PATH || '/usr/lib/x86_64-linux-gnu'
if (fs.existsSync(depsLibPath)) {
  process.env.LD_LIBRARY_PATH = `${depsLibPath}:${process.env.LD_LIBRARY_PATH ?? ''}`
}

const fontConfigPath = process.env.PLAYWRIGHT_FONT_CONFIG_PATH || '/etc/fontconfig'
if (fs.existsSync(fontConfigPath)) {
  process.env.FONTCONFIG_PATH = fontConfigPath
}

export interface BrowserPersonaSession {
  browser: Browser
  context: BrowserContext
  page: Page
  personaKey: string
}

let sharedBrowser: Browser | null = null

export async function getSharedBrowser(): Promise<Browser> {
  if (!sharedBrowser || !sharedBrowser.isConnected()) {
    sharedBrowser = await chromium.launch({
      headless: true,
      dumpio: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    })
    sharedBrowser.on('disconnected', () => {
      console.warn('[Playwright] Browser disconnected')
    })
  }
  return sharedBrowser
}

export async function closeSharedBrowser(): Promise<void> {
  if (sharedBrowser) {
    await sharedBrowser.close()
    sharedBrowser = null
  }
}

/**
 * Signs into the MMS web application using real browser interaction with /dev/login.
 *
 * In accordance with R8.6-F02:
 * - Uses the real /dev/login flow in browser tests.
 * - Does not inject authorization or cookies directly into Playwright browser storage.
 * - Real browser rendering, real form interaction, real CSRF handling, real redirects.
 */
export async function createBrowserPersonaContext(
  baseUrl: string,
  personaKey: string,
  options: { traceOnFailure?: boolean } = {},
): Promise<BrowserPersonaSession> {
  let browser = await getSharedBrowser()
  let context = await browser.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: {
      'x-forwarded-for': '203.0.113.199',
    },
  })

  let page = await context.newPage()

  // 1. Navigate to /dev/login in the browser
  let response = await page.goto('/dev/login', { waitUntil: 'domcontentloaded' })
  if (!response || response.status() !== 200) {
    throw new Error(
      `Failed to load /dev/login in browser (status ${response?.status()}): ensure ALLOW_DEV_LOGIN=true and APP_ENV in {local, test}`,
    )
  }

  // 2. Locate the specific form for the requested personaKey and click "Sign In"
  // The DevLoginPage renders:
  // <form method="post" action="/dev/login">
  //   <input type="hidden" name="_csrf" ... />
  //   <input type="hidden" name="personaKey" value="..." />
  //   <button type="submit">Sign In</button>
  // </form>
  let personaForm = page.locator(`form:has(input[name="personaKey"][value="${personaKey}"])`)
  let count = await personaForm.count()
  if (count === 0) {
    throw new Error(`Test persona "${personaKey}" not found on /dev/login page`)
  }

  let submitButton = personaForm.locator('button[type="submit"]')
  await Promise.all([
    page.waitForURL((url) => !url.pathname.includes('/dev/login'), { timeout: 10000 }),
    submitButton.click(),
  ])

  return {
    browser,
    context,
    page,
    personaKey,
  }
}
