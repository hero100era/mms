# MMS Documentation Index

Welcome to the **Maritime Management System (MMS)** documentation. This directory provides the architectural blueprints, technical plans, compliance specifications, operational runbooks, and Architecture Decision Records (ADRs) governing the MMS platform.

---

## Documentation Taxonomy

The documentation is organized into modular categories:

```
docs/
├── architecture/     # High-level architecture, BFF patterns, and refactoring analysis
├── plans/            # Canonical implementation plans, rectification records, and baselines
├── adr/              # Architecture Decision Records (ADRs 0001–0030)
├── compliance/       # Statutory compliance control matrices and evidence requirements
├── domain/           # Maritime domain workflows and business model specifications
├── org/              # Organizational hierarchy, job titles, and role allocation rules
├── runbooks/         # Operational procedures, emergency access, and maintenance drills
├── security/         # Threat modeling, authorization matrix, and trust boundaries
└── testing/          # Acceptance test guides, native environment setup, and test cards
```

---

## 1. Architecture

System architecture, component seams, and structural analysis.

| Document | Description |
| :--- | :--- |
| [architecture-and-refactor.md](architecture/architecture-and-refactor.md) | Narrow-waist Remix 3 BFF architecture over PostgreSQL data plane, security seams, and refactoring analysis |

---

## 2. Plans & Milestones

The [MMS Unified Implementation Plan](plans/README.md) integrates the system's foundational architecture, authentication delivery stream, security rectification roadmap, native acceptance environment, and domain progression into a single reference and traceability framework.

| Unified Plan Component | Document | Description |
| :--- | :--- | :--- |
| **Master Roadmap & Traceability Matrix** | [**README.md**](plans/README.md) | **Master entry point**: End-to-end delivery lifecycle, Release Gates A–F, and full requirements-to-tests traceability matrix |
| Part 1: Target Architecture & Auth Foundation | [auth-implementation-plan.md](plans/auth-implementation-plan.md) | Target architecture (§1–§11) and foundational delivery stream (§12 Cards F-, O-, A-, I-, S-, H-) |
| Part 2: Rectification Plan & Release Gates | [rectification-implementation-plan.md](plans/rectification-implementation-plan.md) | Authoritative rectification plan covering Phases R0 through R10 and release gates A–F |
| Part 3: Native Local Acceptance Test Environment | [r8-6-implementation-plan.md](plans/r8-6-implementation-plan.md) | Canonical native acceptance test environment specification (PostgreSQL 18.6, PostgREST 16.5) |
| Part 4: Execution Tracking & Decision Register | [rectification-decisions.md](plans/rectification-decisions.md) | Real-time task execution tracking, formal decision register (Q1–Q18), and stop conditions |
| Part 5: Review Baseline & Evidence (R0) | [review-baseline.md](plans/review-baseline.md) | Phase R0 reviewed baseline snapshot evidence (484 files) and toolchain version pin verification |

---

## 3. Architecture Decision Records (ADRs)

Formal architecture decisions documenting rationale, trade-offs, and consequences.

| ADR | Title | Status | Scope / Topic |
| :--- | :--- | :--- | :--- |
| [0001](adr/0001-monorepo.md) | npm workspaces monorepo | Accepted | Repository structure and workspace layout |
| [0002](adr/0002-remix-version.md) | Remix version 3.3.0 | Accepted | Pinned framework version and update policy |
| [0003](adr/0003-psqldef-spike.md) | psqldef spike | Superseded | Evaluated psqldef; superseded by pgschema (ADR-0010) |
| [0004](adr/0004-bff-jwt.md) | BFF-issued JWT | Accepted | Short-lived ES256 session token issued by BFF |
| [0005](adr/0005-principal-id.md) | Principal identity | Accepted | Principal identification across identity providers |
| [0006](adr/0006-schema-boundaries.md) | Schema boundaries | Accepted | PostgreSQL schema decoupling (`core`, `iam`, `audit`, etc.) |
| [0007](adr/0007-tiered-audit_trail.md) | Tiered audit | Accepted | Dual-tier audit: transactional log + WORM archive |
| [0008](adr/0008-four-dimension-auth.md) | Four authorization dimensions | Accepted | Role, authority, scope type, and unit relationship |
| [0009](adr/0009-scoping-patterns.md) | Two scoping patterns | Accepted | Hierarchical and direct unit resource scoping |
| [0010](adr/0010-pgschema.md) | pgschema for declarative schema | Accepted | Declarative schema diffing and forward-only migrations |
| [0011](adr/0011-privilege-model-poc.md) | Privilege-model PoC & API template | Accepted | Least privilege role template and definer security |
| [0012](adr/0012-audit-sealing-protocol.md) | Tier-2 audit sealing protocol | Proposed | Cryptographic Merkle tree batch sealing & WORM export |
| [0013](adr/0013-pgaudit-forwarding-reconciliation.md) | pgaudit, forwarding & reconciliation | Proposed | Off-DB log forwarding and daily event reconciliation |
| [0014](adr/0014-audit-retention-crypto-shredding-partitioning.md) | Audit retention classes & crypto-shredding | Accepted | Statutory retention classes (`RC-1`–`RC-7`) and GDPR erasure |
| [0015](adr/0015-entra-deprovisioning-sync-worker.md) | Entra deprovisioning sync worker | Accepted | Background sync and immediate session revocation SLA |
| [0016](adr/0016-malware-scanning-quarantine-pipeline.md) | Malware scanning of uploads | Accepted | Quarantine bucket isolation and fail-closed scan pipeline |
| [0017](adr/0017-caller-identity-in-definer-functions.md) | Caller identity in definer functions | Proposed | `private.caller_role()` vs definer inspection |
| [0018](adr/0018-delegated-org-administration.md) | Delegated organisation administration | Proposed | Scoped unit-level administration and boundary checks |
| [0019](adr/0019-totp-secret-encoding-and-verifier-location.md) | TOTP secret encoding & verifier location | Proposed | Base32 secret storage and in-database TOTP verification |
| [0020](adr/0020-break-glass-access.md) | Break-glass access | Proposed | Dormant emergency access accounts capped at 4 hours |
| [0021](adr/0021-separate-worker-and-sealer-deployments.md) | Separate worker and sealer deployments | Proposed | Isolated execution processes for worker and audit sealer |
| [0022](adr/0022-break-glass-forbidden-operations.md) | Break-glass forbidden operations matrix | Proposed | Explicit prohibitions on emergency administrative accounts |
| [0023](adr/0023-upload-state-machine-and-scan-authority.md) | Upload state machine & scan authority | Proposed | Strict upload states, HMAC token binding, and streaming |
| [0024](adr/0024-idempotency-and-domain-error-codes.md) | Idempotency keys & domain error codes | Proposed | Concurrency locking, idempotency, and SQLSTATE conventions |
| [0025](adr/0025-mms-shell-design-system-and-csp.md) | MMS shell design system & strict CSP | Proposed | Strict nonce-only CSP, WCAG 2.2 AA design system shell |
| [0026](adr/0026-authorization-matrix-and-segregation-of-duties.md) | Authorization matrix & segregation of duties | Proposed | 10 authorization dimensions and database SoD enforcement |
| [0027](adr/0027-durable-outbox-leasing-and-dead-letter.md) | Durable outbox leasing & dead-letter | Proposed | Resilient outbox polling, lease timeouts, and dead-letter queue |
| [0028](adr/0028-canonical-party-and-vessel-identity.md) | Canonical party & vessel identity | Proposed | IMO check-digit validation, registry history, and entity merge |
| [0029](adr/0029-survey-job-separation-and-deficiency-lifecycle.md) | Survey job separation & deficiency lifecycle | Proposed | Decoupling service requests from physical survey attendance jobs |
| [0030](adr/0030-maritime-qualifications-authorizations-and-controlled-certificates.md) | Maritime qualifications & certificates | Proposed | Surveyor competence catalog and controlled certificate records |
| [0031](adr/0031-storage-path-terminology.md) | Storage path terminology | Accepted | Standardized storage bucket and key naming conventions |
| [0032](adr/0032-production-baseline-and-migration-immutability.md) | Baseline freeze & migration immutability | Accepted | Permanent immutability lock for baseline migrations |
| [0033](adr/0033-upload-web-worker-boundary.md) | Web/worker boundary for uploads | Proposed | RPC-based privilege boundary separating web from worker |
| [0034](adr/0034-use-identity-columns-instead-of-serial.md) | SQL-standard identity columns vs. serial | Accepted | Mandates `GENERATED ALWAYS AS IDENTITY` over legacy `serial` |

---

## 4. Compliance & Statutory Governance

Regulatory compliance, statutory classification requirements, and audit evidentiary standards.

| Document | Description |
| :--- | :--- |
| [control-matrix.md](compliance/control-matrix.md) | Traceability matrix mapping IMO RO Code (MSC.349(92)), ISO 9001, and IACS PR17 to MMS database constraints and tests |
| [evidence-requirements.md](compliance/evidence-requirements.md) | Specification of statutory record classes (`RC-1` through `RC-7`), retention horizons, and cryptographic sealing |

---

## 5. Maritime Domain Models

Business workflows, lifecycle models, and domain data contracts.

| Document | Description |
| :--- | :--- |
| [survey-request.md](domain/survey-request.md) | Specification for survey request intake, client validation, station triage, and approval workflow (SLICE-01) |

---

## 6. Organization & Roles

Enterprise structure, maritime job roles, and capability assignments.

| Document | Description |
| :--- | :--- |
| [default-role-rules.md](org/default-role-rules.md) | Baseline role allocation rules, qualification requirements, and boundary constraints |
| [job-titles.md](org/job-titles.md) | Standard maritime classification and survey job titles mapped to system roles and competencies |

---

## 7. Operational Runbooks

Standard Operating Procedures (SOPs), emergency protocols, and infrastructure maintenance.

| Runbook | Description |
| :--- | :--- |
| [audit-worm.md](runbooks/audit-worm.md) | Cryptographic WORM audit verification, KMS key storage, dual-window checks, and anomaly handling |
| [backup-restore.md](runbooks/backup-restore.md) | PostgreSQL backup schedules, RPO/RTO targets, and restore drill validation procedures |
| [break-glass.md](runbooks/break-glass.md) | Emergency dormant administrator account activation protocol, forbidden operations, and audit alerts |
| [deployment-topology.md](runbooks/deployment-topology.md) | Process isolation architecture for BFF, database data plane, async background worker, and sealer |
| [request-context.md](runbooks/request-context.md) | Ingress proxy configuration, trusted proxy hops, client IP resolution, and header forwarding rules |
| [security-review-and-drills.md](runbooks/security-review-and-drills.md) | Incident response drills, break-glass simulations, and periodic security review schedules |
| [signing-key-rotation.md](runbooks/signing-key-rotation.md) | Token signing key rotation procedures (ES256 / Ed25519) and JWKS cache publishing |

---

## 8. Security & Threat Model

Trust boundaries, authorization logic, and defensive architecture.

| Document | Description |
| :--- | :--- |
| [authorization-matrix.md](security/authorization-matrix.md) | Consolidated 10-dimensional authorization matrix and architectural archetypes |
| [threat-model.md](security/threat-model.md) | Threat modeling analysis, attack vectors, trust boundaries, and mitigation controls |

---

## 9. Testing & Acceptance

Native environment setup, QA guidelines, and formal acceptance criteria.

| Document | Description |
| :--- | :--- |
| [native-environment.md](testing/native-environment.md) | Setup, configuration, and verification of the canonical R8.6 native PostgreSQL & PostgREST test environment |
| [product-owner-guide.md](testing/product-owner-guide.md) | Acceptance testing guide and feature sign-off checklist for product owners and QA reviewers |
| [feature-test-template.md](testing/feature-test-template.md) | Template for Feature Acceptance Cards documenting acceptance criteria and manual test evidence |
| [authorization-acceptance-matrix.md](testing/authorization-acceptance-matrix.md) | Acceptance test matrix validating permissions across archetypes and authorization dimensions |

---

## Governance & Conventions

When modifying or adding documentation:
1. **Never invent conventions**: If proposing architectural changes or new patterns, author an ADR in `docs/adr/` with status `proposed` and stop for human review.
2. **Follow Security Review Rules**: Changes to authorization, security definer functions, or encryption require the `security-review` sign-off and two reviewers (see `AGENTS.md`).
3. **Keep Links Stable**: Update references across the repository whenever file locations or section anchors change.
