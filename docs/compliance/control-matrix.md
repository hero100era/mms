# Maritime Management System (MMS) — Compliance Control Matrix

> **Card ID:** A-03  
> **Milestone:** M4 / G2 Compliance Verification  
> **Audience:** HO Compliance, Internal & External Auditors, Systems Engineering  
> **Cross-References:** `docs/compliance/evidence-requirements.md`, `docs/plans/auth-implementation-plan.md` (§5, §7, §8), `docs/security/threat-model.md`

---

## 1. Overview & Control Framework

This matrix maps regulatory and accreditation requirements from maritime classification authorities and quality standards directly to MMS technical controls, database constraints, Row Level Security (RLS) policies, architectural invariants, and test suites.

Applicable Standards:
- **IMO RO Code**: Code for Recognized Organizations (MSC.349(92) / MEPC.237(65)), Part 2 §3 (Quality Management System), §3.8 (Control of records), §3.9 (Internal audits).
- **IACS PR17**: Procedural Requirements for Transfer of Class and Information Transfer.
- **ISO 9001:2015**: §7.5 (Documented information), §8.2 (Requirements for products and services), §8.5 (Production and service provision).
- **ISO/IEC 17020:2012**: Conformity assessment — Requirements for the operation of various types of bodies performing inspection: §4.1 (Impartiality and independence), §4.2 (Confidentiality), §6.1 (Personnel), §8.4 (Control of records).
- **Data Protection**: EU GDPR (Regulation (EU) 2016/679) & China PIPL.

---

## 2. Regulatory Requirements to MMS Control Mapping

| Standard & Clause | Regulatory Requirement Summary | MMS Technical Control | Implementation Mechanism | Test & Verification Reference |
|---|---|---|---|---|
| **IMO RO Code §3.8.1** / **ISO 17020 §8.4.1** | The RO shall maintain a record system to confirm effective operation and statutory compliance. | **Tier 1 Audit Capture & Append-Only Logs** | Trigger `private.audit_capture()` on all domain tables; triggers `change_log_append_only` and `event_append_only` block `UPDATE`/`DELETE`. | `db/tests/audit_trail.sql`, `completeness.sql` |
| **IMO RO Code §3.8.2** / **IACS PR17 §2** | Records of surveys, reports, certificates, and drawing approvals shall be retained for the life of the ship + archive period. | **Immutable Issued Artifacts & Versioning** | `core.document` and `core.document_version` with SHA-256 digests; survey reports/certificates effective-dated and non-destructible. | Card S-02 schema, `db/tests/survey_request.sql` |
| **ISO 17020 §6.1.1** / **IMO RO Code §3.3** | Personnel shall have required qualifications, training, experience, and authority to perform inspection activities. | **Four-Dimension Authorization** | (1) Capability Role, (2) Unit Scope, (3) Staff Position Grade, (4) Qualifications (`private.assert_authority()`). | `db/tests/authority.sql` |
| **ISO 17020 §4.1.2** / **IMO RO Code §3.1** | Inspection activities shall be structured to safeguard impartiality and prevent conflicts of interest. | **Segregation of Duties (SoD)** | Separation of author and approver; sysadmins cannot hold business roles (`I10`); Compliance is read-only for survey operations. | `db/tests/rls_matrix.sql`, `completeness.sql` |
| **ISO 17020 §4.2.1** / **GDPR Art 5(1)(f)** | The inspection body shall be responsible for safeguarding proprietary information and confidential records. | **RLS Matrix & Column Masking** | Row Level Security isolates customer ships to authorized org members (`org_membership`); column grants hide grades/salaries; pre-storage audit redaction. | `db/tests/rls_matrix.sql`, `db/scripts/lint-schema.ts` |
| **IMO RO Code §3.8.3** | Records shall be identifiable, traceable to vessel and surveyor, and readily retrievable. | **Actor Attribution & Scope Tracking** | Mandatory `iam.app_user.id`, session ID, request trace ID, and `office_unit_id`/`handling_unit_id` scope tracking. | `db/tests/audit_trail.sql`, `completeness.sql` |
| **ISO 9001 §7.5.3.2** | Documented information shall be protected from loss of confidentiality, improper use, or loss of integrity. | **PostgreSQL Privilege Model & WORM Sealing** | PostgREST exposes only `api` schema; base tables private; Tier 2 WORM horizon sealing (`H-01`); no direct DML. | ADR-0004, ADR-0011, `db/tests/pre_request.sql` |
| **IACS PR17 §4** | Class status and official recommendations/deficiencies must be documented with technical justifications. | **Regulated Business Transitions** | State transitions require mandatory reasons; `private.emit_event()` captures reasons and caller authority snapshot. | `db/tests/completeness.sql`, `audit_trail.event_type.reason_required` |
| **IMO RO Code §3.6.1** | Controlled specifications, rules, and procedures shall be reviewed and authorized before release. | **Reviewed Declarative Schema Migrations** | Strict pgschema migration pipeline with checks C1 (determinism), C3 (clean plans), C5 (zero drift), C8 (ownership). | `db/scripts/check.ts`, `db/migrations.lock.json` |
| **GDPR Art 17 / PIPL Art 47** | Right to erasure of personal data balanced with legal compliance obligations. | **Selective Anonymization & Redaction** | Legal exemption under GDPR 17(3)(b) for maritime technical records; PII redaction on account deactivation. | `docs/compliance/evidence-requirements.md` §7 |
| **ISO 9001 §9.2** / **IMO RO Code §3.9** | Internal quality audits of operational and organizational processes. | **Worldwide Compliance Read Access** | Role `int_compliance` holds worldwide read access across all location and routed scopes; authority to raise findings. | `db/tests/rls_matrix.sql`, `authority.sql` |
| **IACS QSCS** | Strict change control over automated information processing software. | **Cryptographic Lock & Continuous Integration** | Migrations locked via SHA-256 in `db/migrations.lock.json`; automated CI gate runs typecheck, pgTAP, and boundaries. | `npm run check`, `npm run db:check` |

---

## 3. MMS Invariants and Security Guardrails Reference

| Invariant | Technical Constraint | Enforcement Mechanism | Regulatory Assurance |
|---|---|---|---|
| **T1 / T6** | No JWT can activate login/owner roles; sub/sid/role combination verified live on every request. | `private.pre_request()` | Eliminates unauthorized privilege assumption or session spoofing. |
| **T2** | `auth_gateway`, `worker`, and capability roles hold minimal necessary catalog privileges. | Explicit REVOKE/GRANT; checked by C8 and pgTAP. | Minimizes attack surface and limits lateral privilege expansion. |
| **T5** | Browser never decides `sub`, `sid`, `role`, `org_id`, unit, title, or grade. | Server-side session verification and database live claims. | Prevents client-side parameter tampering or identity injection. |
| **T8 / I7** | Nobody grants themselves roles or modifies their own position. | Exclusion constraints and definer check constraints. | Enforces administrative checks and balances across organizational hierarchies. |
| **T9 / I15** | Location-scoped (`office_unit_id`) and routed (`handling_unit_id`) scopes cannot be confused. | Scope policies and validation triggers. | Prevents cross-contamination between station work and centralized technical reviews. |
| **I1 / I2** | User suspension or role assignment revocation terminates access immediately. | Session revocation triggers and `pre_request()` re-validation. | Ensures rapid operational response to personnel departures or security incidents. |
| **I10** | `int_sysadmin` cannot hold any business role. | Check triggers on `iam.role_assignment`. | Prevents IT administrators from approving technical survey or classification decisions. |
| **I11** | Authority check evaluates position valid at exact moment of action. | `private.assert_authority()` checking `iam.staff_position` range. | Historical decisions remain attributable to the surveyor's grade at that time. |

---

## 4. Verification & Audit Trail Checklist

1. **Pre-Deployment**:
   - `npm run check`: TypeScript typechecking, server/browser boundary validation, unit tests.
   - `npm run db:check`: Schema lint, migration integrity check, drift detection (C1, C3, C5).
   - `npm run db:verify`: Full pgTAP execution (11 test suites covering IAM, RLS, audit completeness, and authority).
2. **Post-Deployment**:
   - Verification of `public.schema_migrations` row for the deployed release.
   - Verification of zero drift against running production database (`npm run db:verify`).
   - Periodic review of `audit_trail.seal` verification logs (Tier 2).
