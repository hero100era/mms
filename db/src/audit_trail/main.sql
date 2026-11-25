-- Tier 1 audit capture & Tier 2 cryptographic sealing. Not partitioned; see ADR/plan §8.2, §8.5.

create table audit_trail.change_log (
  id           bigint generated always as identity,
  occurred_at  timestamptz not null default clock_timestamp(),
  tx_id        xid8 not null default pg_current_xact_id(),
  schema_name  text not null,
  table_name   text not null,
  op           char(1) not null,
  row_id       uuid,
  row_key      text,
  old_row      jsonb,
  new_row      jsonb,
  changed_cols text[],
  actor_id     uuid,
  actor_label  text,
  db_role      text not null,
  session_id   uuid,
  auth_method  text,
  on_behalf_of uuid,
  initiated_by uuid,
  request_id   text,
  trace_id     text,
  source       text not null,
  client_ip    inet,
  reason       text,
  constraint change_log_pk primary key (id),
  constraint change_log_op_ck check (op in ('I', 'U', 'D')),
  constraint change_log_source_ck check (source in ('web', 'job', 'import', 'integration', 'dba', 'break_glass'))
);
create index change_log_subject_ix on audit_trail.change_log (schema_name, table_name, row_id);
create index change_log_row_key_ix on audit_trail.change_log (schema_name, table_name, row_key);
create index change_log_tx_ix on audit_trail.change_log (tx_id);

create table audit_trail.retention_class (
  class_code                text not null,
  name                      text not null,
  description               text not null,
  statutory_retention_years int,
  active_db_retention_years int,
  disposition_policy        text not null,
  requires_worm             boolean not null default true,
  crypto_shred_eligible     boolean not null default false,
  constraint retention_class_pk primary key (class_code),
  constraint retention_class_disposition_ck check (
    disposition_policy in ('cold_archive', 'cold_immutable', 'seal_and_worm', 'perpetual')
  )
);

create table audit_trail.event_type (
  code            text,
  description     text not null,
  regulated       boolean not null,
  reason_required boolean not null default false,
  retention_class text,
  constraint event_type_pk primary key (code),
  constraint event_type_retention_class_fk foreign key (retention_class) references audit_trail.retention_class (class_code)
);

create table audit_trail.table_retention_policy (
  schema_name     text not null,
  table_name      text not null,
  retention_class text not null,
  description     text not null,
  constraint table_retention_policy_pk primary key (schema_name, table_name),
  constraint table_retention_policy_fk foreign key (retention_class) references audit_trail.retention_class (class_code)
);

create table audit_trail.event (
  id               bigint generated always as identity,
  occurred_at      timestamptz not null default clock_timestamp(),
  tx_id            xid8 not null default pg_current_xact_id(),
  event_type       text not null,
  outcome          text not null,
  actor_id         uuid,
  session_id       uuid,
  db_role          text not null,
  auth_method      text,
  on_behalf_of     uuid,
  initiated_by     uuid,
  actor_title      text,
  actor_grade      int,
  actor_unit_id    uuid,
  authority_rule_id uuid,
  subject_type     text,
  subject_id       uuid,
  subject_revision int,
  scope_unit_id    uuid,
  request_id       text,
  trace_id         text,
  source           text not null,
  client_ip        inet,
  user_agent       text,
  reason           text,
  detail           jsonb not null default '{}',
  constraint event_pk primary key (id),
  constraint event_type_fk foreign key (event_type) references audit_trail.event_type (code),
  constraint event_outcome_ck check (outcome in ('success', 'failure', 'denied')),
  constraint event_detail_size_ck check (pg_column_size(detail) < 8192)
);
create index event_subject_ix on audit_trail.event (subject_type, subject_id);
create index event_scope_ix on audit_trail.event (scope_unit_id, occurred_at);
create index event_tx_ix on audit_trail.event (tx_id);

create table audit_trail.excluded_column (
  schema_name text,
  table_name  text,
  column_name text,
  mode        text not null,
  reason      text not null,
  constraint excluded_column_pk primary key (schema_name, table_name, column_name),
  constraint excluded_column_mode_ck check (mode in ('omit', 'mask'))
);

create table audit_trail.regulated_function (
  function_schema text not null,
  function_name   text not null,
  event_type      text not null,
  action_code     text,
  description     text not null,
  constraint regulated_function_pk primary key (function_schema, function_name),
  constraint regulated_function_event_type_fk foreign key (event_type) references audit_trail.event_type (code)
);

-- Tier 2 horizon sealing ledger
create table audit_trail.seal (
  id               bigint generated always as identity,
  sealed_at        timestamptz not null default clock_timestamp(),
  sealed_by        text not null default session_user,
  from_xid         xid8 not null,
  to_xid           xid8 not null,
  change_log_count int not null,
  event_count      int not null,
  batch_hash       text not null,
  prev_seal_hash   text not null,
  seal_hash        text not null,
  worm_uri         text not null,
  worm_sha256      text not null,
  constraint seal_pk primary key (id),
  constraint seal_xid_range_ck check (from_xid <= to_xid),
  constraint seal_counts_ck check (change_log_count >= 0 and event_count >= 0),
  constraint seal_hashes_length_ck check (
    length(batch_hash) = 64 and length(prev_seal_hash) = 64 and
    length(seal_hash) = 64 and length(worm_sha256) = 64
  )
);
create index seal_xid_ix on audit_trail.seal (from_xid, to_xid);
create index seal_hash_ix on audit_trail.seal (seal_hash);

-- Tier 2 event reconciliation & log forwarder catalogs (H-02)
create table audit_trail.controlled_column (
  schema_name          text not null,
  table_name           text not null,
  column_name          text not null,
  regulated_event_type text,
  description          text not null,
  constraint controlled_column_pk primary key (schema_name, table_name, column_name)
);

create table audit_trail.reconciliation_run (
  id                   bigint generated always as identity,
  run_at               timestamptz not null default clock_timestamp(),
  window_start         timestamptz not null,
  window_end           timestamptz not null,
  from_xid             xid8,
  to_xid               xid8,
  checked_change_count int not null,
  checked_event_count  int not null,
  discrepancy_count    int not null,
  status               text not null,
  detail               jsonb not null default '{}',
  constraint reconciliation_run_pk primary key (id),
  constraint reconciliation_run_status_ck check (status in ('clean', 'discrepancies_found', 'failed'))
);
create index reconciliation_run_time_ix on audit_trail.reconciliation_run (run_at);

create table audit_trail.reconciliation_discrepancy (
  id               bigint generated always as identity,
  run_id           bigint not null,
  detected_at      timestamptz not null default clock_timestamp(),
  change_log_id    bigint not null,
  tx_id            xid8 not null,
  schema_name      text not null,
  table_name       text not null,
  column_name      text not null,
  row_id           uuid,
  discrepancy_type text not null,
  details          jsonb not null default '{}',
  constraint reconciliation_discrepancy_pk primary key (id),
  constraint reconciliation_discrepancy_run_fk foreign key (run_id) references audit_trail.reconciliation_run (id),
  constraint reconciliation_discrepancy_change_fk foreign key (change_log_id) references audit_trail.change_log (id),
  constraint reconciliation_discrepancy_type_ck check (
    discrepancy_type in ('missing_event', 'mismatched_event_type', 'event_failure_outcome', 'unauthorized_mutation')
  )
);
create index reconciliation_discrepancy_run_ix on audit_trail.reconciliation_discrepancy (run_id);
create index reconciliation_discrepancy_tx_ix on audit_trail.reconciliation_discrepancy (tx_id);

create table audit_trail.forwarder_watermark (
  sink_id                text not null,
  last_change_log_id     bigint not null default 0,
  last_event_id          bigint not null default 0,
  last_tx_id             xid8,
  last_forwarded_at      timestamptz not null default clock_timestamp(),
  forwarded_batch_count  bigint not null default 0,
  forwarded_record_count bigint not null default 0,
  last_batch_hash        text,
  updated_at             timestamptz not null default clock_timestamp(),
  constraint forwarder_watermark_pk primary key (sink_id)
);

create table audit_trail.crypto_shred_key (
  subject_id      uuid not null,
  key_status      text not null default 'active',
  algorithm       text not null default 'AES-256-GCM',
  encrypted_key   text not null,
  key_fingerprint text not null,
  created_at      timestamptz not null default clock_timestamp(),
  shredded_at     timestamptz,
  shredded_by     uuid,
  shred_reason    text,
  constraint crypto_shred_key_pk primary key (subject_id),
  constraint crypto_shred_key_status_ck check (key_status in ('active', 'shredded'))
);
create index crypto_shred_key_status_ix on audit_trail.crypto_shred_key (key_status);

create table audit_trail.retention_purge_run (
  id                      bigint generated always as identity,
  executed_at             timestamptz not null default clock_timestamp(),
  executed_by             text not null default session_user,
  retention_class         text not null,
  cutoff_time             timestamptz not null,
  max_sealed_xid          xid8 not null,
  change_log_purged_count int not null,
  event_purged_count      int not null,
  reason                  text not null,
  status                  text not null,
  constraint retention_purge_run_pk primary key (id),
  constraint retention_purge_run_class_fk foreign key (retention_class) references audit_trail.retention_class (class_code),
  constraint retention_purge_run_status_ck check (status in ('completed', 'failed'))
);
create index retention_purge_run_time_ix on audit_trail.retention_purge_run (executed_at);

create table audit_trail.entra_sync_run (
  id                      bigint generated always as identity,
  run_at                  timestamptz not null default clock_timestamp(),
  status                  text not null,
  users_checked           int not null default 0,
  users_deprovisioned     int not null default 0,
  deprovisioned_user_ids  uuid[] not null default '{}',
  error_message           text,
  detail                  jsonb not null default '{}',
  constraint entra_sync_run_pk primary key (id),
  constraint entra_sync_run_status_ck check (
    status in ('clean', 'deprovisioned', 'failed')
  )
);
create index entra_sync_run_time_ix on audit_trail.entra_sync_run (run_at);

create table audit_trail.malware_scan_run (
  id                      bigint generated always as identity,
  run_at                  timestamptz not null default clock_timestamp(),
  version_id              uuid,
  document_id             uuid,
  file_name               text not null,
  sha256                  bytea not null,
  byte_size               bigint not null,
  scanner_engine          text not null,
  status                  text not null,
  threat_name             text,
  quarantine_path         text not null,
  promoted_path           text,
  scanned_by              text not null,
  detail                  jsonb not null default '{}',
  constraint malware_scan_run_pk primary key (id),
  constraint malware_scan_run_status_ck check (
    status in ('clean', 'infected', 'error')
  ),
  constraint malware_scan_run_sha256_ck check (octet_length(sha256) = 32),
  constraint malware_scan_run_byte_size_ck check (byte_size >= 0)
);
create index malware_scan_run_time_ix on audit_trail.malware_scan_run (run_at);
create index malware_scan_run_version_ix on audit_trail.malware_scan_run (version_id);
create index malware_scan_run_status_ix on audit_trail.malware_scan_run (status, run_at);

alter table audit_trail.change_log enable row level security;
alter table audit_trail.event enable row level security;
alter table audit_trail.regulated_function enable row level security;
alter table audit_trail.seal enable row level security;
alter table audit_trail.controlled_column enable row level security;
alter table audit_trail.reconciliation_run enable row level security;
alter table audit_trail.reconciliation_discrepancy enable row level security;
alter table audit_trail.forwarder_watermark enable row level security;
alter table audit_trail.retention_class enable row level security;
alter table audit_trail.table_retention_policy enable row level security;
alter table audit_trail.crypto_shred_key enable row level security;
alter table audit_trail.retention_purge_run enable row level security;
alter table audit_trail.entra_sync_run enable row level security;
alter table audit_trail.malware_scan_run enable row level security;

create policy change_log_read on audit_trail.change_log
  for select to int_compliance, int_sysadmin, audit_sealer, worker
  using (true);

create policy event_read on audit_trail.event
  for select to int_compliance, int_sysadmin, audit_sealer, worker
  using (true);

create policy event_manager_read on audit_trail.event
  for select to int_manager
  using (
    scope_unit_id = any (private.my_offices())
    or scope_unit_id = any (private.my_units())
  );

create policy event_own_read on audit_trail.event
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (actor_id = private.uid());

create policy regulated_function_read on audit_trail.regulated_function
  for select to int_compliance, int_sysadmin, int_manager, int_hr, int_coordinator
  using (true);

create policy seal_read on audit_trail.seal
  for select to int_compliance, int_sysadmin, audit_sealer
  using (true);

create policy seal_insert on audit_trail.seal
  for insert to audit_sealer
  with check (true);

create policy controlled_column_read on audit_trail.controlled_column
  for select to int_compliance, int_sysadmin, int_manager, audit_sealer, worker
  using (true);

create policy reconciliation_run_read on audit_trail.reconciliation_run
  for select to int_compliance, int_sysadmin, audit_sealer, worker
  using (true);

create policy reconciliation_run_insert on audit_trail.reconciliation_run
  for insert to audit_sealer, worker
  with check (true);

create policy reconciliation_discrepancy_read on audit_trail.reconciliation_discrepancy
  for select to int_compliance, int_sysadmin, audit_sealer, worker
  using (true);

create policy reconciliation_discrepancy_insert on audit_trail.reconciliation_discrepancy
  for insert to audit_sealer, worker
  with check (true);

-- Insert and update only: the watermark may be advanced, never deleted.
-- The SELECT policy is not optional even though only upserts are written:
-- PostgreSQL requires SELECT on the table to resolve `ON CONFLICT DO UPDATE`,
-- and the forwarder uses exactly that (one row per sink, advanced in place).
create policy forwarder_watermark_write on audit_trail.forwarder_watermark
  for select to audit_sealer, worker, int_sysadmin
  using (true);

create policy forwarder_watermark_insert on audit_trail.forwarder_watermark
  for insert to audit_sealer, worker, int_sysadmin
  with check (true);

create policy forwarder_watermark_update on audit_trail.forwarder_watermark
  for update to audit_sealer, worker, int_sysadmin
  using (true)
  with check (true);

create policy forwarder_watermark_read on audit_trail.forwarder_watermark
  for select to int_compliance
  using (true);

create policy retention_class_read on audit_trail.retention_class
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager, int_compliance, int_hr, int_finance, int_sysadmin, audit_sealer, worker
  using (true);

create policy table_retention_policy_read on audit_trail.table_retention_policy
  for select to int_compliance, int_sysadmin, int_manager, audit_sealer, worker
  using (true);

create policy crypto_shred_key_read on audit_trail.crypto_shred_key
  for select to int_compliance, int_sysadmin, audit_sealer, worker
  using (true);

-- Key records are written once and then only marked as shredded; a deleted
-- key row would erase the evidence that a subject was ever encrypted.
create policy crypto_shred_key_insert on audit_trail.crypto_shred_key
  for insert to audit_sealer, worker, int_sysadmin
  with check (true);

create policy crypto_shred_key_update on audit_trail.crypto_shred_key
  for update to audit_sealer, worker, int_sysadmin
  using (true)
  with check (true);

create policy retention_purge_run_read on audit_trail.retention_purge_run
  for select to int_compliance, int_sysadmin, audit_sealer, worker
  using (true);

create policy retention_purge_run_insert on audit_trail.retention_purge_run
  for insert to audit_sealer, worker, int_sysadmin
  with check (true);

create policy entra_sync_run_read on audit_trail.entra_sync_run
  for select to int_compliance, int_sysadmin, audit_sealer, worker
  using (true);

create policy entra_sync_run_insert on audit_trail.entra_sync_run
  for insert to worker, int_sysadmin
  with check (true);

create policy malware_scan_run_read on audit_trail.malware_scan_run
  for select to int_compliance, int_sysadmin, audit_sealer, worker
  using (true);

create policy malware_scan_run_insert on audit_trail.malware_scan_run
  for insert to worker, int_sysadmin
  with check (true);

alter table audit_trail.event_type enable row level security;
alter table audit_trail.excluded_column enable row level security;

create policy event_type_read on audit_trail.event_type
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin,
                audit_sealer, worker
  using (true);

create policy excluded_column_read on audit_trail.excluded_column
  for select to int_compliance, int_sysadmin, audit_sealer, worker
  using (true);

create trigger change_log_append_only
  before update or delete on audit_trail.change_log
  for each row execute function private.change_log_append_only();

create trigger event_append_only
  before update or delete on audit_trail.event
  for each row execute function private.event_append_only();

create trigger seal_append_only
  before update or delete on audit_trail.seal
  for each row execute function private.seal_append_only();

create trigger reconciliation_run_append_only
  before update or delete on audit_trail.reconciliation_run
  for each row execute function private.reconciliation_append_only();

create trigger reconciliation_discrepancy_append_only
  before update or delete on audit_trail.reconciliation_discrepancy
  for each row execute function private.reconciliation_append_only();

create trigger crypto_shred_key_guard
  before update or delete on audit_trail.crypto_shred_key
  for each row execute function private.crypto_shred_key_guard();

create trigger retention_purge_run_append_only
  before update or delete on audit_trail.retention_purge_run
  for each row execute function private.retention_purge_run_append_only();

create trigger entra_sync_run_append_only
  before update or delete on audit_trail.entra_sync_run
  for each row execute function private.reconciliation_append_only();

create trigger malware_scan_run_append_only
  before update or delete on audit_trail.malware_scan_run
  for each row execute function private.reconciliation_append_only();

create trigger change_log_no_truncate
  before truncate on audit_trail.change_log
  for each statement execute function private.audit_no_truncate();

create trigger event_no_truncate
  before truncate on audit_trail.event
  for each statement execute function private.audit_no_truncate();

create trigger seal_no_truncate
  before truncate on audit_trail.seal
  for each statement execute function private.audit_no_truncate();

create trigger reconciliation_run_no_truncate
  before truncate on audit_trail.reconciliation_run
  for each statement execute function private.audit_no_truncate();

create trigger reconciliation_discrepancy_no_truncate
  before truncate on audit_trail.reconciliation_discrepancy
  for each statement execute function private.audit_no_truncate();

create trigger crypto_shred_key_no_truncate
  before truncate on audit_trail.crypto_shred_key
  for each statement execute function private.audit_no_truncate();

create trigger retention_purge_run_no_truncate
  before truncate on audit_trail.retention_purge_run
  for each statement execute function private.audit_no_truncate();

create trigger entra_sync_run_no_truncate
  before truncate on audit_trail.entra_sync_run
  for each statement execute function private.audit_no_truncate();

create trigger malware_scan_run_no_truncate
  before truncate on audit_trail.malware_scan_run
  for each statement execute function private.audit_no_truncate();

grant usage on schema audit_trail to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin, audit_sealer, worker;

grant select on audit_trail.change_log to int_compliance, int_sysadmin, audit_sealer, worker;

grant select on audit_trail.event to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin, audit_sealer, worker;

grant select on audit_trail.event_type to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin, audit_sealer, worker;

grant select on audit_trail.regulated_function to
  int_compliance, int_sysadmin, int_manager, int_hr, int_coordinator;

grant select on audit_trail.seal to int_compliance, int_sysadmin, audit_sealer;
grant insert on audit_trail.seal to audit_sealer;

grant select on audit_trail.controlled_column to
  int_compliance, int_sysadmin, int_manager, audit_sealer, worker;

grant select, insert on audit_trail.reconciliation_run to audit_sealer, worker;
grant select on audit_trail.reconciliation_run to int_compliance, int_sysadmin;

grant select, insert on audit_trail.reconciliation_discrepancy to audit_sealer, worker;
grant select on audit_trail.reconciliation_discrepancy to int_compliance, int_sysadmin;

grant select, insert, update on audit_trail.forwarder_watermark to audit_sealer, worker, int_sysadmin;
grant select on audit_trail.forwarder_watermark to int_compliance;

grant select on audit_trail.retention_class to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin, audit_sealer, worker;

grant select on audit_trail.table_retention_policy to
  int_compliance, int_sysadmin, int_manager, audit_sealer, worker;

grant select on audit_trail.crypto_shred_key to
  int_compliance, int_sysadmin;
grant select, insert, update on audit_trail.crypto_shred_key to
  audit_sealer, worker, int_sysadmin;

grant select on audit_trail.retention_purge_run to
  int_compliance, int_sysadmin;
grant select, insert on audit_trail.retention_purge_run to
  audit_sealer, worker, int_sysadmin;

grant select on audit_trail.entra_sync_run to
  int_compliance, int_sysadmin;
grant select, insert on audit_trail.entra_sync_run to
  worker, int_sysadmin;

grant select on audit_trail.malware_scan_run to
  int_compliance, audit_sealer;
grant select, insert on audit_trail.malware_scan_run to
  worker, int_sysadmin;


