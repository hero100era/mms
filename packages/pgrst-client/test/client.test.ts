import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ForbiddenError, PgrstClient, PgrstError, UnauthorizedError } from '../src/index.ts'

describe('PgrstClient', () => {
  it('sends auth and trace headers and encodes the query', async () => {
    let captured: { url?: string; init?: RequestInit } = {}
    let client = new PgrstClient({
      baseUrl: 'http://api.test',
      token: 't',
      requestId: 'r1',
      traceparent: '00-abc-def-01',
      clientIp: '203.0.113.4',
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init }
        return new Response(JSON.stringify([{ id: '1', code: 'HO', name: 'Head Office', unit_type: 'head_office', active: true }]), { status: 200 })
      }) as typeof fetch,
    })
    let rows = await client.select('org_units', { limit: '1' })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].code, 'HO')
    assert.equal(captured.url, 'http://api.test/org_units?limit=1')
    assert.equal((captured.init?.headers as Record<string, string>).Authorization, 'Bearer t')
    assert.equal((captured.init?.headers as Record<string, string>)['X-Request-Id'], 'r1')
    assert.equal((captured.init?.headers as Record<string, string>).traceparent, '00-abc-def-01')
  })

  it('posts RPC args as JSON and returns typed result', async () => {
    let captured: { url?: string; init?: RequestInit } = {}
    let client = new PgrstClient({
      baseUrl: 'http://api.test/',
      token: 't',
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init }
        return new Response(JSON.stringify('01a10000-0000-0000-0000-000000000001'), { status: 200 })
      }) as typeof fetch,
    })
    let result = await client.rpc('survey_request_create', {
      ship_id: 's1',
      org_id: 'o1',
      office_unit_id: 'u1',
      port_name: 'Shanghai',
    })
    assert.equal(result, '01a10000-0000-0000-0000-000000000001')
    assert.equal(captured.url, 'http://api.test/rpc/survey_request_create')
    assert.equal(captured.init?.method, 'POST')
    assert.equal(
      captured.init?.body,
      JSON.stringify({
        ship_id: 's1',
        org_id: 'o1',
        office_unit_id: 'u1',
        port_name: 'Shanghai',
      }),
    )
  })

  it('maps 401 and 403 to typed errors', async () => {
    let unauthorized = new PgrstClient({
      baseUrl: 'http://api.test',
      token: 't',
      fetch: (async () => new Response(JSON.stringify({ code: 'PT401', message: 'nope' }), { status: 401 })) as typeof fetch,
    })
    await assert.rejects(() => unauthorized.select('org_units'), UnauthorizedError)

    let forbidden = new PgrstClient({
      baseUrl: 'http://api.test',
      token: 't',
      fetch: (async () => new Response(JSON.stringify({ code: 'PT403', message: 'no' }), { status: 403 })) as typeof fetch,
    })
    await assert.rejects(() => forbidden.select('org_units'), ForbiddenError)
  })

  it('handles non-JSON error bodies gracefully', async () => {
    let errorClient = new PgrstClient({
      baseUrl: 'http://api.test',
      token: 't',
      fetch: (async () => new Response('502 Bad Gateway', { status: 502, statusText: 'Bad Gateway' })) as typeof fetch,
    })
    await assert.rejects(
      () => errorClient.rpc('survey_request_submit', { id: 'x' }),
      (err: any) => err instanceof PgrstError && err.status === 502 && err.message === '502 Bad Gateway',
    )
  })

  it('handles 204 No Content and empty responses cleanly', async () => {
    let emptyClient = new PgrstClient({
      baseUrl: 'http://api.test',
      token: 't',
      fetch: (async () => new Response(null, { status: 204 })) as typeof fetch,
    })
    let res204 = await emptyClient.rpc('survey_request_submit', { id: 'x' })
    assert.equal(res204, undefined)

    let blankClient = new PgrstClient({
      baseUrl: 'http://api.test',
      token: 't',
      fetch: (async () => new Response('', { status: 200 })) as typeof fetch,
    })
    let resBlank = await blankClient.rpc('survey_request_submit', { id: 'x' })
    assert.equal(resBlank, undefined)
  })

  it('propagates AbortSignal properly to fetch', async () => {
    let controller = new AbortController()
    let signalCaptured: AbortSignal | undefined

    let client = new PgrstClient({
      baseUrl: 'http://api.test',
      token: 't',
      fetch: (async (_url: unknown, init?: RequestInit) => {
        signalCaptured = init?.signal ?? undefined
        return new Response(JSON.stringify([]), { status: 200 })
      }) as typeof fetch,
    })

    await client.request('/org_units', { signal: controller.signal })
    assert.equal(signalCaptured, controller.signal)
  })

  it('times out requests when timeoutMs elapses and rejects with abort error', async () => {
    let client = new PgrstClient({
      baseUrl: 'http://api.test',
      token: 't',
      timeoutMs: 50,
      fetch: ((_url: unknown, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              reject(init.signal?.reason ?? new Error('Aborted'))
            })
          }
        })
      }) as typeof fetch,
    })

    await assert.rejects(
      () => client.select('org_units'),
      (err: any) => err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.message?.includes('aborted') || err?.message?.includes('timeout'),
    )
  })
})
