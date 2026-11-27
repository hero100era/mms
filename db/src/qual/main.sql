-- qual: staff competence, certification and regulated sign-off qualification.
-- Card H-14: assert_authority enforces requires_qualification per §7.2 / §7.6.

create table qual.qualification (
  code text not null,
  name text not null,
  job_family text,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  row_version int not null default 1,
  constraint qualification_created_by_fk foreign key (created_by) references iam.app_user (id),
  constraint qualification_updated_by_fk foreign key (updated_by) references iam.app_user (id),
  constraint qualification_pk primary key (code),
  constraint qualification_job_family_fk foreign key (job_family) references iam.job_family (code)
);
create index qualification_family_ix on qual.qualification (job_family);

create table qual.qualification_action (
  qualification_code text not null,
  action_code text not null,
  constraint qualification_action_pk primary key (qualification_code, action_code),
  constraint qualification_action_code_fk foreign key (qualification_code) references qual.qualification (code) on delete cascade
);
create index qualification_action_action_ix on qual.qualification_action (action_code);

create table qual.staff_qualification (
  id uuid not null default uuidv7(),
  user_id uuid not null,
  qualification_code text not null,
  valid tstzrange not null default tstzrange(now(), null),
  granted_by uuid not null,
  grant_reason text not null,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  row_version int not null default 1,
  constraint staff_qualification_pk primary key (id),
  constraint staff_qualification_user_fk foreign key (user_id) references iam.app_user (id),
  constraint staff_qualification_code_fk foreign key (qualification_code) references qual.qualification (code),
  constraint staff_qualification_granted_by_fk foreign key (granted_by) references iam.app_user (id),
  constraint staff_qualification_revoked_by_fk foreign key (revoked_by) references iam.app_user (id),
  constraint staff_qualification_granted_by_ck check (granted_by <> user_id),
  constraint staff_qualification_grant_reason_ck check (length(trim(grant_reason)) >= 3),
  constraint staff_qualification_revocation_ck check (
    (revoked_at is null) = (revoked_by is null)
    and (revoked_at is null) = (revoke_reason is null)
  ),
  constraint staff_qualification_ex exclude using gist (user_id with =, qualification_code with =, valid with &&)
);
create index staff_qualification_user_ix on qual.staff_qualification (user_id);
create index staff_qualification_code_ix on qual.staff_qualification (qualification_code);

create trigger qualification_stamp
  before insert or update on qual.qualification
  for each row execute function private.stamp();

create trigger staff_qualification_stamp
  before insert or update on qual.staff_qualification
  for each row execute function private.stamp();

create trigger staff_qualification_audit_capture
  after insert or update or delete on qual.staff_qualification
  for each row execute function private.audit_capture();

alter table qual.qualification enable row level security;
alter table qual.qualification_action enable row level security;
alter table qual.staff_qualification enable row level security;

create policy qualification_read on qual.qualification
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (true);

create policy qualification_action_read on qual.qualification_action
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (true);

create policy staff_qualification_self_read on qual.staff_qualification
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (user_id = private.uid());

create policy staff_qualification_report_read on qual.staff_qualification
  for select to int_manager
  using (user_id in (select private.my_reports()));

create policy staff_qualification_admin_read on qual.staff_qualification
  for select to int_hr, int_compliance, int_sysadmin
  using (true);

grant usage on schema qual to
  authenticator, web_anon, ext_user, int_viewer, int_surveyor, int_auditor,
  int_coordinator, int_manager, int_compliance, int_hr, int_finance, int_sysadmin;

grant select on qual.qualification to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant select on qual.qualification_action to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant select on qual.staff_qualification to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;
