-- fleet: commercial vessels and legal/commercial affiliations.

create sequence fleet.class_number_seq
  as integer
  start with 1000
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
  category varchar(50),
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

alter table fleet.ship enable row level security;
alter table fleet.ship_party enable row level security;
alter table fleet.ship_breakdown enable row level security;
alter table fleet.ship_breakdown_node enable row level security;

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
