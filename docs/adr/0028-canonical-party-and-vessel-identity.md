# ADR-0028: Canonical Party and Vessel Identity Architecture

- Status: proposed
- Date: 2026-11-08

## Context

Phase R9.1 of the Rectification Plan (`docs/plans/rectification-implementation-plan.md`) requires establishing canonical party and vessel identity with immutable provenance, temporal history, IMO check-digit validation, and audit-backed merge capabilities.

In the current schema:
1. `fleet.ship` contains `name` and `flag_state` as static mutable attributes on the root entity. When a vessel renames or changes registry flag, in-place updates destroy the historical audit trail required by IACS PR 1A (Transfer of Class) and IMO RO Code (Resolution MSC.349(92)).
2. `fleet.ship.imo_number` is verified only by a 7-digit regex `^[0-9]{7}$`, without verifying the statutory IMO check-digit algorithm.
3. `party.organization` lacks official identifier structures (such as IMO Company Numbers, LEIs, national company registry IDs), preventing canonical de-duplication across worldwide maritime registries.
4. Ship management roles (DOC Company, ISM safety management, ISPS security management, Registered Owner, Commercial Operator, Bareboat Charterer) lack explicit temporal validity verification and provenance tracking.
5. Vessel or company duplicate records created by distributed offices or customer self-service lack a controlled, audit-sealed merge protocol.

## Decision

### 1. IMO Check-Digit Enforcement
All vessel IMO numbers and company IMO numbers must satisfy the international standard check-digit formula:
For a 7-digit IMO vessel number $d_1 d_2 d_3 d_4 d_5 d_6 d_7$:
$$d_7 = \left(\sum_{i=1}^6 d_i \times (8 - i)\right) \pmod{10}$$

Implemented via immutable database function `private.is_valid_imo_number(text)` and enforced by table check constraint `ship_imo_number_ck`.

### 2. Temporal Flag, Name, and Registry History
Vessel metadata that can evolve over a ship's lifecycle must not be destructively mutated:
- `fleet.ship_name_history`: `(ship_id, name, valid tstzrange, change_reason, authority_doc_id)` with temporal exclusion constraint `EXCLUDE USING gist (ship_id WITH =, valid WITH &&)` and `[)` bound check.
- `fleet.ship_flag_history`: `(ship_id, flag_state, port_of_registry, call_sign, official_number, valid tstzrange, authority_doc_id)` with temporal exclusion constraint and `[)` bound check.
- The root `fleet.ship` table retains denormalized current attributes (`current_name`, `current_flag_state`) maintained via triggers for fast operational querying.

### 3. Canonical Organization Identification
Expand `party.organization` and companion table `party.organization_identifier`:
- Support standard identifier types: `imo_company_number` (7 digits with checksum), `lei` (20 alphanumeric characters ISO 17442), `national_reg_no`, `tax_id`, `duns`.
- Require `valid tstzrange` and verification status (`unverified`, `verified`, `superseded`).
- Verification must record `verified_by`, `verified_at`, and source document evidence.

### 4. Comprehensive Ship Party Relationships
Expand `fleet.ship_party.party_role` to cover statutory maritime duty holders:
- `registered_owner`: Legal entity holding title.
- `bareboat_charterer`: Entity operating under bareboat registry.
- `doc_company`: Holder of the Document of Compliance (ISM Code 1.1.2).
- `ism_manager`: Company responsible for the Safety Management System.
- `isps_operator`: Company responsible for Ship Security Plan (ISPS Code).
- `commercial_operator`: Commercial charterer/operator.
- `builder`: Shipbuilding yard.
- `agent`: Local port agent.

Each relationship enforces `valid tstzrange` with temporal exclusion constraints preventing overlapping active assignments for mutually exclusive roles (e.g. at most one active `doc_company` per ship).

### 5. Provenance, Deduplication, and Merge Protocol
1. Source attribution: Every vessel and organization record tracks `source_type` (`ihs_markit`, `equasis`, `flag_administration`, `client_submission`, `internal_staff`) and `source_ref`.
2. Controlled merge protocol:
   - Introduce `fleet.ship_merge_log` and `party.organization_merge_log`.
   - Merging two entities re-points dependent foreign keys (`survey_request`, `ship_party`, `document`, `certificate`, `audit_event`) from `source_id` to `target_id`.
   - Marks `source_id` status as `'merged'` with `merged_into_id`.
   - Requires four-eyes confirmation (`merged_by` distinct from `requested_by`) and emits a sealed audit event.

## Consequences

- Conforms with IMO Resolution MSC.349(92) and IACS Procedural Requirements.
- Eliminates destructive updates when vessels reflag, change managers, or rename.
- Prevents invalid IMO numbers from entering the database.
- Provides a mathematically sound foundation for operational surveys, deficiencies, and certificate issuance.
