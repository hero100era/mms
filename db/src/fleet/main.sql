-- fleet: commercial vessels and legal/commercial affiliations.

create sequence fleet.class_number_seq
  as integer
  start with 10000
  increment by 1;

-- Sequence usage is owned by mms_owner / SECURITY DEFINER functions; do not expose to capability roles.
revoke all on sequence fleet.class_number_seq from public;

create table fleet.ship (
  id uuid not null default uuidv7(),
  class_number integer not null default nextval('fleet.class_number_seq'),
  imo_number text not null,
  name text not null,
  previous_names varchar(500),
  ship_type text not null default 'bulk_carrier',
  gross_tonnage int,
  build_year int,
  build_date date,
  commissioning_date date,
  keel_laid_date date,
  contract_date date,
  class_entry_date date,
  administration_types varchar(2) not null default 'C' references core.administration_type (code),
  classed_by varchar(20) references core.classification_society (code),
  port_of_registry varchar(50),
  date_of_registry date,
  registry_number varchar(20),
  call_sign varchar(10),
  official_number varchar(10),
  type_iacs varchar(2) not null default 'BC' references core.vessel_type_iacs (code),
  type_other varchar(50),
  type_mms varchar(2) references core.vessel_type_mms (code),
  class_status varchar(2) references core.class_status (code),
  ship_status varchar(2) references core.ship_status (code),
  gross_tons decimal(9, 2),
  national_tons decimal(9, 2),
  deadweight integer,
  flag_code varchar(3) not null default 'PA' references core.flag (code),
  mmsi_number varchar(10),
  main_class varchar(30),
  net_tons decimal(9, 2),
  light_ship decimal(9, 2),
  ballast_capacity decimal(9, 2),
  equipment_number integer,
  length decimal(9, 2),
  length_oa decimal(9, 2),
  length_bp decimal(9, 2),
  moulded_depth decimal(9, 2),
  moulded_breadth decimal(9, 2),
  moulded_draft decimal(9, 2),
  design_draft decimal(9, 2),
  dual_class varchar(20) references core.classification_society (code),
  signal_letter varchar(10),
  breakdown_template_id integer references core.breakdown_template (id) on delete set null,
  status text not null default 'in_service',
  responsible_mts_unit_id uuid,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  row_version int not null default 1,
  constraint ship_pk primary key (id),
  constraint ship_class_number_uk unique (class_number),
  constraint ship_imo_number_uk unique (imo_number),
  constraint ship_imo_number_ck check (imo_number ~ '^[0-9]{7}$'),
  constraint ship_gross_tonnage_ck check (gross_tonnage is null or gross_tonnage > 0),
  constraint ship_build_year_ck check (build_year is null or (build_year between 1900 and 2100)),
  constraint ship_status_ck check (status in ('in_service', 'laid_up', 'under_construction', 'decommissioned')),
  constraint ship_responsible_mts_fk foreign key (responsible_mts_unit_id) references core.org_unit (id)
);
create index ship_responsible_mts_ix on fleet.ship (responsible_mts_unit_id);
create index ship_breakdown_template_ix on fleet.ship (breakdown_template_id);

create table fleet.ship_party (
  id uuid not null default uuidv7(),
  ship_id uuid not null,
  org_id uuid not null,
  party_role text not null,
  valid tstzrange not null default tstzrange(now(), null),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  row_version int not null default 1,
  constraint ship_party_pk primary key (id),
  constraint ship_party_ship_fk foreign key (ship_id) references fleet.ship (id),
  constraint ship_party_org_fk foreign key (org_id) references party.organization (id),
  constraint ship_party_role_ck check (
    party_role in (
      'registered_owner',
      'bareboat_charterer',
      'doc_company',
      'ism_manager',
      'isps_operator',
      'commercial_operator',
      'builder',
      'agent',
      'mlc_owner'
    )
  ),
  constraint ship_party_ex exclude using gist (ship_id with =, org_id with =, party_role with =, valid with &&)
);
create index ship_party_ship_ix on fleet.ship_party (ship_id);
create index ship_party_org_ix on fleet.ship_party (org_id);

create table fleet.ship_breakdown (
  id integer generated always as identity primary key,
  ship_id uuid not null references fleet.ship (id) on delete cascade,
  template_id integer references core.breakdown_template (id) on delete set null,
  name varchar(200) not null,
  description text,
  revision integer not null default 1,
  is_active boolean not null default true,
  applied_at timestamptz,
  applied_by varchar(100),
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);
create index ship_breakdown_ship_ix on fleet.ship_breakdown (ship_id);
create index ship_breakdown_template_fk_ix on fleet.ship_breakdown (template_id);
create unique index ship_breakdown_active_uk on fleet.ship_breakdown (ship_id) where (is_active is true);

create table fleet.ship_breakdown_node (
  id integer generated always as identity primary key,
  ship_breakdown_id integer not null references fleet.ship_breakdown (id) on delete cascade,
  parent_node_id integer,
  template_node_id integer references core.breakdown_template_node (id) on delete set null,
  code varchar(50) not null,
  name varchar(200) not null,
  description text,
  category varchar(100),
  node_type varchar(50),
  level integer not null default 0,
  sort_order integer not null default 0,
  is_from_template boolean not null default true,
  is_modified boolean not null default false,
  is_active boolean not null default true,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  constraint uq_ship_node_code unique (ship_breakdown_id, code),
  constraint uq_ship_node_breakdown_id_id unique (ship_breakdown_id, id),
  constraint fk_ship_node_parent_same_breakdown
    foreign key (ship_breakdown_id, parent_node_id)
    references fleet.ship_breakdown_node (ship_breakdown_id, id) on delete cascade,
  constraint chk_no_self_parent_ship check (id != parent_node_id)
);
create index ship_breakdown_node_breakdown_ix on fleet.ship_breakdown_node (ship_breakdown_id);
create index ship_breakdown_node_parent_ix on fleet.ship_breakdown_node (parent_node_id);
create index ship_breakdown_node_template_ix on fleet.ship_breakdown_node (template_node_id);

create table fleet.ship_breakdown_node_particular (
  id integer generated always as identity primary key,
  ship_breakdown_node_id integer not null references fleet.ship_breakdown_node (id) on delete cascade,
  template_particular_id integer references core.breakdown_template_node_particular (id) on delete set null,
  attr_key varchar(100) not null,
  attr_title varchar(200) not null,
  attr_value text,
  selection_options jsonb,
  data_type core.data_type_enum not null default 'text',
  unit varchar(20),
  is_modified boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  constraint uq_snode_attr unique (ship_breakdown_node_id, attr_key)
);
create index ship_breakdown_node_part_node_ix on fleet.ship_breakdown_node_particular (ship_breakdown_node_id);
create index ship_breakdown_node_part_tmpl_ix on fleet.ship_breakdown_node_particular (template_particular_id);

create trigger ship_stamp
  before insert or update on fleet.ship
  for each row execute function private.stamp();

create trigger ship_audit_capture
  after insert or update or delete on fleet.ship
  for each row execute function private.audit_capture();

create trigger ship_party_stamp
  before insert or update on fleet.ship_party
  for each row execute function private.stamp();

create trigger ship_party_audit_capture
  after insert or update or delete on fleet.ship_party
  for each row execute function private.audit_capture();

create trigger ship_breakdown_audit_capture
  after insert or update or delete on fleet.ship_breakdown
  for each row execute function private.audit_capture();

create trigger ship_breakdown_node_audit_capture
  after insert or update or delete on fleet.ship_breakdown_node
  for each row execute function private.audit_capture();

create trigger ship_breakdown_node_particular_audit_capture
  after insert or update or delete on fleet.ship_breakdown_node_particular
  for each row execute function private.audit_capture();

alter table fleet.ship enable row level security;
alter table fleet.ship_party enable row level security;
alter table fleet.ship_breakdown enable row level security;
alter table fleet.ship_breakdown_node enable row level security;
alter table fleet.ship_breakdown_node_particular enable row level security;

create policy ship_staff_read on fleet.ship
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (true);

create policy ship_ext_read on fleet.ship
  for select to ext_user
  using (exists (
    select 1
    from fleet.ship_party sp
    where sp.ship_id = fleet.ship.id
      and sp.org_id = any (private.my_org_ids())
      and sp.valid @> now()
  ));

create policy ship_party_staff_read on fleet.ship_party
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (true);

create policy ship_party_ext_read on fleet.ship_party
  for select to ext_user
  using (org_id = any (private.my_org_ids()));

create policy ship_breakdown_staff_read on fleet.ship_breakdown
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (true);

create policy ship_breakdown_ext_read on fleet.ship_breakdown
  for select to ext_user
  using (exists (
    select 1
    from fleet.ship_party sp
    where sp.ship_id = fleet.ship_breakdown.ship_id
      and sp.org_id = any (private.my_org_ids())
      and sp.valid @> now()
  ));

create policy ship_breakdown_node_staff_read on fleet.ship_breakdown_node
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (true);

create policy ship_breakdown_node_ext_read on fleet.ship_breakdown_node
  for select to ext_user
  using (exists (
    select 1
    from fleet.ship_breakdown sb
    join fleet.ship_party sp on sp.ship_id = sb.ship_id
    where sb.id = fleet.ship_breakdown_node.ship_breakdown_id
      and sp.org_id = any (private.my_org_ids())
      and sp.valid @> now()
  ));

create policy ship_breakdown_node_particular_staff_read on fleet.ship_breakdown_node_particular
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (true);

create policy ship_breakdown_node_particular_ext_read on fleet.ship_breakdown_node_particular
  for select to ext_user
  using (exists (
    select 1
    from fleet.ship_breakdown_node sbn
    join fleet.ship_breakdown sb on sb.id = sbn.ship_breakdown_id
    join fleet.ship_party sp on sp.ship_id = sb.ship_id
    where sbn.id = fleet.ship_breakdown_node_particular.ship_breakdown_node_id
      and sp.org_id = any (private.my_org_ids())
      and sp.valid @> now()
  ));

grant select on fleet.ship to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant select on fleet.ship_party to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant select on fleet.ship_breakdown to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant select on fleet.ship_breakdown_node to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant select on fleet.ship_breakdown_node_particular to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

-- ---------------------------------------------------------------------------
-- Vessel register: class notations, certificates, survey schedule, findings
-- ---------------------------------------------------------------------------

create sequence fleet.certificate_no_seq
  as bigint
  start with 100000
  increment by 1;

revoke all on sequence fleet.certificate_no_seq from public;

create table fleet.ship_class_notation (
  id uuid not null default uuidv7(),
  ship_id uuid not null,
  notation_id integer not null,
  society_code varchar(20) not null,
  group_id integer not null,
  status core.notation_status_enum not null default 'pending',
  display_order integer not null default 0,
  assigned_date date not null,
  effective_date date,
  expiry_date date,
  suspended_date date,
  withdrawn_date date,
  reinstated_date date,
  parameter_values jsonb,
  resolved_notation varchar(200),
  last_survey_date date,
  next_survey_due date,
  survey_cycle_months integer,
  approved_by uuid,
  approval_reference varchar(200),
  remarks text,
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  row_version int not null default 1,
  constraint ship_class_notation_pk primary key (id),
  constraint ship_class_notation_ship_fk foreign key (ship_id) references fleet.ship (id) on delete cascade,
  constraint ship_class_notation_notation_fk foreign key (notation_id) references core.class_notation (id),
  constraint ship_class_notation_society_fk foreign key (society_code) references core.classification_society (code),
  constraint ship_class_notation_group_fk foreign key (group_id) references core.notation_group (id),
  constraint ship_class_notation_approved_by_fk foreign key (approved_by) references iam.app_user (id),
  constraint ship_class_notation_cycle_ck check (survey_cycle_months is null or survey_cycle_months > 0)
);
create index ship_class_notation_ship_ix on fleet.ship_class_notation (ship_id);
create index ship_class_notation_notation_ix on fleet.ship_class_notation (notation_id);
create unique index ship_class_notation_current_uk
  on fleet.ship_class_notation (ship_id, notation_id, society_code)
  where (is_current is true);

create table fleet.certificate (
  id uuid not null default uuidv7(),
  certificate_no bigint not null default nextval('fleet.certificate_no_seq'),
  version integer not null default 1,
  ship_id uuid,
  company_id uuid,
  certificate_template_code varchar(10),
  status varchar(2) not null,
  remark varchar(2) not null default '',
  issued_by varchar(20) not null,
  cert_code varchar(10) not null,
  validity_type varchar(2) not null,
  category varchar(3) not null,
  internal_category varchar(3) not null,
  description varchar(120),
  issue_date date not null,
  expiry_date date,
  extended_date date,
  mlc_declaration_date date,
  mlc_declaration_place varchar(50),
  doc_administration varchar(3),
  cert_document_id uuid,
  draft_document_id uuid,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  row_version int not null default 1,
  constraint certificate_pk primary key (id),
  constraint certificate_no_version_uk unique (certificate_no, version),
  constraint certificate_version_ck check (version >= 1),
  constraint certificate_target_ck check (ship_id is not null or company_id is not null),
  constraint certificate_ship_fk foreign key (ship_id) references fleet.ship (id) on delete set null,
  constraint certificate_company_fk foreign key (company_id) references party.organization (id) on delete set null,
  constraint certificate_template_fk foreign key (certificate_template_code) references core.certificate_template (code) on delete set null,
  constraint certificate_status_fk foreign key (status) references core.certificate_status (code),
  constraint certificate_issued_by_fk foreign key (issued_by) references core.classification_society (code),
  constraint certificate_cert_code_fk foreign key (cert_code) references core.certificate_survey_pool (code),
  constraint certificate_validity_type_fk foreign key (validity_type) references core.certificate_validity_type (code),
  constraint certificate_category_fk foreign key (category) references core.certificate_category (code),
  constraint certificate_internal_category_fk foreign key (internal_category) references core.certificate_internal_category (code),
  constraint certificate_cert_doc_fk foreign key (cert_document_id) references core.document (id) on delete set null,
  constraint certificate_draft_doc_fk foreign key (draft_document_id) references core.document (id) on delete set null,
  constraint certificate_doc_admin_fk foreign key (doc_administration) references core.flag (code)
);
create index certificate_ship_ix on fleet.certificate (ship_id);
create index certificate_company_ix on fleet.certificate (company_id);
create index certificate_cert_code_ix on fleet.certificate (cert_code);
create index certificate_doc_admin_ix on fleet.certificate (doc_administration);
create unique index certificate_active_no_uk on fleet.certificate (certificate_no) where (is_active is true);

create table fleet.survey_audit (
  id uuid not null default uuidv7(),
  ship_id uuid,
  company_id uuid,
  cert_code varchar(10),
  certificate_id uuid,
  pool_id integer,
  description varchar(120) not null,
  last_held_date date not null,
  place_held varchar(50) not null,
  next_due_date date,
  postponement_date date,
  survey_status core.survey_status_enum,
  range_from_date date,
  range_to_date date,
  fee decimal(9, 2),
  is_ordered boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  row_version int not null default 1,
  constraint survey_audit_pk primary key (id),
  constraint survey_audit_target_ck check (ship_id is not null or company_id is not null or certificate_id is not null),
  constraint survey_audit_range_ck check (range_from_date is null or range_to_date is null or range_to_date >= range_from_date),
  constraint survey_audit_ship_fk foreign key (ship_id) references fleet.ship (id) on delete cascade,
  constraint survey_audit_company_fk foreign key (company_id) references party.organization (id) on delete cascade,
  constraint survey_audit_cert_code_fk foreign key (cert_code) references core.certificate_survey_pool (code) on delete set null,
  constraint survey_audit_certificate_fk foreign key (certificate_id) references fleet.certificate (id) on delete cascade,
  constraint survey_audit_pool_fk foreign key (pool_id) references core.survey_pool (id) on delete set null
);
create index survey_audit_ship_ix on fleet.survey_audit (ship_id);
create index survey_audit_company_ix on fleet.survey_audit (company_id);
create index survey_audit_certificate_ix on fleet.survey_audit (certificate_id);
create index survey_audit_pool_ix on fleet.survey_audit (pool_id);
create index survey_audit_due_ix on fleet.survey_audit (next_due_date) where (is_active is true);

create table fleet.finding_comment (
  id uuid not null default uuidv7(),
  ship_id uuid,
  company_id uuid,
  comment_type varchar(2) not null,
  is_private boolean not null default false,
  date_issued date not null,
  place_issued varchar(50),
  due_date date,
  status varchar(1) not null,
  postponed_due_date date,
  mms_reference varchar(20),
  subject varchar(500) not null,
  body text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  row_version int not null default 1,
  constraint finding_comment_pk primary key (id),
  constraint finding_comment_target_ck check (ship_id is not null or company_id is not null),
  constraint finding_comment_ship_fk foreign key (ship_id) references fleet.ship (id) on delete cascade,
  constraint finding_comment_company_fk foreign key (company_id) references party.organization (id) on delete cascade,
  constraint finding_comment_type_fk foreign key (comment_type) references core.comment_type (code),
  constraint finding_comment_status_fk foreign key (status) references core.comment_status (code)
);
create index finding_comment_ship_ix on fleet.finding_comment (ship_id);
create index finding_comment_company_ix on fleet.finding_comment (company_id);
create index finding_comment_status_ix on fleet.finding_comment (status) where (is_active is true);

create table fleet.finding_comment_certificate (
  finding_comment_id uuid not null references fleet.finding_comment (id) on delete cascade,
  certificate_id uuid not null references fleet.certificate (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint finding_comment_certificate_pk primary key (finding_comment_id, certificate_id)
);
create index finding_comment_cert_cert_ix on fleet.finding_comment_certificate (certificate_id);

create table fleet.finding_comment_survey_audit (
  finding_comment_id uuid not null references fleet.finding_comment (id) on delete cascade,
  survey_audit_id uuid not null references fleet.survey_audit (id) on delete cascade,
  is_postponed boolean not null default false,
  created_at timestamptz not null default now(),
  constraint finding_comment_survey_audit_pk primary key (finding_comment_id, survey_audit_id, is_postponed)
);
create index finding_comment_sa_audit_ix on fleet.finding_comment_survey_audit (survey_audit_id);

create trigger ship_class_notation_stamp
  before insert or update on fleet.ship_class_notation
  for each row execute function private.stamp();

create trigger ship_class_notation_audit_capture
  after insert or update or delete on fleet.ship_class_notation
  for each row execute function private.audit_capture();

create trigger certificate_stamp
  before insert or update on fleet.certificate
  for each row execute function private.stamp();

create trigger certificate_audit_capture
  after insert or update or delete on fleet.certificate
  for each row execute function private.audit_capture();

create trigger survey_audit_stamp
  before insert or update on fleet.survey_audit
  for each row execute function private.stamp();

create trigger survey_audit_audit_capture
  after insert or update or delete on fleet.survey_audit
  for each row execute function private.audit_capture();

create trigger finding_comment_stamp
  before insert or update on fleet.finding_comment
  for each row execute function private.stamp();

create trigger finding_comment_audit_capture
  after insert or update or delete on fleet.finding_comment
  for each row execute function private.audit_capture();

create trigger finding_comment_certificate_audit_capture
  after insert or update or delete on fleet.finding_comment_certificate
  for each row execute function private.audit_capture();

create trigger finding_comment_survey_audit_audit_capture
  after insert or update or delete on fleet.finding_comment_survey_audit
  for each row execute function private.audit_capture();

alter table fleet.ship_class_notation enable row level security;
alter table fleet.certificate enable row level security;
alter table fleet.survey_audit enable row level security;
alter table fleet.finding_comment enable row level security;
alter table fleet.finding_comment_certificate enable row level security;
alter table fleet.finding_comment_survey_audit enable row level security;

create policy ship_class_notation_staff_read on fleet.ship_class_notation
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (true);

create policy ship_class_notation_ext_read on fleet.ship_class_notation
  for select to ext_user
  using (exists (
    select 1
    from fleet.ship_party sp
    where sp.ship_id = fleet.ship_class_notation.ship_id
      and sp.org_id = any (private.my_org_ids())
      and sp.valid @> now()
  ));

create policy certificate_staff_read on fleet.certificate
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (true);

create policy certificate_ext_read on fleet.certificate
  for select to ext_user
  using (
    company_id = any (private.my_org_ids())
    or exists (
      select 1
      from fleet.ship_party sp
      where sp.ship_id = fleet.certificate.ship_id
        and sp.org_id = any (private.my_org_ids())
        and sp.valid @> now()
    )
  );

create policy survey_audit_staff_read on fleet.survey_audit
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (true);

create policy survey_audit_ext_read on fleet.survey_audit
  for select to ext_user
  using (
    company_id = any (private.my_org_ids())
    or exists (
      select 1
      from fleet.ship_party sp
      where sp.ship_id = fleet.survey_audit.ship_id
        and sp.org_id = any (private.my_org_ids())
        and sp.valid @> now()
    )
  );

create policy finding_comment_staff_read on fleet.finding_comment
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (true);

create policy finding_comment_ext_read on fleet.finding_comment
  for select to ext_user
  using (
    is_private is false
    and (
      company_id = any (private.my_org_ids())
      or exists (
        select 1
        from fleet.ship_party sp
        where sp.ship_id = fleet.finding_comment.ship_id
          and sp.org_id = any (private.my_org_ids())
          and sp.valid @> now()
      )
    )
  );

create policy finding_comment_certificate_staff_read on fleet.finding_comment_certificate
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (true);

create policy finding_comment_certificate_ext_read on fleet.finding_comment_certificate
  for select to ext_user
  using (exists (
    select 1
    from fleet.finding_comment fc
    where fc.id = fleet.finding_comment_certificate.finding_comment_id
  ));

create policy finding_comment_survey_audit_staff_read on fleet.finding_comment_survey_audit
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (true);

create policy finding_comment_survey_audit_ext_read on fleet.finding_comment_survey_audit
  for select to ext_user
  using (exists (
    select 1
    from fleet.finding_comment fc
    where fc.id = fleet.finding_comment_survey_audit.finding_comment_id
  ));

grant select on fleet.ship_class_notation to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant select on fleet.certificate to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant select on fleet.survey_audit to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant select on fleet.finding_comment to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant select on fleet.finding_comment_certificate to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant select on fleet.finding_comment_survey_audit to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;
