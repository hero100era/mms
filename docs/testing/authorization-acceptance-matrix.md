# MMS Authorization Acceptance Matrix

## 1. Purpose

This document defines the acceptance specification for MMS authorization boundaries. It establishes expectations across organizational dimensions, application roles, technical qualifications, and regulatory authorities.

PostgreSQL Row-Level Security (RLS) and schema constraints remain the final enforcement authority for all rules described herein.

---

## 2. Core Authorization Archetypes

| Caller | Own station | Other station | Global oversight | HR Administration | Platform Admin | Business Approval |
|---|---|---|---|---|---|---|
| **Surveyor** (`int_surveyor`) | Scoped (read/prepare) | Deny | Deny | Deny | Deny | Qualification dependent (only with active qual) |
| **Station Manager** (`int_manager`) | Scoped (manage/triage) | Deny | Deny | Deny | Deny | Workflow / authority dependent |
| **MTS Specialist** (`int_surveyor` in MTS) | Configured coverage | Configured coverage only | Deny | Deny | Deny | Technical authority dependent |
| **Plan Approval Engineer** (`int_surveyor` in PA) | Assigned scope | Assigned scope | Deny | Deny | Deny | Plan approval authority only |
| **HO Compliance** (`int_compliance`) | Oversight | Oversight | Defined global oversight | No implicit HR | Deny | No implicit business approval |
| **HR Officer** (`int_hr`) | HR scope | HR scope | Deny | Yes (`/admin/positions`) | Deny | Deny |
| **Sysadmin** (`int_sysadmin`) | Platform need only | Platform need only | No automatic business grant | No implicit HR | Yes (`/admin/assignments`) | Deny (strict SoD prohibition) |
| **External Customer A** (`ext_user`) | Own company only | Deny | Deny | Deny | Deny | Deny |
| **External Customer B** (`ext_user`) | Own company only | Deny | Deny | Deny | Deny | Deny |
| **Break Glass (Dormant)** (`int_viewer`) | Read-only baseline | Deny | Deny | Deny | Deny | Deny |
| **Break Glass (Active)** (`mms_emergency`) | Emergency access | Emergency access | Emergency access | Admin repair | Admin repair | Deny (cannot sign certificates/reports) |

---

## 3. Mandatory Invariants

### Invariant 1: Identity Separation
The dev-login facility selects persona identity only. Active role selection, session creation, token signing, and PostgreSQL RLS policies apply strictly and identically across all runtimes.

### Invariant 2: Multi-Tenancy & Customer Isolation
An external customer persona associated with Company A (`TEST ABC SHIPPING LTD`) can only observe and manage ships (`MV TEST ALPHA`, `MV TEST BRAVO`) and survey requests belonging to Company A. Requests attempting to view, create, or modify resources belonging to Company B (`TEST XYZ MARITIME LTD` / `MV TEST CHARLIE`) must fail fail-closed with 404 or 403.

### Invariant 3: Station Isolation
Surveyors and station managers are scoped to their assigned station unit. Station operations for Shanghai (`SHA`) are invisible to and cannot be modified by staff from Singapore (`SIN`) or other stations.

### Invariant 4: Segregation of Duties (SoD)
1. **IT Platform Administration vs. HR Administration**: Sysadmin administers role assignments (`iam.role_assignment`) but is forbidden from administering staff organizational positions (`iam.staff_position`). HR administers positions but cannot grant arbitrary database roles.
2. **Platform Administration vs. Regulated Business Operations**: Sysadmins cannot create, triage, accept, reject, or release maritime survey requests.
3. **Emergency Access Boundaries**: An activated break-glass session can inspect and repair operational configurations but is prohibited by database triggers from releasing or signing statutory certificates.

### Invariant 5: Temporal & Qualification Authority
Holding the `int_surveyor` database role does not grant permission to release survey reports. A surveyor must hold an unexpired `qual.qualification` matching the specific regulated action code. When a qualification expires (`surveyor.expired`), all release actions are denied immediately.
