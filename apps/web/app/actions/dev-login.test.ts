import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { ensureTestJwtKey, extractCsrfToken, extractFirstCookie } from '@mms/test-utils'

import { router as _router } from '../router.ts'
import { DEV_PERSONAS } from '../auth/dev-personas.ts'

ensureTestJwtKey()

const TEST_IP = '203.0.113.86'
const router = {
  fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    let url = typeof input === 'string' ? new URL(input, 'http://localhost') : input
    return _router.fetch(url, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), 'x-forwarded-for': TEST_IP },
    })
  },
}

const savedEnv = { ...process.env }

describe('Dev Persona Login (/dev/login)', () => {
  beforeEach(() => {
    process.env.APP_ENV = 'test'
    process.env.NODE_ENV = 'test'
    process.env.ALLOW_DEV_LOGIN = 'true'
  })

  afterEach(() => {
    process.env = { ...savedEnv }
  })

  it('GET /dev/login returns 404 when APP_ENV=production', async () => {
    process.env.APP_ENV = 'production'
    delete process.env.ALLOW_DEV_LOGIN
    let res = await router.fetch('/dev/login')
    assert.equal(res.status, 404)
  })

  it('POST /dev/login returns 404 when APP_ENV=production (with CSRF token)', async () => {
    // 1. Fetch CSRF token from standard login page
    let pageRes = await router.fetch('/login')
    let html = await pageRes.text()
    let csrf = extractCsrfToken(html)
    let cookie = extractFirstCookie(pageRes.headers.get('set-cookie'))

    // 2. Set production env
    process.env.APP_ENV = 'production'
    delete process.env.ALLOW_DEV_LOGIN

    let res = await router.fetch('/dev/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie,
      },
      body: new URLSearchParams({
        _csrf: csrf,
        personaKey: 'surveyor.shanghai',
      }).toString(),
    })
    assert.equal(res.status, 404)
  })

  it('GET /dev/login returns 404 when ALLOW_DEV_LOGIN is not set', async () => {
    delete process.env.ALLOW_DEV_LOGIN
    let res = await router.fetch('/dev/login')
    assert.equal(res.status, 404)
  })

  it('GET /dev/login renders all 15 test personas when enabled', async () => {
    let res = await router.fetch('/dev/login')
    assert.equal(res.status, 200)
    let html = await res.text()
    assert.ok(html.includes('R8.6 Acceptance Test Persona Sign-In'))

    for (let persona of DEV_PERSONAS) {
      assert.ok(html.includes(persona.name), `Missing persona name in UI: ${persona.name}`)
      assert.ok(html.includes(persona.email), `Missing persona email in UI: ${persona.email}`)
      assert.ok(html.includes(persona.role), `Missing persona role in UI: ${persona.role}`)
    }
  })

  it('POST /dev/login establishes session for surveyor.shanghai persona', async () => {
    // 1. Fetch CSRF token
    let pageRes = await router.fetch('/dev/login')
    let html = await pageRes.text()
    let csrf = extractCsrfToken(html)
    assert.ok(csrf, 'CSRF token must be present')
    let cookie = extractFirstCookie(pageRes.headers.get('set-cookie'))

    // 2. Submit dev login for surveyor.shanghai
    let postRes = await router.fetch('/dev/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie,
      },
      body: new URLSearchParams({
        _csrf: csrf,
        personaKey: 'surveyor.shanghai',
      }).toString(),
    })

    assert.equal(postRes.status, 302)
    assert.equal(postRes.headers.get('location'), '/profile')
    let newCookie = postRes.headers.get('set-cookie')
    assert.ok(newCookie, 'Must set session cookie on login')
  })

  it('POST /dev/login establishes session for external.customer.a persona', async () => {
    let pageRes = await router.fetch('/dev/login')
    let html = await pageRes.text()
    let csrf = extractCsrfToken(html)
    let cookie = extractFirstCookie(pageRes.headers.get('set-cookie'))

    let postRes = await router.fetch('/dev/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie,
      },
      body: new URLSearchParams({
        _csrf: csrf,
        personaKey: 'customer.a',
      }).toString(),
    })

    assert.equal(postRes.status, 302)
    assert.equal(postRes.headers.get('location'), '/profile')
  })

  it('POST /dev/login with unknown persona returns error and does not authenticate', async () => {
    let pageRes = await router.fetch('/dev/login')
    let html = await pageRes.text()
    let csrf = extractCsrfToken(html)
    let cookie = extractFirstCookie(pageRes.headers.get('set-cookie'))

    let postRes = await router.fetch('/dev/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie,
      },
      body: new URLSearchParams({
        _csrf: csrf,
        personaKey: 'nonexistent.persona',
      }).toString(),
    })

    assert.equal(postRes.status, 422)
    let responseHtml = await postRes.text()
    assert.ok(responseHtml.includes('Unknown test persona.'))
  })

  it('POST /dev/login ignores caller-supplied role and resolves role strictly on the server', async () => {
    let pageRes = await router.fetch('/dev/login')
    let html = await pageRes.text()
    let csrf = extractCsrfToken(html)
    let cookie = extractFirstCookie(pageRes.headers.get('set-cookie'))

    let postRes = await router.fetch('/dev/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie,
      },
      body: new URLSearchParams({
        _csrf: csrf,
        personaKey: 'customer.a',
        role: 'int_sysadmin', // Attacker attempts to inject caller-chosen role
      }).toString(),
    })

    assert.equal(postRes.status, 302)
    let sessionCookie = postRes.headers.get('set-cookie') ?? ''

    let profileRes = await router.fetch('/profile', {
      headers: { cookie: extractFirstCookie(sessionCookie) },
    })
    assert.equal(profileRes.status, 200)
    let profileHtml = await profileRes.text()
    assert.ok(!profileHtml.includes('int_sysadmin'), 'Must not grant injected caller-supplied role')
    assert.ok(profileHtml.includes('ext_user'), 'Must resolve genuine persona role ext_user')
  })
})
