import { csp } from 'remix/middleware/csp'

// The enforced policy for HTML documents. `csp()` mints a fresh 128-bit nonce per
// request; `render()` stamps that nonce onto generated import maps, module
// preloads and CSS mixin <style> tags, so inline first-party resources remain
// executable without any 'unsafe-inline' allowance for scripts.
//
// R1.3 of docs/plans/rectification-implementation-plan.md. See also docs/plans/review-baseline.md.
export function contentSecurityPolicy() {
  return csp({
    policy({ nonce }) {
      return {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", `'nonce-${nonce}'`],
        styleSrc: ["'self'", `'nonce-${nonce}'`],
        imgSrc: ["'self'"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: process.env.NODE_ENV === 'production',
      }
    },
  })
}

/**
 * HSTS is only emitted for a request known to be HTTPS. The Node adapter sees a
 * plaintext socket behind a TLS-terminating reverse proxy, so a deployment that
 * declares trusted proxy hops may instead rely on the proxy's X-Forwarded-Proto.
 * A direct caller cannot profit: HSTS received over plain HTTP is ignored by
 * browsers, and `context.url.protocol` is never rewritten here.
 */
function isHttpsRequest(context: any): boolean {
  if (context.url.protocol === 'https:') return true
  let hops = Number.parseInt(process.env.MMS_TRUSTED_PROXY_HOPS ?? '0', 10)
  if (!Number.isFinite(hops) || hops <= 0) return false
  let forwarded = context.request.headers.get('x-forwarded-proto')
  if (!forwarded) return false
  return forwarded
    .split(',')
    .some((value: string) => value.trim().toLowerCase() === 'https')
}

export function securityHeaders() {
  return async (context: any, next: () => Promise<Response>) => {
    let response = await next()
    let headers = new Headers(response.headers)
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
    headers.set('X-Frame-Options', 'DENY')
    if (isHttpsRequest(context)) {
      headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
}
