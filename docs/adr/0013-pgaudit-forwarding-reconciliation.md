# ADR-0013: pgaudit, off-DB log forwarding, alerting and daily event reconciliation

- Status: proposed (Card H-02)
- Date: 2026-10-31

## Context

ADR-0007 established the two-tier audit architecture for MMS, and ADR-0012 established the Tier-2 horizon sealing protocol. However, ADR-0012 §6 explicitly noted a stated residual risk:
> A privileged database operator or superuser altering unsealed rows or executing direct database mutations before the horizon sealer runs cannot be detected by cryptographic sealing alone (since sealing hashes the already-tampered state).

Furthermore, section 8.4 of the MMS Implementation Plan mandates:
1. Every regulated transition function emits exactly its event in the same transaction (`tx_id`) as its `change_log` rows.
2. Direct capability-role updates to controlled columns (`status`, `scope`, `released`, positions) are denied.
3. Daily event reconciliation (detecting any controlled-column modifications in `audit_trail.change_log` lacking a matching valid `audit_trail.event`) must operate as a core Tier-2 integrity safeguard.
4. Schema migrations executed by `migrator` must have DDL audit trails captured via `pgaudit` and forwarded off-database.

Section 12.5 (Card H-02) mandates the implementation of:
`pgaudit (incl. DDL by migrator), off-DB log forwarding, alerts, daily event reconciliation`.

## Decision

Implement the Tier-2 Integrity Hardening framework across four integrated pillars:

### 1. pgaudit & DDL Audit Logging

1. **Extension Bootstrap**:
   - Register `pgaudit` in `db/bootstrap/02_schemas.sql` with safe fallback handling when `pgaudit` shared library is absent from local or container environments.
2. **Role Settings for DDL**:
   - Configure login role `migrator` with `pgaudit_trail.log = 'ddl'` in `db/bootstrap/04_role_settings.sql`. All migration DDL statements (`CREATE`, `ALTER`, `DROP`, `GRANT`, `REVOKE`) are logged to the PostgreSQL cluster audit stream with timestamp, session user, and statement text.
3. **Migration Ledger Cross-Check**:
   - `public.schema_migrations` runtime ledger (`file`, `sha256`, `applied_by`, `applied_at`, `result`) provides deterministic correlation against DDL audit logs.

### 2. Controlled Column Catalog & Daily Event Reconciliation

1. **Declarative Catalog (`audit_trail.controlled_column`)**:
   - Registers all table columns whose state transitions are legally or operationally controlled:
     - `survey.survey_request`: `status`, `office_unit_id`
     - `core.document_version`: `quarantined`
     - `iam.staff_position`: `job_title_id`, `compensation_grade`, `direct_report`, `reports_to_position_id`, `reason`
     - `iam.app_user`: `status`
     - `core.org_unit`: `active`, `unit_type`, `parent_id`
     - `fleet.ship`: `status`, `active`
2. **Reconciliation Ledger (`audit_trail.reconciliation_run` & `audit_trail.reconciliation_discrepancy`)**:
   - Records every reconciliation execution: time window `[window_start, window_end]`, transaction horizon `[from_xid, to_xid]`, checked records, discrepancy counts, and status (`clean`, `discrepancies_found`, `failed`).
   - Discrepancy items record the change log ID, `tx_id`, schema, table, modified column, affected row ID, discrepancy type (`missing_event`, `mismatched_event_type`, `event_failure_outcome`), and contextual metadata.
3. **Reconciliation Engine (`EventReconciler`)**:
   - Operates across audit horizons or time ranges.
   - For every row in `audit_trail.change_log` touching a controlled column:
     - Identifies corresponding rows in `audit_trail.event` sharing the same `tx_id`.
     - Asserts that at least one matching event exists.
     - Asserts that the event outcome is `success`.
     - Validates that the event type matches the regulated event type configured for that controlled column.
   - Emits a high-priority `CRITICAL` alert (`RECONCILIATION_DISCREPANCY`) whenever an unrecorded or out-of-band change is detected.

### 3. Off-DB Log Forwarding

1. **Independent Evidence Forwarding (`LogForwarder`)**:
   - Streams database audit log records (`audit_trail.change_log`, `audit_trail.event`, and raw pgaudit entries) to an external, independently administered log workspace / SIEM / WORM sink.
   - Guarantees at-least-once delivery with monotonic sequence numbering, batch checksums, and persistent watermarking.
2. **Forwarder Health & Lag Tracking**:
   - Tracks forwarder checkpoint (`last_forwarded_id`, `last_forwarded_tx_id`, `last_forwarded_at`).
   - Monitors unforwarded backlog count and lag time.
   - Emits alerts when forwarder lag breaches configured thresholds or when delivery fails.

### 4. Security Alerting Framework (`Alerter`)

1. **Unified Alert Notification Bus**:
   - Structured alert events categorized by severity:
     - `CRITICAL`: Reconciliation discrepancies (bypassed business event / tampering), WORM digest mismatch, verifier tamper detection, forwarder delivery failure.
     - `WARNING`: Transaction horizon lag exceeding threshold, log forwarder backlog lag.
     - `INFO`: Clean reconciliation completed, sealing horizon advancement, forwarder checkpoint saved.
2. **Pluggable Alert Sinks**:
   - `MemoryAlertSink` for automated testing and assertions.
   - `ConsoleAlertSink` for operational logging.
   - `WebhookAlertSink` / SIEM sink for production security operations center (SOC) delivery.

## Consequences

- Direct bypasses of API transition functions (such as out-of-band superuser `UPDATE` queries) are automatically flagged by daily reconciliation and cannot escape detection.
- DDL modifications by migration runners are captured in PostgreSQL audit logs.
- Audit evidence is replicated off-database in near-real-time, mitigating the risk of database administrator tampering prior to sealing.
- Automated alerts notify compliance and operations teams of discrepancies, sealing stalls, or forwarder failures.
