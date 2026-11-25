# Runbook: security review, penetration test and restore drill (Card H-12)

Three separate exercises, with different owners and different evidence. None of them is
"run the tool and hope"; each ends with a written record.

## 1. Threat model refresh

Owner: whoever changed auth, grants, policies or the token signer. Trigger list is at the
bottom of [`docs/security/threat-model.md`](../security/threat-model.md).

1. Re-read the asset and actor tables against what is deployed now.
2. For each threat row, confirm the control still exists **in code**, with a file and a
   test. A control that only exists in a runbook belongs in the residual-risk list.
3. Add a row for anything new that holds a credential (a new login role, a new job
   process, a new external provider).
4. Move anything still open into the residual-risk list with an owner. Do not delete a
   residual risk because it was uncomfortable; delete it when it is measured to be gone.

## 2. ZAP baseline (per release, against staging)

The plan is [`infra/zap/baseline.yaml`](../../infra/zap/baseline.yaml). It is a passive
scan plus a bounded crawl, not an active scan: active scanning writes to the application
and the MMS has regulated write paths (evidence release, sign-off) that must not be
triggered by a scanner.

```sh
export MMS_ZAP_TARGET=https://staging.example.internal
# Log in through the UI, copy the session cookie, and export it:
export ZAP_SESSION_COOKIE="__mms_sid=<value>"
mkdir -p infra/zap/out
docker run --rm -v "$PWD/infra/zap:/zap/wrk" -e MMS_ZAP_TARGET -e ZAP_SESSION_COOKIE \
  ghcr.io/zaproxy/zap-stable zap.sh -cmd -autorun /zap/wrk/baseline.yaml
```

Triage:

| Alert | Usual cause in this app | Action |
| --- | --- | --- |
| Missing anti-CSRF token | a form rendered without `_csrf` | fix the form; the middleware already refuses the POST |
| Cookie without `Secure` | staging served over plain HTTP | fix staging TLS, do not weaken the cookie |
| CSP / X-Content-Type-Options absent | a response built by hand (`new Response(...)`) | add the header or route it through the renderer |
| Session token in URL | a redirect that carries a token | tokens belong in the body or a header |
| Information disclosure in errors | a thrown error rendered verbatim | map to a generic message; keep the detail in `audit_trail.event` |

Record the report path, the alert count by risk, and the decision for each Medium+ finding.

## 3. Restore drill (quarterly, and before the first production release)

The database drill is scripted: [`scripts/restore-drill.sh`](../../scripts/restore-drill.sh).
It dumps the source database, restores into a scratch database with owners and ACLs intact,
runs the full pgTAP suite against the restored copy, and verifies the Tier-2 seal chain
against the WORM store. It refuses to report success when the database holds seals the
verifier did not analyse, which is the failure mode of pointing it at the wrong WORM
directory.

```sh
DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mms_dev \
MMS_WORM_DIR=$PWD/apps/web/.worm \
./scripts/restore-drill.sh
```

For a production rehearsal, point it at an anonymised snapshot (C4, H-07) and record:

| Field | Why |
| --- | --- |
| Dump size and elapsed restore time | measured RTO, not a promise |
| pgTAP result | grants, RLS, authority rules and audit triggers survived |
| Seal count analysed vs verified | the audit chain is intact, not merely present |
| Anything the drill had to work around | the next drill should not rediscover it |

Storage restore is separate: request the WORM container's soft-delete/immutability state,
restore one sealed object with its original bytes, and compare its SHA-256 with
`audit_trail.seal.worm_sha256`. A storage restore that changes a byte is a failed drill.

## Evidence to keep

- The threat-model diff (a document revision, not a claim).
- The ZAP JSON report and the triage table filled in.
- The drill log row: date, operator, dump size, restore seconds, pgTAP result, seal count.
- The external penetration test report, its scope and the remediation list. The pen test
  itself is procured, not performed by this team; the report is a release input (G3).
