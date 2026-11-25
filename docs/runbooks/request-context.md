# Runbook: client IP, trusted proxies and request context

This describes how the BFF decides which IP address it records in
`iam.session` / `iam.login_attempt` and copies into `X-Client-Ip` for the
database. R1.4 of `docs/plans/rectification-implementation-plan.md`.

## Which header is trusted

Only **`X-Forwarded-For`** is honoured, and only when the deployment declares
trusted proxy hops with `MMS_TRUSTED_PROXY_HOPS` (> 0). The standardized
`Forwarded` header is deliberately **not** parsed by the application: accepting
two competing chains would make the trusted hop ambiguous. If the ingress proxy
only emits `Forwarded`, it must be configured to emit `X-Forwarded-For` as well.

`X-Client-Ip` is a BFF-owned header. Inbound copies, `X-Request-Id`,
`traceparent` and `Idempotency-Key` are stripped from the request by
`requestContext()` and re-minted from the socket peer / random values, so a
caller cannot choose the address used for login throttling or audit metadata.

## Trust model

`MMS_TRUSTED_PROXY_HOPS=N` means **exactly N trusted proxies** sit in front of
this process and each appends one hop to `X-Forwarded-For`. With N proxies the
original client is the entry N positions from the right, so entries a client
prepends to the chain are ignored. The chain is rejected wholesale (falling
back to the socket peer) when it is missing, oversized (> 2048 bytes), longer
than 16 entries, shorter than the configured hop count, or contains any entry
that is not a parseable IP address.

**Deployment requirement:** setting `MMS_TRUSTED_PROXY_HOPS` on a process that
a client can reach directly lets that client choose its apparent IP. Only set
it when the ingress proxy is the sole network path and overwrites/appends the
header itself. With the variable unset (default `0`), the adapter-supplied
socket peer is used and all forwarded headers are ignored.

HSTS follows the same trust boundary: `securityHeaders()` emits
`Strict-Transport-Security` for a request whose URL scheme is `https:`, or when
trusted proxy hops are configured **and** the proxy reports
`X-Forwarded-Proto: https`. A direct client forging that header without
configured hops gets no HSTS; browsers ignore HSTS received over plain HTTP in
any case, and `context.url.protocol` is never rewritten.

## Local development / tests

`apps/web/package.json` sets `MMS_TRUSTED_PROXY_HOPS=1` for the test suite so
integration tests can inject a stable client IP through `X-Forwarded-For`
without binding real sockets. This is safe because the test suite calls
`router.fetch()` directly. Production must not copy this value unless a proxy
is actually present.

## Checks

- `npm test` — `apps/web/app/middleware/request-context.test.ts` covers direct
  forged headers, single/multiple proxies, malformed, padded and oversized
  chains, and the ignored `Forwarded` header.
- `apps/web/app/middleware/security-headers.test.ts` covers HSTS gating.
