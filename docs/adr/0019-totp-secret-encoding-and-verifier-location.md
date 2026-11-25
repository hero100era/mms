# ADR-0019: TOTP secret encoding and verifier location (Card H-09, Q2)

- Status: proposed
- Date: 2026-11-03

## Context

Q2 was settled as "yes": external password users carry a second factor, and H-09
implements it as TOTP. Two things about that are not obvious from the card text
and change how the feature is built and tested.

**Where the verifier runs.** The natural shape is a BFF function: read the seed from the
row, run HMAC in Node, compare. That shape puts every external user's shared
secret in the web tier's address space, once per request. Any defect there that
reads or logs the wrong column, and any attacker who gets code execution on that
worker, has the seeds — and someone who holds the seeds can satisfy the challenge
they are supposed to be unable to pass. The BFF is also the component whose
compromise the second factor is meant to outlive.

**What "the secret" is.** TOTP secrets are exchanged between the server and an
authenticator app as **base32 text** (`MZXW6YTBOI…`, 4-character groups you type by
hand). The app base32-**decodes** that text into the raw key bytes, and does its
HMAC over those bytes and the step counter. The database has to do the same
thing. If it HMACs the text's UTF-8 bytes instead, it is computing a different
code from the one on the user's phone — every verification fails, and it fails
*deterministically*, so it looks like a password problem rather than an encoding
one. The RFC 6238 vectors do not catch this, because a test can paste the raw key
into both sides and stay consistent while the phone never will. (This is not
hypothetical: the first implementation of `auth.totp_enrol` stored
`convert_to(p_secret, 'UTF8')`, passed all six vectors, and rejected a real
client — see the H-09 status paragraph.)

## Decision

1. **Verify inside PostgreSQL.** `auth.totp_verify`, `auth.totp_enrol`,
   `auth.totp_disable` and `auth.totp_status` live in the `auth` schema and are
   SECURITY DEFINER with `SET search_path = ''`. The seed lives in
   `iam.totp_credential`, which has RLS enabled with zero policies and zero
   grants: only these functions reach it. The BFF can submit a candidate code and
   learn a boolean, and can enrol or disable a credential, but it can never read
   the seed. The compromise that the card is meant to answer — a broken web tier —
   can therefore not produce valid codes, because there are no seeds there from
   which to produce them.

2. **The alphabet lives in the database and in one shared package.** `auth.base32_decode`
   (RFC 4648, letter/case-tolerant, grouping-tolerant, any separator) is the only
   base32 implementation that feeds the HMAC key, and it is `revoked from public`
   with `EXECUTE` granted to `auth_gateway` only. `packages/totp` (`@mms/totp`)
   produces the secret, the `otpauth://` URI, the display grouping and the RFC
   6238 self-test vectors; `apps/web/app/auth/totp.ts` re-exports it rather than
   keeping a second copy. Two copies of a codec is two chances to disagree about
   what a dash means.

3. **Enrolment is a display-then-confirm flow, in that order.** The ceremony
   writes `secret` via `auth.totp_enrol` and returns a freshly generated base32 key,
   with `confirmed_at` NULL. A credential with `confirmed_at` NULL is never
   accepted. `auth.totp_verify` confirms it on the first accepted code: the user has
   proved, at the same moment and through the same channel, that the seed
   displayed and the seed stored are the same key — which is the statement that
   bugs (and a determined attacker who swaps the role display) cannot fake.

4. **The verifier is single-use and counts every anomaly.** A successful
   verification advances `last_step`, and any candidate code for a step at or
   below that watermark is refused. A replay is not a neutral event: it means
   someone else has the code. It therefore increments `failed_attempts` like any
   other wrong code, and five failures lock the credential for 15 minutes
   (`locked_until`). Verification runs inside a `for update` row lock, so concurrent
   requests cannot both present the same step.

5. **Only external users may hold a TOTP credential.** A CHECK constraint plus the
   composite foreign key `(user_id, user_kind) → iam.app_user (id, kind)` makes that
   unrepresentable. `auth.totp_enrol` refuses staff with `totp_is_external_only`, giving
   the same guarantee if the constraint is ever relaxed. Staff MFA is Entra's
   (`auth.session.auth_method = 'entra'` with an Entra-certain ACR); the app does
   not run that.

6. **The seed is never audited.** `db/seed/030_audit_exclusions.sql` records
   `iam.totp_credential.secret` with action `omit`. The audit trigger on the table
   still captures enrol/disable, and `auth.mfa.enrolled` / `auth.mfa.disabled` carry
   nothing but the user and the fact of the change. A history of a secret is the
   same as a secret.

7. **The gate is in middleware, and the session id turns over when it opens.**
   `apps/web/app/middleware/require-mfa.ts` runs between `sessionAuth()` and
   `pgrst()`: an external password session with no `auth.mfaVerifiedAt` can reach
   `/mfa`, `/mfa/enrol`, `/login*`, `/logout*`, `/step-up*`, `/assets/**`, the JWKS
   endpoint, `/auth/**` (provider callbacks) and `/invite/**`, and nothing else.
   On success `mfaSubmit` and `mfaEnrolSubmit` call `session.regenerateId(true)`
   **before** recording the instant, so the pre-MFA cookie cannot be replayed against
   the now-satisfied session (the same defence as a login). Password login no
   longer sets `stepUpAt`: clearing the second factor is not the same assurance as a
   fresh password signature, and `/step-up` keeps its own freshness window and asks
   for the password.

8. **Accepting an invite is itself the second factor.** The invite flow seats
   `mfaVerifiedAt` and lands on `/profile`, because that request chose the password,
   and control of the mailbox was proven by the single-use invite token. Parking a
   brand-new user on `/mfa` would only ask them to confirm a code they had not yet
   been shown: they could open `/mfa/enrol` and enrol in the same breath, which is the
   "enrol the device that is asking" loop that TOTP's confirmation request exists to
   prevent.

## Consequences

- The BFF tests must satisfy the gate explicitly; they do so through
  `satisfyMfa(userId)` (which marks the factor cleared for a user's session rows), and
  tests that are about step-up call it before `grantStepUp`, which records a fresh
  `stepUpAt` through `auth.session_write`. That is production-shaped, because a save
  does write the payload.
- Any future page an external user should see before the second factor is a one-line
  addition to `require-mfa.ts`, and that line is a security decision that should carry
  the `security-review` label.
- **Recovery codes and a re-enrolment process are not built by this card.** They need
  a decision before external users are onboarded in production: an external user who loses
  their authenticator today can only lose the session, and a failed TOTP challenge
  locks the credential for 15 minutes. A second factor is something people lose,
  and there is currently no way back in.

## Alternatives considered

- **Verify in the BFF (Node `crypto.createHmac`).** Rejected in the decision above:
  it places the seeds in the tier the factor is protecting against. It would also
  mean two implementations of the same codec in the same repository, which is the
  class of mismatch that found the defect in the first place.
- **Store the secret as the base32 text and HMAC it directly.** Rejected: it is not
  what an authenticator app does, and it produces a credential that no real client
  can satisfy (the RFC vectors keep passing, which makes it worse).
- **Store the seed in the BFF's secret manager and call it "non-exportable".**
  Rejected for the MVP: it solves key custody but not the "who can satisfy the
  challenge" problem, and it adds a third store to keep in sync.
- **Trust a replay.** Rejected: a replayed code is evidence of compromise, not a
  retry, and treating it as free is the one way a 6-digit window can be reused
  silently.
