# Feature Acceptance Test

## Feature ID

## Commit

## Preconditions
- Clean acceptance database (`npm run testenv:reset`)
- PostgREST running (`npm run postgrest:check`)
- Application running (`npm run dev`)

## Persona
- Select test persona from `/dev/login` (e.g., `surveyor.shanghai`, `customer.a`, etc.)

## Fixture IDs
- Vessel ID:
- Organization ID:
- Request / Record ID:

## Positive path

### Steps
1. Navigate to:
2. Fill form with:
3. Submit action:

### Expected result
- HTTP status 200/302
- Database state updated to:
- UI displays:

## Organization-scope negative path
- Sign in as a different station or organization persona (e.g., `surveyor.singapore` or `customer.b`)
- Attempt to navigate to or modify the record
- Expected: Record is hidden from lists, and direct URL returns 404/403.

## Role negative path
- Sign in as an unauthorized internal role (e.g., `int_finance` or `int_sysadmin`)
- Attempt to trigger the action
- Expected: 403 Forbidden.

## Qualification negative path
- Sign in as `surveyor.expired`
- Attempt to trigger qualification-controlled release
- Expected: Action disabled or RPC rejected with `qualification_expired`.

## Direct API bypass attempt
- Send authenticated curl / fetch request directly to PostgREST bypassing Remix
- Expected: Denied by PostgreSQL RLS or schema grant.

## Concurrency scenario
- Two concurrent sessions submit conflicting updates
- Expected: Concurrency lock / version conflict handled gracefully.

## Audit evidence
- Verify change record captured in `audit_trail.change_log`
- Verify audit event recorded in `audit_trail.event`
- Verify horizon sealing and chain verification via `npm run sealer:test`

## Notification/outbox evidence
- Verify job record queued in `core.outbox`
- Inspect simulated delivery in `/dev/mailbox`

## Database invariant
- Verify no row bypasses RLS
- Verify state machine constraints hold

## Reset procedure
- Run `npm run testenv:reset`

## Result
PASS / FAIL

## Defects
- None / list issue details
