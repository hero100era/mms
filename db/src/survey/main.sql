-- survey: survey requests and inspection lifecycle.

create sequence survey.request_no_seq
  as bigint
  start with 1000
  increment by 1;

grant usage on sequence survey.request_no_seq to
  ext_user, int_coordinator, int_manager, int_sysadmin;

create table survey.survey_request (
  id uuid not null default uuidv7(),
  request_no text not null,
  ship_id uuid not null,
  org_id uuid not null,
  office_unit_id uuid not null,
  status text not null default 'draft',
  survey_types text[] not null default '{}',
  port_name text not null,
  port_country text not null default 'CN',
  port_code text,
  estimated_arrival timestamptz not null default now(),
  estimated_departure timestamptz not null default (now() + interval '3 days'),
  agent_contact jsonb not null default '{}'::jsonb,
  scope_description text,
  triage_notes text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  row_version int not null default 1,
  constraint survey_request_pk primary key (id),
  constraint survey_request_request_no_uk unique (request_no),
  constraint survey_request_ship_fk foreign key (ship_id) references fleet.ship (id),
  constraint survey_request_org_fk foreign key (org_id) references party.organization (id),
  constraint survey_request_office_fk foreign key (office_unit_id) references core.org_unit (id),
  constraint survey_request_status_ck check (status in ('draft', 'submitted', 'accepted', 'clarification_requested', 'rejected')),
  constraint survey_request_dates_ck check (estimated_departure >= estimated_arrival)
);
create index survey_request_ship_ix on survey.survey_request (ship_id);
create index survey_request_org_ix on survey.survey_request (org_id);
create index survey_request_office_ix on survey.survey_request (office_unit_id);
create index survey_request_status_ix on survey.survey_request (status);

create trigger survey_request_stamp
  before insert or update on survey.survey_request
  for each row execute function private.stamp();

create trigger survey_request_office_check
  before insert or update on survey.survey_request
  for each row execute function private.survey_request_office_check();

create trigger survey_request_audit_capture
  after insert or update or delete on survey.survey_request
  for each row execute function private.audit_capture();

alter table survey.survey_request enable row level security;

create policy survey_request_staff_read on survey.survey_request
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (office_unit_id = any (private.my_offices()));

create policy survey_request_ext_read on survey.survey_request
  for select to ext_user
  using (org_id = any (private.my_org_ids()));

grant select on survey.survey_request to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

-- ---------------------------------------------------------------------------
-- Survey request scope bundling (adapted from iclass survey_request_cart)
-- ---------------------------------------------------------------------------

create table survey.survey_request_item (
  id uuid not null default uuidv7(),
  survey_request_id uuid not null,
  survey_audit_id uuid,
  finding_comment_id uuid,
  survey_catalog_id integer,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  row_version int not null default 1,
  constraint survey_request_item_pk primary key (id),
  constraint survey_request_item_req_fk foreign key (survey_request_id) references survey.survey_request (id) on delete cascade,
  constraint survey_request_item_sa_fk foreign key (survey_audit_id) references fleet.survey_audit (id) on delete set null,
  constraint survey_request_item_fc_fk foreign key (finding_comment_id) references fleet.finding_comment (id) on delete set null,
  constraint survey_request_item_catalog_fk foreign key (survey_catalog_id) references core.survey_audit_catalog (id) on delete set null,
  constraint survey_request_item_target_ck check (num_nonnulls(survey_audit_id, finding_comment_id, survey_catalog_id) = 1)
);
create index survey_request_item_req_ix on survey.survey_request_item (survey_request_id);
create index survey_request_item_sa_ix on survey.survey_request_item (survey_audit_id);
create index survey_request_item_fc_ix on survey.survey_request_item (finding_comment_id);
create index survey_request_item_cat_ix on survey.survey_request_item (survey_catalog_id);
create unique index survey_request_item_req_sa_uk
  on survey.survey_request_item (survey_request_id, survey_audit_id)
  where (survey_audit_id is not null);
create unique index survey_request_item_req_fc_uk
  on survey.survey_request_item (survey_request_id, finding_comment_id)
  where (finding_comment_id is not null);
create unique index survey_request_item_req_cat_uk
  on survey.survey_request_item (survey_request_id, survey_catalog_id)
  where (survey_catalog_id is not null);

-- ---------------------------------------------------------------------------
-- Unified job execution, checklists, certificate lines, and comment lines
-- ---------------------------------------------------------------------------

create table survey.job (
  id uuid not null default uuidv7(),
  job_type text not null default 'survey',
  parent_job_id uuid,
  survey_request_id uuid,
  ship_id uuid,
  org_id uuid,
  office_unit_id uuid not null,
  lead_user_id uuid,
  reviewer_user_id uuid,
  job_status core.task_status_enum not null default 'draft',
  description varchar(200),
  location varchar(100),
  fee decimal(9, 2),
  comments text,
  additional text,
  report_document_id uuid,
  draft_document_id uuid,
  initialized boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  row_version int not null default 1,
  constraint job_pk primary key (id),
  constraint job_type_ck check (job_type in ('survey', 'audit', 'doc')),
  constraint job_target_ck check (ship_id is not null or org_id is not null),
  constraint job_no_self_parent_ck check (parent_job_id is null or parent_job_id <> id),
  constraint job_sod_ck check (lead_user_id is null or reviewer_user_id is null or lead_user_id <> reviewer_user_id),
  constraint job_parent_fk foreign key (parent_job_id) references survey.job (id) on delete cascade,
  constraint job_request_fk foreign key (survey_request_id) references survey.survey_request (id) on delete set null,
  constraint job_ship_fk foreign key (ship_id) references fleet.ship (id) on delete set null,
  constraint job_org_fk foreign key (org_id) references party.organization (id) on delete set null,
  constraint job_office_fk foreign key (office_unit_id) references core.org_unit (id),
  constraint job_lead_fk foreign key (lead_user_id) references iam.app_user (id),
  constraint job_reviewer_fk foreign key (reviewer_user_id) references iam.app_user (id),
  constraint job_report_doc_fk foreign key (report_document_id) references core.document (id) on delete set null,
  constraint job_draft_doc_fk foreign key (draft_document_id) references core.document (id) on delete set null
);
create index job_parent_ix on survey.job (parent_job_id);
create index job_request_ix on survey.job (survey_request_id);
create index job_ship_ix on survey.job (ship_id);
create index job_org_ix on survey.job (org_id);
create index job_office_ix on survey.job (office_unit_id);
create index job_status_ix on survey.job (job_status);

create table survey.job_participant (
  id uuid not null default uuidv7(),
  job_id uuid not null,
  user_id uuid not null,
  is_monitor boolean not null default false,
  is_trainee boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  row_version int not null default 1,
  constraint job_participant_pk primary key (id),
  constraint job_participant_uk unique (job_id, user_id),
  constraint job_participant_job_fk foreign key (job_id) references survey.job (id) on delete cascade,
  constraint job_participant_user_fk foreign key (user_id) references iam.app_user (id) on delete cascade
);
create index job_participant_job_ix on survey.job_participant (job_id);
create index job_participant_user_ix on survey.job_participant (user_id);

create table survey.certificate_line (
  id uuid not null default uuidv7(),
  job_id uuid not null,
  certificate_no bigint not null default private.next_certificate_no(),
  ref_certificate_id uuid,
  action_code varchar(3) not null,
  certificate_template_code varchar(10),
  cert_code varchar(10) not null,
  validity_type varchar(2) not null,
  category varchar(3) not null,
  internal_category varchar(3) not null,
  issued_by_user_id uuid,
  description varchar(120),
  expiry_date date,
  extended_date date,
  mlc_declaration_date date,
  mlc_declaration_place varchar(50),
  doc_administration varchar(3),
  version integer not null default 1,
  draft_document_id uuid,
  cert_document_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  row_version int not null default 1,
  constraint certificate_line_pk primary key (id),
  constraint certificate_line_version_ck check (version >= 1),
  constraint certificate_line_job_fk foreign key (job_id) references survey.job (id) on delete cascade,
  constraint certificate_line_ref_cert_fk foreign key (ref_certificate_id) references fleet.certificate (id) on delete set null,
  constraint certificate_line_action_fk foreign key (action_code) references core.certificate_action (code),
  constraint certificate_line_template_fk foreign key (certificate_template_code) references core.certificate_template (code) on delete set null,
  constraint certificate_line_cert_code_fk foreign key (cert_code) references core.certificate_type (code),
  constraint certificate_line_validity_fk foreign key (validity_type) references core.certificate_validity_type (code),
  constraint certificate_line_category_fk foreign key (category) references core.certificate_category (code),
  constraint certificate_line_int_cat_fk foreign key (internal_category) references core.certificate_internal_category (code),
  constraint certificate_line_issued_by_fk foreign key (issued_by_user_id) references iam.app_user (id),
  constraint certificate_line_draft_doc_fk foreign key (draft_document_id) references core.document (id) on delete set null,
  constraint certificate_line_cert_doc_fk foreign key (cert_document_id) references core.document (id) on delete set null,
  constraint certificate_line_doc_admin_fk foreign key (doc_administration) references core.flag (code)
);
create index certificate_line_job_ix on survey.certificate_line (job_id);
create index certificate_line_ref_cert_ix on survey.certificate_line (ref_certificate_id);
create index certificate_line_doc_admin_ix on survey.certificate_line (doc_administration);

create table survey.survey_line (
  id uuid not null default uuidv7(),
  job_id uuid not null,
  survey_audit_id uuid,
  survey_catalog_id integer,
  description varchar(120),
  next_due_date date,
  postponement_date date,
  execution_status core.survey_execution_status_enum,
  range_from_date date,
  range_to_date date,
  initialized boolean not null default false,
  credit_periodical boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  row_version int not null default 1,
  constraint survey_line_pk primary key (id),
  constraint survey_line_range_ck check (range_from_date is null or range_to_date is null or range_to_date >= range_from_date),
  constraint survey_line_job_fk foreign key (job_id) references survey.job (id) on delete cascade,
  constraint survey_line_sa_fk foreign key (survey_audit_id) references fleet.survey_audit (id) on delete set null,
  constraint survey_line_catalog_fk foreign key (survey_catalog_id) references core.survey_audit_catalog (id) on delete set null
);
create index survey_line_job_ix on survey.survey_line (job_id);
create index survey_line_sa_ix on survey.survey_line (survey_audit_id);
create index survey_line_catalog_ix on survey.survey_line (survey_catalog_id);

create table survey.checklist_entry (
  id bigint generated always as identity primary key,
  job_id uuid not null,
  survey_line_id uuid not null,
  survey_audit_id uuid,
  item_id integer,
  ship_breakdown_node_id integer,
  result varchar(2),
  metadata jsonb not null default '{}'::jsonb,
  report_by uuid,
  report_at timestamptz not null default now(),
  constraint checklist_entry_job_fk foreign key (job_id) references survey.job (id) on delete cascade,
  constraint checklist_entry_line_fk foreign key (survey_line_id) references survey.survey_line (id) on delete cascade,
  constraint checklist_entry_sa_fk foreign key (survey_audit_id) references fleet.survey_audit (id) on delete set null,
  constraint checklist_entry_item_fk foreign key (item_id) references core.checklist_item (id) on delete set null,
  constraint checklist_entry_node_fk foreign key (ship_breakdown_node_id) references fleet.ship_breakdown_node (id) on delete cascade,
  constraint checklist_entry_result_fk foreign key (result) references core.checklist_result (code),
  constraint checklist_entry_report_by_fk foreign key (report_by) references iam.app_user (id)
);
create index checklist_entry_job_ix on survey.checklist_entry (job_id);
create index checklist_entry_line_ix on survey.checklist_entry (survey_line_id);
create index checklist_entry_node_ix on survey.checklist_entry (ship_breakdown_node_id);

create table survey.checklist_entry_particular (
  id bigint generated always as identity primary key,
  checklist_entry_id bigint not null,
  source_particular_id integer,
  ship_breakdown_node_id integer,
  attr_key varchar(100) not null,
  attr_title varchar(300) not null,
  data_type core.data_type_enum not null default 'text',
  unit varchar(50),
  selection_options jsonb,
  is_required boolean not null default false,
  sort_order integer not null default 0,
  attr_result text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint checklist_entry_particular_entry_fk foreign key (checklist_entry_id) references survey.checklist_entry (id) on delete cascade,
  constraint checklist_entry_particular_src_fk foreign key (source_particular_id) references core.checklist_item_particular (id) on delete set null,
  constraint checklist_entry_particular_node_fk foreign key (ship_breakdown_node_id) references fleet.ship_breakdown_node (id) on delete cascade,
  constraint checklist_entry_particular_uk unique nulls not distinct (checklist_entry_id, attr_key, ship_breakdown_node_id)
);
create index checklist_entry_particular_entry_ix on survey.checklist_entry_particular (checklist_entry_id);
create index checklist_entry_particular_node_ix on survey.checklist_entry_particular (ship_breakdown_node_id);

create table survey.finding_line (
  id uuid not null default uuidv7(),
  job_id uuid not null,
  finding_comment_id uuid,
  finding_type varchar(2),
  is_private boolean not null default false,
  due_date date,
  status varchar(1),
  postponed_due_date date,
  mms_reference varchar(20),
  subject varchar(500),
  body text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  row_version int not null default 1,
  constraint finding_line_pk primary key (id),
  constraint finding_line_job_fk foreign key (job_id) references survey.job (id) on delete cascade,
  constraint finding_line_fc_fk foreign key (finding_comment_id) references fleet.finding_comment (id) on delete set null,
  constraint finding_line_type_fk foreign key (finding_type) references core.finding_type (code),
  constraint finding_line_status_fk foreign key (status) references core.finding_status (code)
);
create index finding_line_job_ix on survey.finding_line (job_id);
create index finding_line_fc_ix on survey.finding_line (finding_comment_id);

create trigger survey_request_item_stamp
  before insert or update on survey.survey_request_item
  for each row execute function private.stamp();

create trigger survey_request_item_audit_capture
  after insert or update or delete on survey.survey_request_item
  for each row execute function private.audit_capture();

create trigger job_stamp
  before insert or update on survey.job
  for each row execute function private.stamp();

create trigger job_audit_capture
  after insert or update or delete on survey.job
  for each row execute function private.audit_capture();

create trigger job_participant_stamp
  before insert or update on survey.job_participant
  for each row execute function private.stamp();

create trigger job_participant_audit_capture
  after insert or update or delete on survey.job_participant
  for each row execute function private.audit_capture();

create trigger certificate_line_stamp
  before insert or update on survey.certificate_line
  for each row execute function private.stamp();

create trigger certificate_line_audit_capture
  after insert or update or delete on survey.certificate_line
  for each row execute function private.audit_capture();

create trigger survey_line_stamp
  before insert or update on survey.survey_line
  for each row execute function private.stamp();

create trigger survey_line_audit_capture
  after insert or update or delete on survey.survey_line
  for each row execute function private.audit_capture();

create trigger checklist_entry_audit_capture
  after insert or update or delete on survey.checklist_entry
  for each row execute function private.audit_capture();

create trigger checklist_entry_particular_audit_capture
  after insert or update or delete on survey.checklist_entry_particular
  for each row execute function private.audit_capture();

create trigger finding_line_stamp
  before insert or update on survey.finding_line
  for each row execute function private.stamp();

create trigger finding_line_audit_capture
  after insert or update or delete on survey.finding_line
  for each row execute function private.audit_capture();

alter table survey.survey_request_item enable row level security;
alter table survey.job enable row level security;
alter table survey.job_participant enable row level security;
alter table survey.certificate_line enable row level security;
alter table survey.survey_line enable row level security;
alter table survey.checklist_entry enable row level security;
alter table survey.checklist_entry_particular enable row level security;
alter table survey.finding_line enable row level security;

create policy survey_request_item_staff_read on survey.survey_request_item
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (exists (
    select 1 from survey.survey_request sr
    where sr.id = survey.survey_request_item.survey_request_id
      and sr.office_unit_id = any (private.my_offices())
  ));

create policy survey_request_item_ext_read on survey.survey_request_item
  for select to ext_user
  using (exists (
    select 1 from survey.survey_request sr
    where sr.id = survey.survey_request_item.survey_request_id
      and sr.org_id = any (private.my_org_ids())
  ));

create policy job_staff_read on survey.job
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (office_unit_id = any (private.my_offices()));

create policy job_ext_read on survey.job
  for select to ext_user
  using (
    org_id = any (private.my_org_ids())
    or exists (
      select 1
      from fleet.ship_party sp
      where sp.ship_id = survey.job.ship_id
        and sp.org_id = any (private.my_org_ids())
        and sp.valid @> now()
    )
  );

create policy job_participant_staff_read on survey.job_participant
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (exists (
    select 1 from survey.job j
    where j.id = survey.job_participant.job_id
      and j.office_unit_id = any (private.my_offices())
  ));

create policy certificate_line_staff_read on survey.certificate_line
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (exists (
    select 1 from survey.job j
    where j.id = survey.certificate_line.job_id
      and j.office_unit_id = any (private.my_offices())
  ));

create policy survey_line_staff_read on survey.survey_line
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (exists (
    select 1 from survey.job j
    where j.id = survey.survey_line.job_id
      and j.office_unit_id = any (private.my_offices())
  ));

create policy checklist_entry_staff_read on survey.checklist_entry
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (exists (
    select 1 from survey.job j
    where j.id = survey.checklist_entry.job_id
      and j.office_unit_id = any (private.my_offices())
  ));

create policy checklist_entry_particular_staff_read on survey.checklist_entry_particular
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (exists (
    select 1
    from survey.checklist_entry ce
    join survey.job j on j.id = ce.job_id
    where ce.id = survey.checklist_entry_particular.checklist_entry_id
      and j.office_unit_id = any (private.my_offices())
  ));

create policy finding_line_staff_read on survey.finding_line
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (exists (
    select 1 from survey.job j
    where j.id = survey.finding_line.job_id
      and j.office_unit_id = any (private.my_offices())
  ));

create policy finding_line_ext_read on survey.finding_line
  for select to ext_user
  using (
    is_private is false
    and exists (
      select 1 from survey.job j
      where j.id = survey.finding_line.job_id
    )
  );

grant select on survey.survey_request_item to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant select on survey.job to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant select on survey.job_participant to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant select on survey.certificate_line to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant select on survey.survey_line to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant select on survey.checklist_entry to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant select on survey.checklist_entry_particular to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant select on survey.finding_line to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;
