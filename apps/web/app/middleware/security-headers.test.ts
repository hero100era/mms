import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { router } from '../router.ts'

const ORIGIN = 'http://localhost'
const REQUIRED_DIRECTIVES = [
  'default-src',
  'script-src',
  'style-src',
  'img-src',
  'font-src',
  'connect-src',
  'object-src',
  'base-uri',
  'form-action',
  'frame-ancestors',
]

function directives(header: string): Map<string, string[]> {
  let result = new Map<string, string[]>()
  for (let part of header.split(';')) {
    let tokens = part.trim().split(/\s+/).filter(Boolean)
    if (tokens.length > 0) result.set(tokens[0]!, tokens.slice(1))
  }
  return result
}

function withProxyHops<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  let previous = process.env.MMS_TRUSTED_PROXY_HOPS
  if (value === undefined) delete process.env.MMS_TRUSTED_PROXY_HOPS
  else process.env.MMS_TRUSTED_PROXY_HOPS = value
  return run().finally(() => {
    if (previous === undefined) delete process.env.MMS_TRUSTED_PROXY_HOPS
    else process.env.MMS_TRUSTED_PROXY_HOPS = previous
  })
}

describe('R1.3 content security policy', () => {
  it('serves a complete, nonce-bearing policy on HTML pages', async () => {
    let response = await router.fetch(new URL('/login', ORIGIN))
    assert.equal(response.status, 200)
    let header = response.headers.get('Content-Security-Policy')
    assert.ok(header, 'Content-Security-Policy must be present on HTML')

    let policy = directives(header)
    for (let directive of REQUIRED_DIRECTIVES) {
      assert.ok(policy.has(directive), `missing ${directive} in ${header}`)
    }
    assert.deepEqual(policy.get('default-src'), ["'self'"])
    assert.deepEqual(policy.get('object-src'), ["'none'"])
    assert.deepEqual(policy.get('base-uri'), ["'self'"])
    assert.deepEqual(policy.get('form-action'), ["'self'"])
    assert.deepEqual(policy.get('frame-ancestors'), ["'none'"])
    assert.deepEqual(policy.get('img-src'), ["'self'"])
    assert.deepEqual(policy.get('font-src'), ["'self'"])
    assert.deepEqual(policy.get('connect-src'), ["'self'"])

    let scriptSrc = policy.get('script-src') ?? []
    let styleSrc = policy.get('style-src') ?? []
    assert.ok(scriptSrc.includes("'self'"))
    assert.ok(styleSrc.includes("'self'"))
    let scriptNonce = scriptSrc.find((token) => token.startsWith("'nonce-"))
    let styleNonce = styleSrc.find((token) => token.startsWith("'nonce-"))
    assert.ok(scriptNonce, 'script-src must carry a request nonce')
    assert.equal(scriptNonce, styleNonce, 'scripts and styles share the request nonce')

    // No unsafe fallback anywhere in the enforced policy for scripts or styles.
    assert.ok(!header.includes('unsafe-eval'), 'unsafe-eval must never be allowed')
    assert.ok(!header.includes("'unsafe-inline'"), 'Content-Security-Policy must contain no unsafe-inline anywhere (R5.2)')
    assert.ok(!scriptSrc.includes("'unsafe-inline'"), 'script-src must not allow unsafe-inline')
    assert.ok(!styleSrc.includes("'unsafe-inline'"), 'style-src must not allow unsafe-inline')
    assert.ok(!header.includes('*'), 'no wildcard source may be used')
    assert.ok(!/\bdata:\s*text\/|\bhttps?:\/\//.test(header), 'no external origin may be allowed')

    // The nonce in the header is the one the renderer stamped on generated
    // import maps and CSS mixin <style> elements.
    let nonce = scriptNonce!.slice("'nonce-".length, -1)
    let html = await response.text()
    assert.ok(nonce.length >= 16, 'nonce must be unpredictable')
    assert.ok(html.includes(`nonce="${nonce}"`), 'rendered HTML must carry the request nonce')
    assert.match(html, /<script[^>]*type="importmap"[^>]*nonce=/)
    assert.match(html, /<style[^>]*nonce=/)
  })

  it('mints a fresh nonce for every request', async () => {
    let first = await router.fetch(new URL('/login', ORIGIN))
    let second = await router.fetch(new URL('/login', ORIGIN))
    assert.notEqual(
      first.headers.get('Content-Security-Policy'),
      second.headers.get('Content-Security-Policy'),
      'nonces must not be reused across requests',
    )
  })

  it('does not send a nonce-bearing policy on non-HTML responses', async () => {
    let response = await router.fetch(new URL('/favicon.svg', ORIGIN))
    assert.equal(response.headers.get('Content-Security-Policy'), null)
  })

  it('retains the non-CSP security headers', async () => {
    let response = await router.fetch(new URL('/login', ORIGIN))
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
    assert.equal(response.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin')
    assert.equal(response.headers.get('X-Frame-Options'), 'DENY')
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
  })

  it('emits HSTS for HTTPS and for a configured trusted proxy only', async () => {
    await withProxyHops(undefined, async () => {
      let direct = await router.fetch(new URL('/login', ORIGIN))
      assert.equal(direct.headers.get('Strict-Transport-Security'), null)

      let forged = await router.fetch(new URL('/login', ORIGIN), {
        headers: { 'x-forwarded-proto': 'https' },
      })
      assert.equal(
        forged.headers.get('Strict-Transport-Security'),
        null,
        'a direct caller must not be able to assert HTTPS without trusted proxy hops',
      )

      let https = await router.fetch(new URL('https://localhost/login'))
      assert.match(https.headers.get('Strict-Transport-Security') ?? '', /max-age=/)
    })

    await withProxyHops('1', async () => {
      let proxied = await router.fetch(new URL('/login', ORIGIN), {
        headers: { 'x-forwarded-proto': 'https' },
      })
      assert.match(proxied.headers.get('Strict-Transport-Security') ?? '', /max-age=/)
    })
  })

  it('loads no Google Fonts (or any external stylesheet) in the shell', async () => {
    let response = await router.fetch(new URL('/', ORIGIN))
    let html = await response.text()
    assert.ok(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(html))
    assert.ok(!/rel="stylesheet"[^>]*href="https?:/.test(html))
    assert.ok(!/rel="preconnect"[^>]*href="https?:/.test(html))
  })

  it('R5.1: the MMS shell carries no Remix/Shopify starter surface', async () => {
    let response = await router.fetch(new URL('/', ORIGIN))
    let html = await response.text()
    for (let pattern of [
      /docs\.remix\.run/i,
      /discord/i,
      /shopify/i,
      /coding with ai/i,
      /licensed under mit/i,
      /jetbrains/i,
    ]) {
      assert.ok(!pattern.test(html), `starter content must be gone: ${pattern}`)
    }
    assert.match(html, /<h1[^>]*>Marine Management System<\/h1>/)
    assert.match(html, /<h2[^>]*id="signin-heading"/, 'headings are ordered and labelled')
    assert.match(html, /<nav aria-labelledby=|href="\/login"/)
  })

  it('R5.1: the shell page uses no inline style attributes', async () => {
    // css() mixins emit nonced <style> elements; a `style="..."` attribute
    // could never be covered by a nonce and would force a style-src-attr
    // exception for this page (ADR-0025).
    let response = await router.fetch(new URL('/', ORIGIN))
    let html = await response.text()
    assert.equal((html.match(/\sstyle="/g) ?? []).length, 0, 'no inline style attributes')
    assert.ok((html.match(/<style[^>]*nonce=/g) ?? []).length > 0, 'styles are nonced')
  })

  it('R5.2: application pages use no inline style attributes', async () => {
    let response = await router.fetch(new URL('/login', ORIGIN))
    let html = await response.text()
    assert.equal((html.match(/\sstyle="/g) ?? []).length, 0, 'no inline style attributes on login page')
    assert.ok((html.match(/<style[^>]*nonce=/g) ?? []).length > 0, 'styles are nonced')
  })
})
