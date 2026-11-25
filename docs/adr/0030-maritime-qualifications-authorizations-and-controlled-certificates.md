# ADR-0030: Competence Authorizations, Controlled Maritime Certificates, and Class Notations

- Status: proposed
- Date: 2026-11-08

## Context

Phases R9.3, R9.5, and R9.6 of the Rectification Plan (`docs/plans/rectification-implementation-plan.md`) require modeling surveyor competence and statutory authorizations distinct from generic application roles, establishing certificates as controlled immutable records, and modeling class notation lifecycle history.

In the current schema:
1. Application role `int_surveyor` allows a user to invoke surveyor endpoints, but does not verify whether the individual holds competence or statutory flag authorization for a specific vessel type (e.g., Oil Tanker vs Passenger Ship), flag administration (e.g., Panama vs Liberia vs Marshall Islands), or statutory convention (SOLAS, MARPOL, Load Line, ISM, ISPS).
2. Certificates do not exist as controlled database records; there is no model for certificate templates, issuance prerequisites, signatory verification at signing time, intermediate endorsements, or immutable PDF artifact hashes.
3. Class notations are not cataloged or versioned, preventing clear distinction between full class, provisional class, suspended notations, or withdrawn notations.

## Decision

### 1. Surveyor Competence and Statutory Authorizations (R9.3)
Establish a distinct authorization subsystem under the `qual` schema:

1. **`qual.competence_catalog`**:
   - Master catalog of maritime qualifications, survey scopes, and standards (e.g. `HULL_BASIC`, `MACHINERY_PROPULSION`, `OIL_TANKER_CARGO`, `ISM_LEAD_AUDITOR`, `POLAR_CODE_OPS`).
2. **`qual.statutory_authorization`**:
   - Flag State delegations (RO Code Section 3): `(user_id, flag_state, convention_code, valid tstzrange, delegation_evidence_doc_id, status)`.
   - Distinguishes between internal staff qualifications and external flag-state mandated authorisations.
3. **Execution-Time Authorization Check**:
   - Before a surveyor is assigned to a job or signs a certificate/report, `api.check_surveyor_eligibility(p_user_id, p_ship_id, p_scope_code)` verifies:
     - Active staff position and grade;
     - Unexpired competence record for the specific ship type and scope;
     - Active flag administration authorization (if statutory);
     - Absence of suspension or conflict of interest (e.g., cannot survey a vessel managed by an affiliated company).

### 2. Certificates as Controlled Records (R9.5)
Introduce controlled certificate lifecycle under `cert` schema:

1. **`cert.certificate_template`**:
   - Code, formal title, regulatory convention (e.g., `SOLAS_SAFCON`, `MARPOL_IOPP`, `LOAD_LINE_LL66`, `ISM_SMC`), statutory vs class classification, standard validity period (e.g., 5 years), endorsement window schedule.
2. **`cert.certificate_instance`**:
   - `id uuid primary key default uuidv7()`
   - `certificate_number text not null unique` (canonical formatting with security checksum)
   - `template_id uuid references cert.certificate_template(id)`
   - `ship_id uuid references fleet.ship(id)`
   - `status text not null` (`draft`, `pending_signature`, `issued`, `extended`, `suspended`, `withdrawn`, `reissued`, `cancelled`)
   - `issue_basis text not null` (`initial_survey`, `renewal_survey`, `short_term_interim`, `reissue_after_rectification`)
   - `issue_date date not null`
   - `expiry_date date not null`
   - `issuing_station_id uuid references core.org_unit(id)`
   - `signatory_user_id uuid references iam.user_account(id)`
   - `signed_at timestamptz`
   - `document_version_id uuid references core.document_version(id)` (immutable PDF artifact)
   - `public_verification_code text not null unique` (for flag and port state control validation)

3. **Critical Lifecycle Invariants**:
   - **Prerequisites verification**: A certificate cannot transition to `pending_signature` unless all mandatory survey job items and prerequisite deficiencies are confirmed rectified or cleared.
   - **Signatory authorization**: When `api.certificate_sign()` is called, the database verifies at signing time:
     - The signatory has valid delegated signing authority for the flag and convention;
     - The signatory is not in an emergency/break-glass session (`assert_not_break_glass`);
     - The signatory did not execute the survey unattended without independent review (four-eyes).
   - **Immutability of issued artifacts**: Once `status = 'issued'`, the associated PDF document version is permanently sealed. Any subsequent correction, amendment, or endorsement creates a new instance linked via `replaces_certificate_id`, preserving the complete chain of custody.
   - **Controlled extensions**: Extending a certificate beyond standard convention windows requires explicit recording of legal basis (e.g., `SOLAS I/Reg.14(e)` 3-month port-of-survey extension), flag administration authorization document, reason, and new expiration date.

### 3. Class Notation Catalog and History (R9.6)
Introduce `fleet.class_notation_catalog` and `fleet.ship_notation_history`:
- Catalog codes: Hull notations (`+100A1`, `Ice Class 1A`), Machinery notations (`+LMC`, `UMS`), Cargo notations (`Oil Tanker, ESP`), Environmental notations (`CLEAN-AIR`, `BWTS`).
- Temporal history: `(ship_id, notation_id, status, valid tstzrange, assigned_reason, withdrawal_reason, related_certificate_id)`.
- Public vs internal views: Public registry views expose only currently active, non-confidential notations; internal views display full suspension, withdrawal, and survey audit links.

## Consequences

- Enforces strict compliance with IMO RO Code (Resolution MSC.349(92)), Code for Recognized Organizations, and IACS Procedural Requirements.
- Guarantees that generic IT application roles cannot authorize uncertified personnel to execute specialized maritime statutory surveys.
- Guarantees that certificates are immutable, verifiable, and protected by four-eyes signatory verification at signing time.
- Establishes full temporal transparency for class notations and vessel statutory status.
