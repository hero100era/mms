# Runbook: BFF signing key rotation (Card H-06)

The BFF signs short-lived ES256 access tokens for PostgREST (ADR-0004). PostgREST
holds **public keys only** and refreshes them from the JWKS endpoint. This runbook
rotates the signing key without dropping a single in-flight request, and is also
the drill that H-06 requires: run it end to end against staging every quarter, and
record the timings in the drill log at the bottom.

## Why the order matters

Three clocks have to be respected, or users see spurious `401`s:

| Clock | Value | Why |
|---|---|---|
| Access-token TTL | **300 s** | A token signed by the old key stays valid this long after the switch. |
| PostgREST JWKS refresh | `PGRST_JWT_SECRET` cache, up to **~10 min** by default | PostgREST keeps a cached JWKS until it re-fetches. A key it has not seen yet fails verification. |
| Idle session | 30–60 min | Sessions survive a key rotation; only the token is reissued per request. |

So: **publish first, sign later, retire last.** Never delete a key while a token it
signed may still be in flight.

## Preconditions

- `MMS_JWT_PRIVATE_KEY_FILE` points at the mounted key (Key Vault CSI volume, or a
  Kubernetes secret). Inline `MMS_JWT_PRIVATE_KEY` works too but is the weaker
  form: the key ends up in the process environment where any crash dump, `ps e`
  as the same user, or a misconfigured sidecar can read it. Prefer the file.
- For a non-exportable HSM key (Key Vault `EC P-256` with `exportable: false`),
  the private half cannot reach this process at all. Publish its public half via
  `MMS_JWT_ADDITIONAL_JWKS` and sign through the Key Vault sign API; see
  "Non-exportable key" below.
- You can read `GET /healthz` (or any authenticated route) and the PostgREST logs.

## Steps

### 1. Create the new key (does not touch the running system)

```sh
# Key Vault, non-exportable, ES256 / P-256
az keyvault key create \
  --vault-name "$MMS_KV" \
  --name mms-jwt-2026q4 \
  --kty EC --curve P-256 --ops sign \
  --exportable false

# Its public half, for the JWKS overlap
az keyvault key show --vault-name "$MMS_KV" --name mms-jwt-2026q4 \
  --query key.x509ThumbprintHex -o tsv
```

Record the new `kid` (`mms-jwt-2026q4`) in the deployment config as
`MMS_JWT_NEXT_KID`. **Do not** change `MMS_JWT_KID` yet.

### 2. Publish the new public key (T+0)

Add the new key beside the current one, then roll the deployment:

```yaml
env:
  MMS_JWT_KID: mms-jwt-2026q3                 # unchanged: still signs
  MMS_JWT_NEXT_KID: mms-jwt-2026q4            # newly published
  MMS_JWT_NEXT_PRIVATE_KEY_FILE: /keys/jwt-2026q4.pem
```

Check the JWKS now advertises both:

```sh
curl -s https://mms.example.com/.well-known/jwks.json | jq '.keys[].kid'
# expected: "mms-jwt-2026q3", "mms-jwt-2026q4"
```

**Wait at least 15 minutes** so every PostgREST replica has refreshed its cache
with the new key. Verify by confirming a 200 on a route that requires a token,
then checking PostgREST logs for `JWT` warnings — there must be none.

### 3. Switch signing to the new key (T+15 min)

Swap the two variables and roll the deployment:

```yaml
env:
  MMS_JWT_KID: mms-jwt-2026q4                 # now signs
  MMS_JWT_NEXT_KID: mms-jwt-2026q3            # old key, still published
  MMS_JWT_NEXT_PRIVATE_KEY_FILE: /keys/jwt-2026q3.pem
```

Verify: a fresh request now carries `kid: mms-jwt-2026q4` in its token header,
and the route still answers `200`:

```sh
# decode the kid of the token the BFF just minted (server-side, from a log line
# or by signing locally with the same env)
curl -s -H "Cookie: __mms_sid=..." https://mms.example.com/profile -o /dev/null -w '%{http_code}\n'
# expected: 200
```

Watch the PostgREST 401 rate for **5 minutes**. There should be no rise: tokens
signed by the old key are still inside their TTL and the old key is still
published.

### 4. Retire the old key (T+20 min at the earliest)

Only after the longest access-token TTL (300 s) plus the JWKS refresh window has
elapsed since step 3:

```yaml
env:
  MMS_JWT_KID: mms-jwt-2026q4
  # MMS_JWT_NEXT_* removed: the old key is no longer published
```

```sh
curl -s https://mms.example.com/.well-known/jwks.json | jq '.keys[].kid'
# expected: "mms-jwt-2026q4" only
```

### 5. Disable and later purge the old key in the vault

```sh
az keyvault key set-attributes --vault-name "$MMS_KV" --name mms-jwt-2026q3 --enabled false
# after the audit retention window (see docs/compliance/evidence-requirements.md)
az keyvault key purge --vault-name "$MMS_KV" --name mms-jwt-2026q3
```

Keep the old key *disabled but recoverable* for the audit window: if a token
verification question arises from an incident review, you need to prove which key
signed what.

## Non-exportable key

With an HSM-backed Key Vault key the BFF cannot read a PEM. Two options:

1. **Sign through Key Vault** (preferred). Replace the local `sign()` call in
   `apps/web/app/auth/token-signer.ts` with a call to the Key Vault sign API and
   publish the public half via `MMS_JWT_ADDITIONAL_JWKS`. The rotation steps above
   are unchanged; only "switch signing" becomes "switch the Key Vault key name".
2. **Key Vault-managed rotation.** Enable automatic rotation on the Key Vault key
   and set `MMS_JWT_KID` from the key version. The app must publish the *previous*
   version too, which is what `MMS_JWT_ADDITIONAL_JWKS` is for.

Failure mode to design against: Key Vault becomes unreachable. In option 1 the
BFF cannot mint tokens at all, so every request fails closed with `401`. That is
the correct behaviour for an auth component, but it means Key Vault availability
is on the critical path — put it behind a retry with a short timeout, and alert on
`sign_key_unavailable`.

## Verification checklist

- [ ] New key created and its `kid` recorded.
- [ ] JWKS advertised **both** keys before signing switched.
- [ ] PostgREST cache warm: 15 min elapsed with no 401 rise.
- [ ] New tokens carry the new `kid`; routes answer 200.
- [ ] Old key withdrawn only after TTL + refresh window.
- [ ] Old key disabled in the vault, not deleted.
- [ ] Drill timings recorded below.

## Drill log

H-06 requires a recurring drill. Record every run here so the quarterly schedule
has evidence.

| Date | Environment | Operator | T+0 publish | T+15 signing switch | T+20 retire | 401s observed | Notes |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

## Automated coverage

`apps/web/app/auth/token-signer.test.ts` pins the parts of this runbook that the
code can enforce: which key signs, that the previous key stays published during
the overlap, that a retired key disappears, that only public material ever leaves
the process, and that a public-only Key Vault key can be published. The 401-free
switch itself is a deployment property and is only proven by the drill.
