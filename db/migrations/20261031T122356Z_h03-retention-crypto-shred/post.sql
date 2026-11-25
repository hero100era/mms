-- Seed statutory retention classes RC-1 through RC-7
insert into audit_trail.retention_class
  (class_code, name, description, statutory_retention_years, active_db_retention_years, disposition_policy, requires_worm, crypto_shred_eligible)
values
  ('RC-1', 'Identity and Access', 'Authentication attempts, session histories, role assignment changes, user status transitions', 7, 2, 'cold_archive', true, true),
  ('RC-2', 'Operational Surveys & Triage', 'Operational survey triage, attendances, non-conformities, Conditions of Class (CoC), deficiencies', 10, 5, 'cold_archive', true, false),
  ('RC-3', 'Technical Ship Data & Plan Approvals', 'Ship particulars, hull/machinery specifications, approved drawings, technical stability calculations', 30, 10, 'cold_immutable', true, false),
  ('RC-4', 'Issued Statutory & Class Certificates', 'Formal interim/full-term class and statutory certificates, statements of compliance, certified reports', 30, 10, 'cold_immutable', true, false),
  ('RC-5', 'Row-Level Audit Change Log', 'Granular row modification diffs captured by private.audit_capture() on all domain tables', 30, 2, 'seal_and_worm', true, true),
  ('RC-6', 'Administrative Events', 'Structural organizational changes: unit creation/closure, MTS coverage, routing rule changes, user account suspension', 7, 3, 'cold_archive', true, false),
  ('RC-7', 'Database Schema Changes & Migration Ledgers', 'Migration ledger (public.schema_migrations), Git history, pgaudit DDL logs', null, null, 'perpetual', true, false)
on conflict (class_code) do update
  set name = excluded.name,
      description = excluded.description,
      statutory_retention_years = excluded.statutory_retention_years,
      active_db_retention_years = excluded.active_db_retention_years,
      disposition_policy = excluded.disposition_policy,
      requires_worm = excluded.requires_worm,
      crypto_shred_eligible = excluded.crypto_shred_eligible;

-- Seed default table retention policies
insert into audit_trail.table_retention_policy (schema_name, table_name, retention_class, description) values
  ('iam', 'app_user', 'RC-1', 'Identity and access user profiles'),
  ('iam', 'session', 'RC-1', 'User sessions and login activity'),
  ('iam', 'role_assignment', 'RC-1', 'Capability role assignments'),
  ('iam', 'staff_position', 'RC-1', 'Staff position assignments and compensation grades'),
  ('survey', 'survey_request', 'RC-2', 'Operational survey triage and requests'),
  ('fleet', 'ship', 'RC-3', 'Vessel particulars and technical registers'),
  ('core', 'document', 'RC-4', 'Issued artifacts and documentation metadata'),
  ('core', 'document_version', 'RC-4', 'Document binary hashes and versions'),
  ('core', 'org_unit', 'RC-6', 'Organizational structure and units'),
  ('party', 'organization', 'RC-6', 'Customer and partner organizations')
on conflict (schema_name, table_name) do update
  set retention_class = excluded.retention_class,
      description = excluded.description;

-- Backfill retention classes on event types
update audit_trail.event_type set retention_class = 'RC-1' where code like 'auth.%' or code like 'iam.%' or code like 'authz.%';
update audit_trail.event_type set retention_class = 'RC-2' where code like 'survey.%';
update audit_trail.event_type set retention_class = 'RC-4' where code like 'core.document%';
update audit_trail.event_type set retention_class = 'RC-6' where code like 'org.%';
update audit_trail.event_type set retention_class = 'RC-1' where code = 'privacy.crypto_shred.executed';
update audit_trail.event_type set retention_class = 'RC-6' where code in ('audit_trail.retention.purged', 'audit_trail.retention.hold_applied');
