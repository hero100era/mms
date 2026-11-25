import { randomBytes, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { createContextKey } from 'remix/router'

export let RequestIdKey = createContextKey<string>()
export let ClientIpKey = createContextKey<string>()
export let TraceparentKey = createContextKey<string>()

// Headers the BFF owns. An inbound copy is never trusted: the browser (or any
// proxy in front of it) can set them, and `X-Client-Ip` is what the DB records
// in `iam.session` and `iam.login_attempt` for lockout and forensic purposes.
const OWNED_HEADERS = new Set([
  'x-client-ip',
  'x-request-id',
  'traceparent',
  'idempotency-key',
])

// The peer address reported by the Node adapter. It lives off the Request object
// rather than in a header: an inbound header with this meaning could be forged.
const peerAddresses = new WeakMap<Request, string>()

/** Called by the Node request listener, which is the only trusted source of the peer IP. */
export function setPeerAddress(request: Request, address: string): void {
  peerAddresses.set(request, address)
}

// Only X-Forwarded-For is honoured. The standardized `Forwarded` header is not
// parsed: accepting two competing chains would make the trusted hop ambiguous.
// The reverse proxy that sets X-Forwarded-For must be the only ingress, and the
// deployment declares how many trusted hops it adds with MMS_TRUSTED_PROXY_HOPS.
// If that value is set on a process a client can reach directly, the client can
// choose its own apparent IP; see docs/runbooks/request-context.md.
const MAX_FORWARDED_HEADER_LENGTH = 2048
const MAX_FORWARDED_CHAIN_LENGTH = 16

/** Only a parseable IP may be bound into an `inet` column or compared for throttling. */
function normalizeIp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let trimmed = value.trim()
  // `::ffff:127.0.0.1` is the IPv4 form a dual-stack socket reports; keep the
  // plain IPv4 text so the value reads the same as a proxied one.
  if (trimmed.startsWith('::ffff:')) trimmed = trimmed.slice(7)
  return isIP(trimmed) === 0 ? null : trimmed
}

/**
 * Parses the X-Forwarded-For chain. Returns null for missing, oversized,
 * malformed or implausibly long chains so the caller falls back to the socket
 * peer instead of trusting a partially attacker-controlled value.
 */
function forwardedChain(context: any): string[] | null {
  let forwarded = context.headers?.get?.('x-forwarded-for')
  if (typeof forwarded !== 'string' || forwarded.length === 0) return null
  if (forwarded.length > MAX_FORWARDED_HEADER_LENGTH) return null
  let chain = forwarded
    .split(',')
    .map((part: string) => part.trim())
    .filter(Boolean)
  if (chain.length === 0 || chain.length > MAX_FORWARDED_CHAIN_LENGTH) return null
  // A single malformed hop invalidates the whole chain: otherwise a caller
  // could pad the chain with junk to move the trusted index onto their value.
  if (chain.some((entry: string) => normalizeIp(entry) === null)) return null
  return chain
}

/**
 * Resolves the client IP from the request.
 *
 * `x-forwarded-for` is only honoured when the deployment declares how many
 * trusted proxies sit in front of this process (`MMS_TRUSTED_PROXY_HOPS`), so a
 * direct caller cannot spoof the value. Without that setting the socket address
 * reported by the Node adapter is used; anything unparseable falls back to the
 * neutral `0.0.0.0` sentinel.
 */
export function resolveClientIp(context: any): string {
  let hops = Number.parseInt(process.env.MMS_TRUSTED_PROXY_HOPS ?? '0', 10)
  if (Number.isFinite(hops) && hops > 0) {
    let chain = forwardedChain(context)
    // With N trusted proxies the original client is N entries from the right.
    // Prepending spoofed entries cannot move that index, but a chain shorter
    // than the configured hops means no trusted proxy appended its hop.
    if (chain && chain.length >= hops) {
      let candidate = normalizeIp(chain[chain.length - hops])
      if (candidate) return candidate
    }
  }

  let request = context.request as (Request & { socket?: { address?: unknown }; ip?: unknown }) | undefined
  let peer = peerAddresses.get(request as Request) ?? request?.socket?.address ?? request?.ip
  // `socket.address` is a function on Node sockets, not an address string.
  return normalizeIp(peer) ?? '0.0.0.0'
}

/**
 * The client IP for the current request. `requestContext()` resolves it once and
 * stores it on the context, so every action sees the same value the BFF copied
 * into `X-Client-Ip`; callers outside that middleware fall back to the resolver.
 */
export function clientIp(context: any): string {
  let resolved = context.get?.(ClientIpKey) ?? context.get?.('clientIp')
  if (typeof resolved === 'string' && resolved.length > 0) return resolved
  return resolveClientIp(context)
}

export function requestContext() {
  return async (context: any, next: () => Promise<Response>) => {
    // Never trust inbound copies of BFF-owned headers. The request id and the
    // trace id are minted here, not read from the caller.
    let requestId = randomUUID()
    let clientIp = resolveClientIp(context)
    let traceparent = `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`

    context.set(RequestIdKey, requestId)
    context.set('requestId', requestId)
    context.set(TraceparentKey, traceparent)
    context.set('traceparent', traceparent)
    context.set(ClientIpKey, clientIp)
    context.set('clientIp', clientIp)

    // Strip every owned header from the original request as well, so code that
    // reads `context.request.headers` cannot see a forged value either. Request
    // headers are mutable; we deliberately do NOT rebuild the Request, which
    // would consume/tee the body before the formData middleware reads it.
    for (let name of OWNED_HEADERS) context.request.headers.delete(name)
    if (process.env.NODE_ENV !== 'test') {
      context.request.headers.delete('x-test-clock')
    }
    context.request.headers.set('X-Request-Id', requestId)
    context.request.headers.set('X-Client-Ip', clientIp)
    context.request.headers.set('traceparent', traceparent)

    // `context.headers` is the canonical header view for downstream middleware.
    // Assigning it (instead of building an unused local) is what makes the
    // sanitization real.
    context.headers = new Headers(context.request.headers)

    let response = await next()
    let out = new Headers(response.headers)
    out.set('X-Request-Id', requestId)

    let url: URL = context.url ?? new URL(context.request.url)
    const SENSITIVE_PATH = /^\/(login|logout|invite|reset-password|forgot-password|profile|admin|break-glass|mfa|auth|identity|surveys|triage)/
    if (SENSITIVE_PATH.test(url.pathname)) {
      out.set('Cache-Control', 'no-store')
    } else if (!out.has('Cache-Control')) {
      out.set('Cache-Control', 'no-store')
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: out,
    })
  }
}
