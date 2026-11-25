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
