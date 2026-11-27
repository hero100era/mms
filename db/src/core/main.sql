-- Organisation model. See plan §12.1 and O-01.

create table core.region (
  code text,
  name text not null,
  constraint region_pk primary key (code)
);

create table core.org_unit_type (
  code text,
  scoping text not null,
  default_family text,
  constraint org_unit_type_pk primary key (code),
  constraint org_unit_type_scoping_ck check (scoping in ('location', 'routed', 'global'))
);

create table core.org_unit (
  id uuid not null default uuidv7(),
  code text not null,
  name text not null,
  unit_type text not null,
  parent_id uuid,
  region_code text,
  function_code text,
  level int not null default 0,
  path extensions.ltree,
  active boolean not null default true,
  valid tstzrange not null default tstzrange(now(), null),
  constraint org_unit_pk primary key (id),
  constraint org_unit_code_uk unique (code),
  constraint org_unit_type_fk foreign key (unit_type) references core.org_unit_type (code),
  constraint org_unit_parent_fk foreign key (parent_id) references core.org_unit (id),
  constraint org_unit_region_fk foreign key (region_code) references core.region (code),
  constraint org_unit_parent_ck check (parent_id is distinct from id),
  constraint org_unit_level_ck check (level >= 0),
  constraint org_unit_function_ck check ((unit_type = 'ho_department') = (function_code is not null))
);
create index org_unit_parent_ix on core.org_unit (parent_id);
create index org_unit_region_ix on core.org_unit (region_code);
create index org_unit_path_ix on core.org_unit using gist (path);

create table core.org_unit_coverage (
  id uuid not null default uuidv7(),
  unit_id uuid not null,
  covered_unit_id uuid not null,
  valid tstzrange not null default tstzrange(now(), null),
  set_by uuid not null,
  reason text not null,
  constraint org_unit_coverage_pk primary key (id),
  constraint org_unit_coverage_unit_fk foreign key (unit_id) references core.org_unit (id),
  constraint org_unit_coverage_covered_fk foreign key (covered_unit_id) references core.org_unit (id),
  constraint org_unit_coverage_self_ck check (unit_id <> covered_unit_id),
  -- R2.5: explicit [) range convention (empty ranges allowed).
  constraint org_unit_coverage_valid_bounds_ck check (
    isempty(valid) or (lower_inc(valid) and not upper_inc(valid))
  ),
  constraint org_unit_coverage_ex exclude using gist (unit_id with =, covered_unit_id with =, valid with &&)
);
create index org_unit_coverage_covered_ix on core.org_unit_coverage (covered_unit_id);

create table core.routing_rule (
  id uuid not null default uuidv7(),
  work_type text not null,
  region_code text,
  handling_unit_id uuid not null,
  valid tstzrange not null default tstzrange(now(), null),
  constraint routing_rule_pk primary key (id),
  constraint routing_rule_region_fk foreign key (region_code) references core.region (code),
  constraint routing_rule_handling_fk foreign key (handling_unit_id) references core.org_unit (id),
  constraint routing_rule_ex exclude using gist (work_type with =, (coalesce(region_code, '*')) with =, valid with &&)
);
create index routing_rule_handling_ix on core.routing_rule (handling_unit_id);

create function core.org_unit_descendants(p_roots uuid[])
returns table (id uuid)
language sql
stable
as $$
  with recursive d(id) as (
    select unnest(p_roots)
    union
    select u.id
      from core.org_unit u
      join d on u.parent_id = d.id
  )
  select id from d;
$$;

create trigger org_unit_tree_check
  before insert or update on core.org_unit
  for each row execute function private.org_unit_tree_check();

create trigger org_unit_path_cascade
  after update of code, parent_id on core.org_unit
  for each row execute function private.org_unit_path_cascade();

alter table core.region enable row level security;
alter table core.org_unit_type enable row level security;
alter table core.org_unit enable row level security;
alter table core.org_unit_coverage enable row level security;
alter table core.routing_rule enable row level security;

create policy region_read on core.region
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
    int_compliance, int_hr, int_finance, int_sysadmin
  using (true);

create policy org_unit_type_read on core.org_unit_type
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
    int_compliance, int_hr, int_finance, int_sysadmin
  using (true);

create policy org_unit_read on core.org_unit
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
    int_compliance, int_hr, int_finance, int_sysadmin
  using (true);

create policy org_unit_ext_read on core.org_unit
  for select to ext_user
  using (unit_type = 'station' and active);

create policy org_unit_coverage_read on core.org_unit_coverage
  for select to int_coordinator, int_manager, int_compliance, int_sysadmin
  using (true);

create policy routing_rule_read on core.routing_rule
  for select to int_coordinator, int_manager, int_compliance, int_sysadmin
  using (true);

grant select on core.region, core.org_unit_type,
  core.org_unit_coverage, core.routing_rule to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant select on core.org_unit to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

revoke all on function core.org_unit_descendants(uuid[]) from public;
grant execute on function core.org_unit_descendants(uuid[]) to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

create table core.outbox (
  id uuid primary key default uuidv7(),
  kind text not null,
  payload jsonb not null default '{}',
  status text not null default 'pending',
  attempts int not null default 0,
  max_attempts int not null default 5,
  next_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  leased_by text,
  last_error_class text,
  enqueued_by uuid,
  created_at timestamptz not null default now(),
  constraint outbox_status_ck check (status in ('pending', 'processing', 'done', 'failed', 'dead_letter')),
  constraint outbox_attempts_ck check (attempts >= 0),
  constraint outbox_max_attempts_ck check (max_attempts >= 1)
);
create index outbox_pending_ix on core.outbox (next_at) where status = 'pending';
create index outbox_lease_expired_ix on core.outbox (lease_expires_at) where status = 'processing';

create trigger outbox_audit_capture
  after insert or update or delete on core.outbox
  for each row execute function private.audit_capture();

alter table core.outbox enable row level security;

create policy outbox_worker_admin_all on core.outbox
  for all to worker, int_sysadmin
  using (true)
  with check (true);

create trigger org_unit_audit_capture
  after insert or update or delete on core.org_unit
  for each row execute function private.audit_capture();

create trigger org_unit_coverage_audit_capture
  after insert or update or delete on core.org_unit_coverage
  for each row execute function private.audit_capture();

create trigger routing_rule_audit_capture
  after insert or update or delete on core.routing_rule
  for each row execute function private.audit_capture();

create table core.document (
  id uuid not null default uuidv7(),
  entity_type text not null,
  entity_id uuid not null,
  doc_type text not null,
  title text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  row_version int not null default 1,
  constraint document_pk primary key (id),
  -- R2.1: one logical document per (entity_type, entity_id, doc_type). The
  -- title belongs to the logical document; filenames/MIME data belong to
  -- versions. This constraint also gives document_create_version an atomic
  -- ON CONFLICT target instead of a race-prone select-then-insert.
  constraint document_logical_uk unique (entity_type, entity_id, doc_type),
  constraint document_status_ck check (status in ('active', 'archived', 'superseded'))
);
create index document_entity_ix on core.document (entity_type, entity_id);

create trigger document_stamp
  before insert or update on core.document
  for each row execute function private.stamp();

create trigger document_audit_capture
  after insert or update or delete on core.document
  for each row execute function private.audit_capture();

alter table core.document enable row level security;

create policy document_staff_read on core.document
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (private.can_read_document(id));

create policy document_ext_read on core.document
  for select to ext_user
  using (private.can_read_document(id));

grant select on core.document to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

create table core.document_version (
  id uuid not null default uuidv7(),
  document_id uuid not null,
  revision_no int not null default 1,
  storage_path text not null,
  file_name text not null,
  mime_type text not null,
  byte_size bigint not null,
  sha256 bytea not null,
  scan_status text not null default 'pending',
  scanned_at timestamptz,
  threat_name text,
  scanner_engine text,
  created_at timestamptz not null default now(),
  created_by uuid,
  constraint document_version_pk primary key (id),
  constraint document_version_document_fk foreign key (document_id) references core.document (id),
  constraint document_version_revision_uk unique (document_id, revision_no),
  constraint document_version_revision_ck check (revision_no >= 1),
  constraint document_version_byte_size_ck check (byte_size >= 0),
  constraint document_version_sha256_ck check (octet_length(sha256) = 32),
  constraint document_version_scan_status_ck check (scan_status in ('pending', 'clean', 'infected', 'error'))
);
create index document_version_document_ix on core.document_version (document_id);

create trigger document_version_audit_capture
  after insert or update or delete on core.document_version
  for each row execute function private.audit_capture();

alter table core.document_version enable row level security;

create policy document_version_staff_read on core.document_version
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (private.can_read_document(document_id));

create policy document_version_ext_read on core.document_version
  for select to ext_user
  using (private.can_read_document(document_id));

grant select on core.document_version to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

-- ADR-0023: the upload lifecycle is its own record. A logical document does not
-- exist until an upload reaches `clean`, so an infected or failed upload has a
-- tombstone here (and audit rows) but no core.document and no
-- core.document_version: it can never be attached, downloaded or counted.
--
-- States: prepared -> uploaded -> pending_scan -> clean | infected | error,
-- and prepared/uploaded -> abandoned when the sweep expires them.
create table core.upload (
  id uuid not null default uuidv7(),
  entity_type text not null,
  entity_id uuid not null,
  doc_type text not null,
  file_name text not null,
  mime_type text,
  byte_size bigint,
  -- Written by the server from the bytes it read; the caller never supplies it.
  sha256 bytea,
  quarantine_path text not null,
  upload_state text not null default 'prepared',
  scanner_engine text,
  threat_name text,
  scanned_at timestamptz,
  -- Set when the upload becomes a document, so finalize is replayable.
  document_version_id uuid,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  row_version int not null default 1,
  constraint upload_pk primary key (id),
  constraint upload_document_version_fk foreign key (document_version_id)
    references core.document_version (id),
  constraint upload_entity_type_ck check (entity_type in ('survey_request')),
  constraint upload_state_ck check (
    upload_state in ('prepared', 'uploaded', 'pending_scan', 'clean', 'infected', 'error', 'abandoned')
  ),
  constraint upload_expiry_ck check (expires_at > created_at),
  constraint upload_sha256_ck check (sha256 is null or octet_length(sha256) = 32),
  -- A clean upload must name the version it produced; a non-clean upload must not.
  constraint upload_clean_version_ck check (
    (upload_state = 'clean' and document_version_id is not null)
    or (upload_state <> 'clean' and document_version_id is null)
  ),
  -- Only an approved scanner may settle a verdict.
  constraint upload_verdict_ck check (
    upload_state not in ('clean', 'infected')
    or (scanner_engine is not null and scanned_at is not null
        and private.is_approved_scanner(scanner_engine))
  )
);
create index upload_state_ix on core.upload (upload_state, expires_at);
create unique index upload_path_uk on core.upload (quarantine_path);
create index upload_entity_ix on core.upload (entity_type, entity_id);

create trigger upload_stamp
  before insert or update on core.upload
  for each row execute function private.stamp();

create trigger upload_audit_capture
  after insert or update or delete on core.upload
  for each row execute function private.audit_capture();

alter table core.upload enable row level security;




-- ---------------------------------------------------------------------------
-- Maritime classification and survey reference catalogue
-- ---------------------------------------------------------------------------

create type core.certificate_applicability_enum as enum (
  'Vessel',
  'Company'
);

create type core.task_status_enum as enum (
  'draft',
  'submitted',
  'accepted',
  'assigned',
  'scheduled',
  'planning',
  'executing',
  'pending_review',
  'approved',
  'completed',
  'cancelled',
  'rejected'
);

create type core.survey_status_enum as enum (
  'partial',
  'scheduled',
  'executing',
  'completed',
  'postponed'
);

create type core.data_type_enum as enum (
  'text',
  'integer',
  'decimal',
  'boolean',
  'date',
  'datetime',
  'selection',
  'multi_select'
);

create type core.notation_status_enum as enum (
  'active',
  'suspended',
  'withdrawn',
  'reinstated',
  'expired',
  'pending',
  'conditional'
);

create type core.compatibility_type_enum as enum (
  'requires',
  'incompatible',
  'supersedes',
  'recommended'
);

create table core.administration_type (
  code varchar(2) primary key,
  name varchar(100) not null
);

create table core.class_status (
  code varchar(2) primary key,
  name varchar(100) not null
);

create table core.ship_status (
  code varchar(2) primary key,
  name varchar(100) not null
);

create table core.certificate_status (
  code varchar(2) primary key,
  name varchar(100) not null
);

create table core.certificate_validity_type (
  code varchar(2) primary key,
  name varchar(100) not null
);

create table core.certificate_category (
  code varchar(3) primary key,
  name varchar(100) not null
);

create table core.certificate_internal_category (
  code varchar(3) primary key,
  name varchar(100) not null,
  description text
);

create table core.certificate_action (
  code varchar(3) primary key,
  name varchar(100) not null
);

create table core.survey_audit_status (
  code varchar(2) primary key,
  name varchar(100) not null
);

create table core.comment_type (
  code varchar(2) primary key,
  name varchar(100) not null
);

create table core.comment_status (
  code varchar(1) primary key,
  name varchar(30) not null
);

create table core.classification_society (
  code varchar(20) primary key,
  name varchar(100) not null
);

create table core.vessel_type_iacs (
  code varchar(2) primary key,
  name varchar(100) not null
);

create table core.vessel_type_mms (
  code varchar(2) primary key,
  name varchar(100) not null
);

create table core.certificate_survey_pool (
  code varchar(10) primary key,
  description varchar(100) not null
);

create table core.survey_audit_type (
  code varchar(2) primary key,
  name varchar(100) not null,
  is_scheduled boolean not null
);

create table core.flag (
  code varchar(3) primary key,
  name varchar(20) not null,
  fullname varchar(100) not null,
  email varchar(50),
  tel varchar(30),
  fax varchar(30),
  contact varchar(100),
  contract_file varchar(128),
  contract_start date,
  contract_end date,
  is_hssc boolean default true,
  is_active boolean default true
);

create table core.certificate_template (
  code varchar(10) primary key,
  name varchar(100) not null,
  version varchar(20) not null,
  cert_code varchar(10) references core.certificate_survey_pool (code),
  validity_type varchar(2) references core.certificate_validity_type (code),
  category varchar(3) references core.certificate_category (code),
  internal_category varchar(3) references core.certificate_internal_category (code),
  file_path_xml varchar(255),
  file_path_html varchar(255),
  file_path_pdf varchar(255),
  description text,
  applicability core.certificate_applicability_enum,
  created_at timestamptz default current_timestamp,
  updated_at timestamptz default current_timestamp,
  is_active boolean default true
);

create table core.survey_pool (
  id integer generated always as identity primary key,
  code varchar(20) not null unique,
  name varchar(120) not null,
  description text,
  fee decimal(9, 2),
  cert_code varchar(10) references core.certificate_survey_pool (code) on delete set null,
  type varchar(2) references core.survey_audit_type (code),
  period interval,
  window_before interval,
  window_after interval,
  is_statutory boolean default false,
  is_audit boolean default false,
  is_doc boolean default false,
  is_mandatory boolean default false,
  is_periodical boolean default true,
  created_at timestamptz default current_timestamp,
  updated_at timestamptz default current_timestamp,
  is_active boolean default true,
  constraint unique_mandatory_survey_audit unique (cert_code, type)
);

create table core.report_template (
  code varchar(10) primary key,
  survey_id integer not null references core.survey_pool (id) on delete cascade,
  name varchar(100) not null,
  version varchar(20) not null,
  file_path_rml varchar(255),
  file_path_html varchar(255),
  file_path_pdf varchar(255),
  description text,
  created_at timestamptz default current_timestamp,
  updated_at timestamptz default current_timestamp,
  is_active boolean default true
);

create table core.checklist_result (
  code varchar(2) primary key,
  description varchar(200) not null
);

create table core.breakdown_template (
  id integer generated always as identity primary key,
  code varchar(50) not null,
  name varchar(200) not null,
  description text,
  vessel_type varchar(100),
  version varchar(20) not null default '1.0',
  is_active boolean not null default true,
  parent_template_id integer references core.breakdown_template (id) on delete set null,
  created_by varchar(100),
  updated_by varchar(100),
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  constraint uq_template_code_version unique (code, version)
);

create table core.breakdown_template_node (
  id integer generated always as identity primary key,
  template_id integer not null references core.breakdown_template (id) on delete cascade,
  parent_node_id integer,
  code varchar(50) not null,
  name varchar(200) not null,
  description text,
  category varchar(100),
  node_type varchar(50),
  level integer not null default 0,
  sort_order integer not null default 0,
  is_instantiable boolean not null default true,
  default_quantity integer not null default 1,
  is_active boolean not null default true,
  metadata jsonb default '{}'::jsonb,
  is_mandatory boolean not null default true,
  is_leaf boolean not null default false,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  constraint uq_template_node_code unique (template_id, code),
  constraint uq_template_node_template_id_id unique (template_id, id),
  constraint fk_template_node_parent_same_template
    foreign key (template_id, parent_node_id)
    references core.breakdown_template_node (template_id, id) on delete cascade,
  constraint chk_no_self_parent check (id != parent_node_id)
);

create table core.breakdown_template_node_particular (
  id integer generated always as identity primary key,
  template_node_id integer not null references core.breakdown_template_node (id) on delete cascade,
  attr_key varchar(100) not null,
  attr_title varchar(200) not null,
  data_type core.data_type_enum not null,
  default_value text,
  selection_options jsonb,
  unit varchar(20),
  is_required boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  constraint uq_tnode_attr unique (template_node_id, attr_key)
);

create table core.checklist_section (
  id integer generated always as identity primary key,
  survey_id integer references core.survey_pool (id),
  code varchar(50) not null,
  section_number varchar(20) not null,
  title text not null,
  description text,
  is_active boolean default true
);

create table core.checklist_item (
  id integer generated always as identity primary key,
  code varchar(100),
  item_number integer not null,
  section_id integer references core.checklist_section (id) on delete cascade,
  content varchar(1000),
  description text,
  breakdown_template_node_id integer references core.breakdown_template_node (id) on delete set null,
  reg_reference text,
  referenced_item_id integer references core.checklist_item (id) on delete cascade,
  is_mandatory boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz default current_timestamp,
  updated_at timestamptz default current_timestamp,
  is_active boolean default true
);

create table core.checklist_item_particular (
  id integer generated always as identity primary key,
  checklist_item_id integer not null references core.checklist_item (id) on delete cascade,
  attr_key varchar(100) not null,
  attr_title varchar(300) not null,
  data_type core.data_type_enum not null default 'text',
  unit varchar(50),
  default_value text,
  selection_options jsonb,
  is_required boolean not null default true,
  sort_order integer not null default 0,
  description text,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (checklist_item_id, attr_key)
);

create table core.flag_cert_authorization (
  id integer generated always as identity primary key,
  flag_code varchar(3) not null references core.flag (code) on delete cascade,
  cert_code varchar(10) not null references core.certificate_survey_pool (code) on delete cascade,
  validity_type varchar(2) references core.certificate_validity_type (code),
  category varchar(3) references core.certificate_category (code),
  internal_category varchar(3) references core.certificate_internal_category (code),
  created_at timestamptz default current_timestamp,
  updated_at timestamptz default current_timestamp,
  is_active boolean default true
);

create table core.flag_survey_authorization (
  id integer generated always as identity primary key,
  flag_code varchar(3) not null references core.flag (code) on delete cascade,
  cert_code varchar(10) not null references core.certificate_survey_pool (code) on delete cascade,
  survey_type varchar(2) references core.survey_audit_type (code),
  created_at timestamptz default current_timestamp,
  updated_at timestamptz default current_timestamp,
  is_active boolean default true
);

create table core.survey_preparation_section (
  id integer generated always as identity primary key,
  survey_id integer not null references core.survey_pool (id) on delete cascade,
  code varchar(100),
  category varchar(20),
  content varchar(1000),
  description text,
  guidance text,
  created_at timestamptz default current_timestamp,
  updated_at timestamptz default current_timestamp,
  is_active boolean default true
);

create table core.survey_preparation (
  id integer generated always as identity primary key,
  survey_id integer not null references core.survey_pool (id) on delete cascade,
  code varchar(100),
  category varchar(2),
  description text,
  guidance text,
  remarks text,
  created_at timestamptz default current_timestamp,
  updated_at timestamptz default current_timestamp,
  is_active boolean default true
);

create table core.survey_documentation (
  id integer generated always as identity primary key,
  survey_id integer not null references core.survey_pool (id) on delete cascade,
  code varchar(100),
  description text,
  guidance text,
  remarks text,
  file_path varchar(255),
  is_mandatory boolean default true,
  created_at timestamptz default current_timestamp,
  updated_at timestamptz default current_timestamp,
  is_active boolean default true
);

create table core.notation_group (
  id integer generated always as identity primary key,
  group_code varchar(50) not null unique,
  group_name varchar(200) not null,
  description text,
  display_order int not null default 1,
  separator_before varchar(3) default '.',
  separator_within varchar(3) default ',',
  min_notations int not null default 0,
  max_notations int,
  is_mandatory boolean generated always as (min_notations >= 1) stored,
  allows_multiple boolean generated always as (max_notations is null or max_notations > 1) stored,
  is_prefix boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz default current_timestamp
);

create table core.society_group_rendering (
  id integer generated always as identity primary key,
  society_code varchar(20) not null references core.classification_society (code),
  group_id int not null references core.notation_group (id),
  separator_before varchar(20),
  separator_within varchar(10),
  prefix varchar(20),
  suffix varchar(20),
  display_order int not null,
  is_active boolean not null default true,
  constraint uq_society_group_render unique (society_code, group_id)
);

create table core.class_notation (
  id integer generated always as identity primary key,
  society_code varchar(20) not null references core.classification_society (code),
  group_id integer references core.notation_group (id),
  notation_code varchar(100) not null,
  notation_symbol varchar(200),
  notation_name varchar(300) not null,
  description text,
  is_parameterized boolean not null default false,
  parameter_template varchar(200),
  allowed_parameters jsonb,
  applicable_ship_types text[],
  applicable_rules varchar(500),
  incompatible_notations int[],
  effective_from date,
  superseded_date date,
  superseded_by integer references core.class_notation (id),
  is_active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz default current_timestamp,
  updated_at timestamptz default current_timestamp,
  constraint uq_notation_per_society unique (society_code, notation_code)
);

create table core.notation_compatibility (
  id integer generated always as identity primary key,
  notation_id integer not null references core.class_notation (id),
  related_notation_id integer not null references core.class_notation (id),
  compatibility_type core.compatibility_type_enum not null,
  description text,
  is_active boolean not null default true,
  created_at timestamptz default current_timestamp,
  updated_at timestamptz default current_timestamp,
  constraint uq_notation_compat unique (notation_id, related_notation_id, compatibility_type),
  constraint chk_no_self_prereq check (notation_id != related_notation_id)
);


-- Wave 2: Foreign-key B-tree indexes for core catalogue tables
create index certificate_template_cert_code_ix on core.certificate_template (cert_code);
create index certificate_template_validity_type_ix on core.certificate_template (validity_type);
create index certificate_template_category_ix on core.certificate_template (category);
create index certificate_template_internal_cat_ix on core.certificate_template (internal_category);
create index survey_pool_cert_code_ix on core.survey_pool (cert_code);
create index survey_pool_type_ix on core.survey_pool (type);
create index report_template_survey_id_ix on core.report_template (survey_id);
create index breakdown_template_parent_ix on core.breakdown_template (parent_template_id);
create index breakdown_template_node_template_ix on core.breakdown_template_node (template_id);
create index breakdown_template_node_parent_ix on core.breakdown_template_node (template_id, parent_node_id);
create index breakdown_template_node_part_node_ix on core.breakdown_template_node_particular (template_node_id);
create index checklist_section_survey_id_ix on core.checklist_section (survey_id);
create index checklist_item_section_id_ix on core.checklist_item (section_id);
create index checklist_item_tnode_id_ix on core.checklist_item (breakdown_template_node_id);
create index checklist_item_ref_item_id_ix on core.checklist_item (referenced_item_id);
create index checklist_item_part_item_id_ix on core.checklist_item_particular (checklist_item_id);
create index flag_cert_auth_flag_code_ix on core.flag_cert_authorization (flag_code);
create index flag_cert_auth_cert_code_ix on core.flag_cert_authorization (cert_code);
create index flag_survey_auth_flag_code_ix on core.flag_survey_authorization (flag_code);
create index flag_survey_auth_cert_code_ix on core.flag_survey_authorization (cert_code);
create index survey_prep_section_survey_id_ix on core.survey_preparation_section (survey_id);
create index survey_prep_survey_id_ix on core.survey_preparation (survey_id);
create index survey_doc_survey_id_ix on core.survey_documentation (survey_id);
create index society_group_rendering_society_ix on core.society_group_rendering (society_code);
create index society_group_rendering_group_ix on core.society_group_rendering (group_id);
create index class_notation_society_ix on core.class_notation (society_code);
create index class_notation_group_ix on core.class_notation (group_id);
create index class_notation_superseded_ix on core.class_notation (superseded_by);
create index notation_compat_notation_ix on core.notation_compatibility (notation_id);
create index notation_compat_related_ix on core.notation_compatibility (related_notation_id);

-- Wave 2 (H-13): Tier-1 audit capture on regulated core catalogue tables
create trigger flag_audit_capture
  after insert or update or delete on core.flag
  for each row execute function private.audit_capture();
create trigger flag_cert_authorization_audit_capture
  after insert or update or delete on core.flag_cert_authorization
  for each row execute function private.audit_capture();
create trigger flag_survey_authorization_audit_capture
  after insert or update or delete on core.flag_survey_authorization
  for each row execute function private.audit_capture();
create trigger survey_pool_audit_capture
  after insert or update or delete on core.survey_pool
  for each row execute function private.audit_capture();
create trigger class_notation_audit_capture
  after insert or update or delete on core.class_notation
  for each row execute function private.audit_capture();
create trigger breakdown_template_audit_capture
  after insert or update or delete on core.breakdown_template
  for each row execute function private.audit_capture();
create trigger breakdown_template_node_audit_capture
  after insert or update or delete on core.breakdown_template_node
  for each row execute function private.audit_capture();

-- Wave 2 (H-12): Enable RLS and read policies on all 36 core catalogue tables
alter table core.administration_type enable row level security;
alter table core.class_status enable row level security;
alter table core.ship_status enable row level security;
alter table core.certificate_status enable row level security;
alter table core.certificate_validity_type enable row level security;
alter table core.certificate_category enable row level security;
alter table core.certificate_internal_category enable row level security;
alter table core.certificate_action enable row level security;
alter table core.survey_audit_status enable row level security;
alter table core.comment_type enable row level security;
alter table core.comment_status enable row level security;
alter table core.classification_society enable row level security;
alter table core.vessel_type_iacs enable row level security;
alter table core.vessel_type_mms enable row level security;
alter table core.certificate_survey_pool enable row level security;
alter table core.survey_audit_type enable row level security;
alter table core.flag enable row level security;
alter table core.certificate_template enable row level security;
alter table core.survey_pool enable row level security;
alter table core.report_template enable row level security;
alter table core.checklist_result enable row level security;
alter table core.breakdown_template enable row level security;
alter table core.breakdown_template_node enable row level security;
alter table core.breakdown_template_node_particular enable row level security;
alter table core.checklist_section enable row level security;
alter table core.checklist_item enable row level security;
alter table core.checklist_item_particular enable row level security;
alter table core.flag_cert_authorization enable row level security;
alter table core.flag_survey_authorization enable row level security;
alter table core.survey_preparation_section enable row level security;
alter table core.survey_preparation enable row level security;
alter table core.survey_documentation enable row level security;
alter table core.notation_group enable row level security;
alter table core.society_group_rendering enable row level security;
alter table core.class_notation enable row level security;
alter table core.notation_compatibility enable row level security;

create policy administration_type_read on core.administration_type
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy class_status_read on core.class_status
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy ship_status_read on core.ship_status
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy certificate_status_read on core.certificate_status
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy certificate_validity_type_read on core.certificate_validity_type
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy certificate_category_read on core.certificate_category
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy certificate_internal_category_read on core.certificate_internal_category
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy certificate_action_read on core.certificate_action
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy survey_audit_status_read on core.survey_audit_status
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy comment_type_read on core.comment_type
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy comment_status_read on core.comment_status
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy classification_society_read on core.classification_society
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy vessel_type_iacs_read on core.vessel_type_iacs
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy vessel_type_mms_read on core.vessel_type_mms
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy certificate_survey_pool_read on core.certificate_survey_pool
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy survey_audit_type_read on core.survey_audit_type
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy flag_read on core.flag
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy certificate_template_read on core.certificate_template
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy survey_pool_read on core.survey_pool
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy report_template_read on core.report_template
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy checklist_result_read on core.checklist_result
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy breakdown_template_read on core.breakdown_template
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy breakdown_template_node_read on core.breakdown_template_node
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy breakdown_template_node_particular_read on core.breakdown_template_node_particular
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy checklist_section_read on core.checklist_section
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy checklist_item_read on core.checklist_item
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy checklist_item_particular_read on core.checklist_item_particular
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy flag_cert_authorization_read on core.flag_cert_authorization
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy flag_survey_authorization_read on core.flag_survey_authorization
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy survey_preparation_section_read on core.survey_preparation_section
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy survey_preparation_read on core.survey_preparation
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy survey_documentation_read on core.survey_documentation
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy notation_group_read on core.notation_group
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy society_group_rendering_read on core.society_group_rendering
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy class_notation_read on core.class_notation
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);
create policy notation_compatibility_read on core.notation_compatibility
  for select to ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
                int_manager, int_compliance, int_hr, int_finance, int_sysadmin
  using (true);

grant select on
  core.administration_type,
  core.class_status,
  core.ship_status,
  core.certificate_status,
  core.certificate_validity_type,
  core.certificate_category,
  core.certificate_internal_category,
  core.certificate_action,
  core.survey_audit_status,
  core.comment_type,
  core.comment_status,
  core.classification_society,
  core.vessel_type_iacs,
  core.vessel_type_mms,
  core.certificate_survey_pool,
  core.survey_audit_type,
  core.certificate_template,
  core.survey_pool,
  core.report_template,
  core.checklist_result,
  core.breakdown_template,
  core.breakdown_template_node,
  core.breakdown_template_node_particular,
  core.checklist_section,
  core.checklist_item,
  core.checklist_item_particular,
  core.flag_cert_authorization,
  core.flag_survey_authorization,
  core.survey_preparation_section,
  core.survey_preparation,
  core.survey_documentation,
  core.notation_group,
  core.society_group_rendering,
  core.class_notation,
  core.notation_compatibility
to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

-- H-12: Restrict ext_user on core.flag to public non-contact columns only
grant select on core.flag to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;
grant select (code, name, fullname, is_hssc, is_active) on core.flag to ext_user;
