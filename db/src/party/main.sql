-- party: organisations that are not internal org units.

create table party.organization (
  id uuid primary key default uuidv7(),
  name text not null,
  org_type text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  row_version int not null default 1,
  constraint organization_org_type_ck check (org_type in ('company', 'other')),
  constraint organization_status_ck check (status in ('active', 'inactive'))
);

create trigger organization_stamp
before insert or update on party.organization
for each row execute function private.stamp();

create trigger organization_audit_capture
after insert or update or delete on party.organization
for each row execute function private.audit_capture();


alter table party.organization enable row level security;

create policy organization_ext_read on party.organization
  for select to ext_user
  using (id = any (private.my_org_ids()));

create policy organization_staff_read on party.organization
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (true);

grant select on party.organization to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

