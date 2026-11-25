import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createContextKey, RequestContext } from 'remix/router'
import {
  getAuth,
  getPgrst,
  getSession,
  render,
  requireAuth,
  requireRole,
  unauthorizedResponse,
  forbiddenResponse,
  AuthKey,
  PgrstKey,
} from './context.ts'

describe('R3.1: Typed application context accessors', () => {
  it('getSession retrieves session or throws error if absent', () => {
    let mockSession = { id: 's1', get: () => null, set: () => {}, has: () => false, data: {} } as any
    let contextWithSession = { session: mockSession }
    assert.equal(getSession(contextWithSession), mockSession)

    let emptyContext = new RequestContext(new Request('http://localhost/'))
    assert.throws(() => getSession(emptyContext as any), /Session is not installed/)
  })

  it('getAuth and requireAuth safely retrieve authenticated principal', async () => {
    let htmlCtx = new RequestContext(new Request('http://localhost/admin/positions'))
    assert.equal(getAuth(htmlCtx), null)
    // HTML/browser request redirects (302) to /login with returnTo
    assert.throws(
      () => requireAuth(htmlCtx),
      (err: any) =>
        err instanceof Response &&
        err.status === 302 &&
        err.headers.get('location') === '/login?returnTo=%2Fadmin%2Fpositions',
    )

    let apiCtx = new RequestContext(
      new Request('http://localhost/admin/positions', {
        headers: { accept: 'application/problem+json', 'x-request-id': 'req-corr-123' },
      }),
    )
    // API request throws 401 Problem Details with correlation ID preserved
    let caught401: Response | null = null
    try {
      requireAuth(apiCtx)
    } catch (err: any) {
      if (err instanceof Response) caught401 = err
    }
    assert.ok(caught401 !== null)
    assert.equal(caught401.status, 401)
    assert.equal(caught401.headers.get('content-type'), 'application/problem+json; charset=utf-8')
    assert.equal(caught401.headers.get('x-request-id'), 'req-corr-123')
    let body = await caught401.json()
    assert.equal(body.code, 'UNAUTHORIZED')
    assert.equal(body.correlationId, 'req-corr-123')

    let authData = {
      userId: 'u1',
      kind: 'internal' as const,
      activeRole: 'int_coordinator',
      authMethod: 'entra' as const,
      authTime: new Date().toISOString(),
      assignableRoles: ['int_coordinator'],
    }
    apiCtx.set(AuthKey, authData)
    assert.deepEqual(getAuth(apiCtx), authData)
    assert.deepEqual(requireAuth(apiCtx), authData)
  })

  it('requireRole enforces activeRole membership', async () => {
    let authData = {
      userId: 'u1',
      kind: 'internal' as const,
      activeRole: 'int_coordinator',
      authMethod: 'entra' as const,
      authTime: new Date().toISOString(),
      assignableRoles: ['int_coordinator'],
    }
    let reqCtx = new RequestContext(
      new Request('http://localhost/admin/positions', {
        headers: { accept: 'application/json' },
      }),
    )
    reqCtx.set(AuthKey, authData)

    // Allowed role matches activeRole
    assert.deepEqual(requireRole(reqCtx, ['int_coordinator', 'int_sysadmin']), authData)

    // Disallowed role throws 403 Problem Details
    let caught403: Response | null = null
    try {
      requireRole(reqCtx, ['int_hr', 'int_sysadmin'])
    } catch (err: any) {
      if (err instanceof Response) caught403 = err
    }
    assert.ok(caught403 !== null)
    assert.equal(caught403.status, 403)
    let body = await caught403.json()
    assert.equal(body.code, 'FORBIDDEN')
    assert.equal(body.status, 403)
  })

  it('getPgrst retrieves client or throws if not installed', () => {
    let reqCtx = new RequestContext(new Request('http://localhost/'))
    assert.throws(() => getPgrst(reqCtx), /PostgREST client is not installed/)

    let mockClient = { select: () => {}, rpc: () => {} } as any
    reqCtx.set(PgrstKey, mockClient)
    assert.equal(getPgrst(reqCtx), mockClient)
  })

  it('render invokes context.render properly', async () => {
    let calledWith: unknown = null
    let mockRenderCtx = {
      render: (node: unknown, init?: ResponseInit) => {
        calledWith = node
        return new Response('rendered', init)
      },
    }
    let res = await render(mockRenderCtx, '<div>hello</div>', { status: 200 })
    assert.equal(calledWith, '<div>hello</div>')
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'rendered')
  })
})
