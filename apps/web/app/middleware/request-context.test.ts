import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { clientIp, requestContext, resolveClientIp, setPeerAddress } from './request-context.ts'

function makeContext(headers: Record<string, string> = {}) {
  let values = new Map<string, unknown>()
  let request = new Request('http://localhost/', { headers })
  let context: any = {
    request,
    url: new URL('http://localhost/'),
    headers: new Headers(request.headers),
    get(key: unknown) {
      return typeof key === 'string' ? values.get(key) : undefined
    },
    set(key: unknown, value: unknown) {
      if (typeof key === 'string') values.set(key, value)
    },
  }
  return { context, values, request }
}

function withHops<T>(value: string | undefined, run: () => T): T {
  let previous = process.env.MMS_TRUSTED_PROXY_HOPS
  if (value === undefined) delete process.env.MMS_TRUSTED_PROXY_HOPS
  else process.env.MMS_TRUSTED_PROXY_HOPS = value
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env.MMS_TRUSTED_PROXY_HOPS
    else process.env.MMS_TRUSTED_PROXY_HOPS = previous
  }
}

function resolve(headers: Record<string, string>, peer = '198.51.100.9'): string {
  let request = new Request('http://localhost/')
  setPeerAddress(request, peer)
  return resolveClientIp({ request, headers: new Headers(headers) })
}

describe('resolveClientIp', () => {
  it('uses the adapter-supplied peer address and normalises IPv4-mapped IPv6', () => {
    withHops(undefined, () => {
      let request = new Request('http://localhost/')
      setPeerAddress(request, '::ffff:203.0.113.7')
      assert.equal(resolveClientIp({ request, headers: new Headers() }), '203.0.113.7')
    })
  })

  it('ignores a malformed forwarded address instead of binding it as inet', () => {
    withHops('1', () => {
      let request = new Request('http://localhost/')
      setPeerAddress(request, '198.51.100.9')
      let headers = new Headers({ 'x-forwarded-for': 'not-an-ip' })
      assert.equal(resolveClientIp({ request, headers }), '198.51.100.9')
    })
  })

  // R1.4: a direct request (no trusted proxy hops configured) must not be able
  // to pick its own throttle/audit IP by sending forwarding headers.
  it('ignores forged forwarding headers on a direct untrusted request', () => {
    withHops(undefined, () => {
      assert.equal(resolve({ 'x-forwarded-for': '1.2.3.4' }), '198.51.100.9')
      assert.equal(resolve({ forwarded: 'for=1.2.3.4' }), '198.51.100.9')
      assert.equal(resolve({ 'x-client-ip': '1.2.3.4' }), '198.51.100.9')
    })
  })

  it('resolves the client through a single trusted proxy', () => {
    withHops('1', () => {
      assert.equal(resolve({ 'x-forwarded-for': '203.0.113.44' }), '203.0.113.44')
      assert.equal(resolve({ 'x-forwarded-for': '203.0.113.44, 10.0.0.1' }), '10.0.0.1')
    })
  })

  it('resolves the client through multiple proxies using the configured hop count', () => {
    withHops('2', () => {
      // Two proxies append two hops; the leftmost entry is the original client.
      assert.equal(
        resolve({ 'x-forwarded-for': '203.0.113.44, 10.0.0.1, 10.0.0.2' }),
        '10.0.0.1',
      )
      // A chain shorter than the configured hops means a hop was not appended.
      assert.equal(resolve({ 'x-forwarded-for': '203.0.113.44' }), '198.51.100.9')
    })
  })

  it('rejects malformed, padded and oversized forwarding chains wholesale', () => {
    withHops('1', () => {
      assert.equal(resolve({ 'x-forwarded-for': '1.2.3.4, not-an-ip' }), '198.51.100.9')
      assert.equal(resolve({ 'x-forwarded-for': '   ,  ' }), '198.51.100.9')
      assert.equal(
        resolve({ 'x-forwarded-for': `${'1.2.3.4,'.repeat(100)}198.51.100.1` }),
        '198.51.100.9',
        'implausibly long chains must not be trusted',
      )
      assert.equal(
        resolve({ 'x-forwarded-for': '1.2.3.4'.padEnd(3000, 'x') }),
        '198.51.100.9',
        'oversized headers must be rejected before parsing',
      )
    })
  })

  it('never treats the standardized Forwarded header as a trusted chain', () => {
    withHops('1', () => {
      assert.equal(resolve({ forwarded: 'for=203.0.113.44' }), '198.51.100.9')
    })
  })
})

describe('requestContext', () => {
  it('strips inbound BFF-owned headers and mints its own IDs', async () => {
    let { context, values, request } = makeContext({
      'x-client-ip': '1.2.3.4',
      'x-request-id': 'spoofed-id',
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      'idempotency-key': 'spoofed-key',
      'user-agent': 'legit-agent',
    })

    let response = await requestContext()(context, async () => new Response('ok'))
    let body = await response.text()

    assert.equal(body, 'ok')
    assert.notEqual(request.headers.get('X-Request-Id'), 'spoofed-id')
    assert.match(request.headers.get('X-Request-Id') ?? '', /^[0-9a-f-]{36}$/)
    assert.equal(context.headers.get('X-Request-Id'), request.headers.get('X-Request-Id'))
    assert.equal(values.get('requestId'), request.headers.get('X-Request-Id'))
    assert.equal(request.headers.get('x-client-ip'), values.get('clientIp'))
    assert.equal(request.headers.get('idempotency-key'), null, 'inbound idempotency key must be stripped')
    assert.equal(context.headers.get('idempotency-key'), null)
    assert.match(request.headers.get('traceparent') ?? '', /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    assert.equal(request.headers.get('user-agent'), 'legit-agent', 'unowned headers survive')
    assert.equal(response.headers.get('X-Request-Id'), values.get('requestId'))
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.equal(clientIp(context), values.get('clientIp'))
  })

  it('strips x-test-clock when NODE_ENV is not test', async () => {
    let originalEnv = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'production'
      let { context, request } = makeContext({
        'x-test-clock': '2026-01-01T00:00:00Z',
      })
      await requestContext()(context, async () => new Response('ok'))
      assert.equal(request.headers.get('x-test-clock'), null)
      assert.equal(context.headers.get('x-test-clock'), null)
    } finally {
      process.env.NODE_ENV = originalEnv
    }
  })
})
