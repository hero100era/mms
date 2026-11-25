# ADR-0029: Operational Survey Job Separation and Deficiency Lifecycle

- Status: proposed
- Date: 2026-11-08

## Context

Phases R9.2 and R9.4 of the Rectification Plan (`docs/plans/rectification-implementation-plan.md`) require separating customer service requests from operational survey/audit jobs, attendance records, deficiencies/conditions, and billing milestones.

In the current schema:
1. `survey.survey_request` is the only operational entity in the survey domain. It mixes commercial customer intake, station triage, surveyor attendance, findings, and completion into a single flat state machine (`draft`, `submitted`, `in_review`, `approved`, `rejected`, `cancelled`).
2. There is no concept of an operational job (`survey_job`) representing physical attendance by one or more qualified surveyors at a port, shipyard, or offshore berth.
3. Multiple surveys (e.g. Annual Hull Survey, Machinery Survey, Statutory Radio Survey, Load Line Inspection) requested simultaneously in one customer request cannot be split, independently assigned to different specialists, or separately executed.
4. Regulatory findings, conditions of class, and statutory deficiencies lack a dedicated entity with formal due dates, extension authority, corrective action evidence, and independent verification/closure.

## Decision

### 1. Architectural Separation of Request vs. Job
Split the survey workflow into distinct bounded entities:

1. **`survey.survey_request` (Customer Commercial Intake)**:
   - Captures client request, requested location, target dates, scope items, and commercial billing entity.
   - States: `draft` -> `submitted` -> `in_review` -> `accepted` | `rejected` | `cancelled`.
   - Four-eyes triage: Triage acceptance creates one or more operational jobs and binds them to the servicing station.

2. **`survey.survey_job` (Operational Attendance & Execution)**:
   - One request produces 1..N jobs (e.g., Shanghai attendance for hull & machinery, Ningbo attendance for remaining items).
   - Attributes: `job_number`, `request_id`, `ship_id`, `operating_unit_id` (station), `job_type`, `lead_surveyor_id`, `status` (`pending_assignment`, `assigned`, `in_progress`, `technical_review`, `completed`, `cancelled`), `port_code`, `estimated_start`, `estimated_end`.

3. **`survey.job_assignment`**:
   - Assigns qualified staff (`user_id`) with role (`lead_surveyor`, `attending_surveyor`, `trainee`, `specialist`).
   - Validates surveyor qualification scope against ship type and job scope at assignment time.

4. **`survey.attendance_record`**:
   - Records physical or remote attendance sessions (`attended_from`, `attended_to`, `port_code`, `berth_or_anchorage`, `boarding_evidence_doc_id`).

### 2. Regulatory Findings, Class Conditions, and Statutory Deficiencies
Introduce `survey.deficiency` and `survey.deficiency_action`:

1. **Deficiency Schema**:
   - `id uuid primary key default uuidv7()`
   - `job_id uuid references survey.survey_job(id)`
   - `ship_id uuid references fleet.ship(id)`
   - `deficiency_number text not null` (structured identifier)
   - `category text not null` (`statutory_deficiency`, `condition_of_class`, `memorandum_of_class`, `rectified_on_board`, `ism_non_conformity`)
   - `regulatory_reference text not null` (e.g. `SOLAS II-1/Reg.3-1`, `IACS UR S11`, `MARPOL Annex I/Reg.12`)
   - `severity text not null` (`detainable`, `major_non_conformity`, `action_required_prior_to_departure`, `rectify_within_14_days`, `rectify_within_30_days`, `next_scheduled_survey`)
   - `description text not null`
   - `due_date date`
   - `status text not null` (`open`, `postponed`, `rectified`, `verified_closed`, `cancelled`)
   - `raised_by uuid not null references iam.user_account(id)`
   - `closed_by uuid references iam.user_account(id)`
   - `closed_at timestamptz`

2. **Extension / Postponement Authority**:
   - Postponing a condition of class or statutory deficiency due date requires formal authority:
     - Minimum grade requirement (e.g. Senior Principal Surveyor or Station Manager).
     - Flag state concurrence for statutory items (`flag_concurrence_ref`, `flag_concurrence_doc_id`).
     - Justification, risk mitigation measures, and new expiry date.
   - Enforced by `api.deficiency_postpone()` with `private.assert_authority('survey.deficiency.postpone')`.

3. **Closure and Verification**:
   - `api.deficiency_close()` requires:
     - Documented corrective action evidence (`corrective_doc_id`).
     - Independent surveyor verification attendance (`closing_job_id`).
     - Segregation of duties: The person requesting closure cannot be the sole approver if four-eyes review applies.

### 3. Review, Technical Approval, and Milestone Billing
1. **Technical Review (`survey.job_review`)**:
   - Every completed survey job must undergo technical review by a qualified Technical Reviewer or Station Manager before reports or certificates are released.
   - Segregation of duties: The attending surveyor who executed the job cannot perform the technical review (`reviewer_id <> lead_surveyor_id`).
2. **Billing Milestone (`survey.billing_milestone`)**:
   - Decoupled from physical attendance: `fee_type` (`intake_fee`, `attendance_hourly`, `statutory_certificate_fee`, `travel_disbursement`), `amount`, `currency`, `billed_status` (`unbilled`, `invoiced`, `paid`, `waived`).

## Consequences

- Prevents overloading `survey_request` with operational attendance and findings.
- Enables multiple specialized surveyors to execute and log distinct scopes of work on one vessel.
- Enforces IACS and IMO deficiency tracking with auditable due dates and controlled postponements.
- Segregates physical attendance from technical review and commercial billing.
