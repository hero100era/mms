# MMS Consolidated Authorization Matrix

This document is the authoritative consolidation of the authorization model in the Maritime Management System (MMS) per Phase R6 of the Rectification Plan (`docs/plans/rectification-implementation-plan.md` §R6.1) and ADR-0008 / ADR-0018 / ADR-0022 / ADR-0026.

Every authorization decision in MMS is evaluated across ten explicit dimensions. Database-level constraints, row-level security (RLS), and security-definer API functions enforce these rules; presentation layers reflect them for UX but never serve as the trust boundary.

---

## 1. The Ten Authorization Dimensions

| Dimension | Description | Authoritative Enforcement |
| :--- | :--- | :--- |
| **1. Role** (`db_role`) | The active application capability role claimed in the JWT and verified against active database sessions (`iam.session`, `iam.role_assignment`). | `private.pre_request()`, `private.active_role()`, PostgREST schema grants |
| **2. Authority** (`action_code`) | Fine-grained operational or financial authority code registered in the database catalog. | `iam.authority_rule`, `private.assert_authority()` |
| **3. Scope Type** (`scope_type`) | Granularity of organizational authority: `global` (worldwide), `unit` (specific unit only), `descendants` (unit and all child offices), `assigned` (explicit resource assignment). | `iam.role_assignment.scope_type`, `private.assert_in_scope()` |
| **4. Unit Relationship** | Topological relationship between caller's unit, the target organizational unit, and resource geographic coverage. | `core.org_unit`, `core.org_unit_closure`, `core.org_unit_coverage`, `private.my_offices()`, `private.my_units()` |
| **5. Staff Position Validity** | Formal HR appointment: job title, family, grade, reporting line, and active temporal range. An expired or suspended position revokes authority immediately. | `iam.staff_position.valid`, `iam.staff_position.revoked_at`, `private.my_position()` |
| **6. Qualification Validity** | Regulated maritime technical qualifications, competencies, and delegated authorities. | `qual.staff_qualification`, `iam.authority_rule.requires_qualification`, `qual.qualification_action` |
| **7. Workflow State** | Operational lifecycle state of the target entity (e.g., `draft` -> `submitted` -> `accepted` / `rejected`). Transitions require row locks and exact-state predicates. | Atomic updates with `WHERE id = p_id AND status = <expected>`, `ROW_COUNT = 1` |
| **8. Record Ownership / Assignment** | Direct relationship to the controlled record: client organization ownership, creator identity, or designated attending surveyor. | `created_by`, `org_id`, `fleet.ship_party`, `survey.survey_job.attending_surveyor_id` |
| **9. Step-Up Requirement** | Mandatory re-authentication (MFA verification or password check within the last 15 minutes) for sensitive administrative or credential mutations. | `iam.session.auth_time`, `isStepUpValid()`, `safeReturnTo()` |
| **10. Segregation of Duties (SoD)** | Mandatory separation of conflicting responsibilities: four-eyes review, sysadmin isolation from business operations, non-self-approval of qualifications/positions, and break-glass restrictions. | `iam.authority_rule_sysadmin_ck`, `iam.break_glass_forbidden_action`, `creator_cannot_approve` guards |

---

## 2. Six Required Organizational Archetypes

### 2.1 Station Manager
- **Context:** Manager appointed to a local operational station (e.g., Shanghai Station `SHA`, Singapore Station `SIN`).
- **Scope:** Direct station and all reporting station staff (`my_offices()` / direct station scope).
- **Authorities:**
  - Manages, assigns, and supervises local surveyors (`int_surveyor`) and auditors (`int_auditor`).
  - Assigns survey jobs (`survey.job.assign`, min grade 4).
  - Can read audit logs and operational history for the station (`audit_trail.trail.read`, min grade 4).
  - Cannot approve records outside station scope.

### 2.2 Centralized Plan Approval Centre (PAC)
- **Context:** Specialized engineering unit (e.g., PAC Busan, PAC London) dedicated to vessel drawing and technical plan reviews.
- **Scope:** Assigned plan submissions globally or regional routing (`plan_approval_centre`).
- **Authorities:**
  - Plan review and rerouting (`plan.submission.reroute`, min grade 4).
  - Cross-station plan coordination without station-specific surveyor appointment constraints.

### 2.3 Centralized Marine Technical Services (MTS)
- **Context:** Technical specialists providing specialized advisory, testing, or casualty investigations.
- **Scope:** Multi-region or area coverage configured via `core.org_unit_coverage` mapping an MTS centre to multiple countries, ports, or regional offices.
- **Authorities:**
  - Operational technical reviews across covered regions.
  - Distinct from local station surveyors; access dynamically computed through coverage rules (`private.my_units()`).

### 2.4 Head Office Compliance (HO Compliance)
- **Context:** Quality, risk, and regulatory compliance department located at Head Office (`HO-COMP`).
- **Scope:** `global` read oversight across all operational units, vessels, and audit trails.
- **Authorities:**
  - Audit trail reading (`audit_trail.trail.read`, min grade 2, global scope).
  - Raising compliance findings (`compliance.finding.raise`, min grade 2).
  - Placing operational holds on non-compliant records (`compliance.record.hold`, min grade 3).
  - **SoD Restriction:** No implicit operational approval authority. Cannot triage survey requests, cannot release survey/audit reports, cannot set staff positions, cannot modify financial records.

### 2.5 System Administrator (`int_sysadmin`)
- **Context:** Platform infrastructure and security administration.
- **Scope:** Global platform configuration, user account provisioning, role assignment, and technical system maintenance.
- **Authorities:**
  - User invitation and account maintenance (`iam.role_assignment`, `core.org_unit`).
  - Outbox and background job monitoring.
  - **SoD Restriction:** Strictly barred from regulated business operations:
    - Cannot triage or accept survey requests (`survey.request.triage`).
    - Cannot assign survey jobs (`survey.job.assign`).
    - Cannot release or sign survey/audit reports (`survey.report.release`, `audit_trail.report.release`).
    - Cannot approve financial credit notes (`billing.credit_note.approve`).
    - Cannot set HR positions or confirm position proposals (`hr.position.set`).
    - Cannot grant or self-approve technical qualifications (`qual.grant`).
  - Enforced by database schema check constraint `iam.authority_rule_sysadmin_ck`.

### 2.6 External Customer (`ext_user`)
- **Context:** Ship owners, ship managers, technical operators, or agents.
- **Scope:** Authorized client organizations (`party.organization`) where active membership exists (`iam.org_membership`).
- **Authorities:**
  - Submit survey requests for owned or managed vessels (`survey.request.create`, `survey.request.submit`).
  - Upload documents and drawings into quarantine for review.
  - Access approved survey reports and certificates for their fleet only.
  - Strictly barred from internal workflow transitions, internal staff directories, or any other client's records.

---

## 3. Segregation-of-Duties (SoD) Rules

1. **Four-Eyes Review (Creator Cannot Approve):**
   - The user who created or submitted a controlled record cannot approve or accept it.
   - Enforced in `api.survey_request_accept`: if `created_by = private.uid()`, raises `creator_cannot_approve` (`42501`).
   - Enforced in `api.position_proposal_confirm`: if `proposed_by = private.uid()` or `user_id = private.uid()`, raises `cannot_confirm_own_proposal` (`42501`).

2. **Sysadmin Isolation:**
   - Platform administration does not confer operational authority.
   - `int_sysadmin` has zero entries in `iam.authority_rule` for business approvals.
   - Check constraint `iam.authority_rule_sysadmin_ck` prevents adding sysadmin approval rules.

3. **No Self-Approval of Positions or Qualifications:**
   - HR administrators cannot set or close their own position (`api.staff_position_set`: `cannot_set_own_position`).
   - Qualification approvers cannot grant qualifications to themselves (`qual.staff_qualification_granted_by_ck`: `granted_by <> user_id`; `api.staff_qualification_grant`: `cannot_grant_self`).

4. **Break-Glass Operational Prohibitions:**
   - Emergency break-glass sessions exist solely to recover platform access and repair broken configurations.
   - Explicitly prohibited from all regulated actions listed in `iam.break_glass_forbidden_action`.
   - Enforced before position resolution in `private.assert_not_break_glass()`.

5. **Certification and Revocation Controls:**
   - Release, signing, countersigning, and revocation of statutory certificates and reports require specific roles, minimum grade levels, and active technical qualifications (`requires_qualification = true`).

---

## 4. Consolidated Action Matrix

| Action Code | Authorized Role(s) | Job Family | Unit Type | Min Grade | Requires Qual? | Scope Type | SoD / Special Controls |
| :--- | :--- | :--- | :--- | :---: | :---: | :--- | :--- |
| `survey.request.create` | `ext_user`, `int_coordinator`, `int_manager` | *any* / `office_admin` | `station` | 1 | No | `unit` / `org` | Valid ship party binding required |
| `survey.request.submit` | `ext_user`, `int_coordinator`, `int_manager` | *any* / `office_admin` | `station` | 1 | No | `unit` / `org` | Valid survey types required; idempotent |
| `survey.request.triage` | `int_coordinator` | `office_admin` | `station` | 2 | No | `unit` | **Creator cannot approve**; break-glass forbidden; sysadmin forbidden |
| `survey.job.assign` | `int_manager` | `management` | `station`, `regional_office` | 4 | No | `unit`, `descendants` | Break-glass forbidden; sysadmin forbidden |
| `survey.report.release` | `int_surveyor` | `survey` | `station` | 2 | **Yes** | `unit` | Regulated approval; break-glass forbidden; sysadmin forbidden |
| `survey.report.countersign` | `int_surveyor` | `survey` | `station` | 3 | **Yes** | `unit` | Four-eyes countersignature; break-glass forbidden |
| `audit_trail.report.release` | `int_auditor` | `audit` | `station` | 2 | **Yes** | `unit` | Regulated approval; break-glass forbidden; sysadmin forbidden |
| `compliance.finding.raise` | `int_compliance` | `compliance` | `ho_department` | 2 | No | `global` | Worldwide compliance oversight |
| `compliance.record.hold` | `int_compliance` | `compliance` | `ho_department` | 3 | No | `global` | Break-glass forbidden |
| `billing.credit_note.approve` | `int_finance` | `finance` | *any* | 4 / 6 | No | `global` | Max $10,000 for grade 4; unlimited for grade 6; break-glass forbidden |
| `hr.position.set` | `int_hr` | `hr` | *any* | 3 | No | `global` | **Cannot set own position**; break-glass forbidden; sysadmin forbidden |
| `iam.external_user.create` | `int_coordinator` | `office_admin` | *any* | 2 | No | `unit` | Station admin creates client contacts |
| `qual.grant` | `int_hr`, `int_compliance` | `hr`, `compliance` | *any* | 3 | No | `global` | **Cannot grant self**; break-glass forbidden; sysadmin forbidden |
| `qual.revoke` | `int_hr`, `int_compliance` | `hr`, `compliance` | *any* | 3 | No | `global` | Break-glass forbidden; sysadmin forbidden |
| `audit_trail.trail.read` | `int_compliance`, `int_manager` | `compliance`, `management` | `ho_department`, `station` | 2 / 4 | No | `global` / `unit` | Compliance read global; manager read own unit |
| `plan.submission.reroute` | `int_manager` | `management` | `plan_approval_centre` | 4 | No | `unit` | PAC management routing |
| `org.unit.create` | `int_coordinator`, `int_manager` | *any* | `regional_office` | 3 | No | `unit` | Delegated org admin under managed regional office |
| `org.unit.close` | `int_manager` | *any* | `regional_office` | 4 | No | `unit` | Regional manager closes descendant station |

---

## 5. Decision Explanation Diagnostics

For authorized diagnostic and support tooling, MMS provides the safe explanation procedure:
```sql
api.explain_authority(
  p_action_code text,
  p_amount numeric default null,
  p_unit_id uuid default null,
  p_record_id uuid default null
)
returns table(
  allowed boolean,
  reason_code text,
  action_code text,
  rule_id uuid,
  details jsonb
);
```

### Standard Reason Codes:
- `ok`: The caller possesses all necessary dimensions to execute the action.
- `break_glass_forbidden`: Operation is prohibited for emergency break-glass sessions.
- `sysadmin_cannot_approve`: System administrators cannot execute regulated business workflows.
- `creator_cannot_approve`: Segregation of duties violation: creator cannot approve their own controlled record.
- `cannot_approve_own`: User cannot approve their own position proposal or HR profile.
- `cannot_grant_self`: Approver cannot grant qualifications to themselves.
- `no_position`: Principal has no active staff position in `iam.staff_position`.
- `out_of_scope`: Target organizational unit is outside the caller's authorized unit hierarchy.
- `rule_not_found`: No authority rule permits this role for the specified action code.
- `min_grade_insufficient`: Principal's staff position grade is lower than the rule minimum.
- `amount_exceeded`: Financial amount exceeds the authorized threshold for caller's grade.
- `position_ineligible`: Caller's job family or unit type does not match rule prerequisites.
- `qualification_required`: Technical qualification is mandatory but caller lacks an active, unrevoked qualification.
