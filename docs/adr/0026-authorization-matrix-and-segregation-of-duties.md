# ADR-0026: Consolidated Authorization Matrix and Segregation-of-Duties Controls

- Status: proposed
- Date: 2026-11-08

## Context

Phase R6 of the Rectification Plan (`docs/plans/rectification-implementation-plan.md`) requires consolidating the MMS authorization model into a comprehensive matrix across ten operational dimensions, providing safe diagnostic decision explanation, and establishing database-enforced segregation of duties (SoD) to prevent conflicts of interest and unauthorized regulated actions.

Key risks addressed:
1. Four-eyes review bypass: A user who creates or submits a controlled record (such as a survey request or position proposal) must not be permitted to accept or approve it.
2. Administrative privilege creep: System administrators (`int_sysadmin`) must not implicitly gain business approval authority by virtue of their administrative role.
3. Self-granting: Qualification and HR administrators must not approve their own competencies or positions.
4. Break-glass abuse: Emergency access tokens must remain strictly barred from regulated certifications, releases, or approvals.

## Decision

1. **Publish Consolidated Matrix:** Document the 10 dimensions (Role, Authority, Scope Type, Unit Relationship, Staff Position Validity, Qualification Validity, Workflow State, Ownership/Assignment, Step-Up, Segregation of Duties) in `docs/security/authorization-matrix.md`.
2. **Authority-Decision Explanation:**
   - Introduce `private.explain_authority` and `api.explain_authority` returning `(allowed boolean, reason_code text, action_code text, rule_id uuid, details jsonb)`.
   - Use stable, non-sensitive reason codes (`ok`, `creator_cannot_approve`, `sysadmin_cannot_approve`, `break_glass_forbidden`, `no_position`, `out_of_scope`, `rule_not_found`, `min_grade_insufficient`, `amount_exceeded`, `qualification_required`).
   - Restrict invocation to authenticated internal support and compliance roles.
3. **Database-Enforced Segregation of Duties:**
   - In `api.survey_request_accept`: reject triage acceptance when `created_by = private.uid()` with `creator_cannot_approve` (`42501`).
   - In `api.position_proposal_confirm`: reject confirmation when `proposed_by = private.uid()` or `user_id = private.uid()` with `cannot_confirm_own_proposal` (`42501`).
   - In `iam.authority_rule`: add check constraint `authority_rule_sysadmin_ck` forbidding `int_sysadmin` from holding regulated action codes.
   - In `api.staff_qualification_grant`: enforce `assert_not_break_glass('qual.grant')` and forbid self-approval (`cannot_grant_self`).
   - In `iam.break_glass_forbidden_action`: ensure all operational triage, release, signing, holding, and qualification operations are explicitly registered and checked before position resolution.

## Consequences

- All six organizational archetypes (station manager, centralized PAC, centralized MTS, HO Compliance, sysadmin, external customer) are protected by database checks.
- Regulated business actions require independent review (four-eyes).
- Security audit logs record failed attempts with specific denial codes.
