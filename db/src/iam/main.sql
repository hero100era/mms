-- iam: identity, positions, assignments, sessions and reference data.
-- Tables are default-deny RLS. Capability roles read through api views and
-- write only through definer functions (I-02 onwards).

create table iam.db_role (
  role_name text not null,
  kind text not null,
  description text not null,
  constraint db_role_pk primary key (role_name),
  constraint db_role_kind_ck check (kind in ('anon', 'external', 'internal'))
);

create table iam.job_family (
  code text not null,
  label_en text not null,
  label_zh text,
  constraint job_family_pk primary key (code)
);

create table iam.job_grade (
  grade int not null,
  label_en text not null,
  constraint job_grade_pk primary key (grade),
  constraint job_grade_range_ck check (grade between 0 and 8)
);

create table iam.job_title (
  code text not null,
  label_en text not null,
  label_zh text,
  job_family text,
  grade int not null,
  active boolean not null default true,
  constraint job_title_pk primary key (code),
  constraint job_title_family_fk foreign key (job_family) references iam.job_family (code),
  constraint job_title_grade_fk foreign key (grade) references iam.job_grade (grade)
);

create table iam.default_role_rule (
  id uuid primary key default uuidv7(),
  unit_type text,
  unit_function text,
  job_family text,
  min_grade int not null,
  max_grade int not null,
  db_role text not null,
  scope_target text not null,
  constraint default_role_rule_unit_type_fk foreign key (unit_type) references core.org_unit_type (code),
  constraint default_role_rule_family_fk foreign key (job_family) references iam.job_family (code),
  constraint default_role_rule_role_fk foreign key (db_role) references iam.db_role (role_name),
  constraint default_role_rule_grade_ck check (min_grade <= max_grade),
  constraint default_role_rule_scope_ck check (scope_target in ('own_unit', 'parent_unit', 'global'))
);

create table iam.authority_rule (
  id uuid primary key default uuidv7(),
  action_code text not null,
  db_role text not null,
  job_family text,
  unit_type text,
  min_grade int not null,
  max_amount numeric(18, 2),
  currency char(3),
  requires_qualification boolean not null default false,
  valid tstzrange not null default tstzrange(now(), null),
  note text,
  constraint authority_rule_role_fk foreign key (db_role) references iam.db_role (role_name),
  constraint authority_rule_family_fk foreign key (job_family) references iam.job_family (code),
  constraint authority_rule_unit_type_fk foreign key (unit_type) references core.org_unit_type (code),
  constraint authority_rule_min_grade_ck check (min_grade >= 1),
  constraint authority_rule_amount_ck check ((max_amount is null) = (currency is null)),
  constraint authority_rule_sysadmin_ck check (
    not (db_role = 'int_sysadmin' and action_code in (
      'survey.request.triage',
      'survey.job.assign',
      'survey.report.release',
      'survey.report.countersign',
      'audit_trail.report.release',
      'billing.credit_note.approve',
      'hr.position.set',
      'qual.grant',
      'qual.revoke'
    ))
  )
);
create index authority_rule_action_ix on iam.authority_rule (action_code, db_role);

create table iam.app_user (
  id uuid primary key default uuidv7(),
  kind text not null,
  display_name text not null,
  email text,
  email_verified_at timestamptz,
  status text not null default 'invited',
  entra_tenant_id uuid,
  entra_object_id uuid,
  service_name text,
  preferred_locale text not null default 'en',
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  row_version int not null default 1,
  constraint app_user_kind_ck check (kind in ('internal', 'external', 'service')),
  constraint app_user_status_ck check (status in ('invited', 'active', 'suspended', 'deactivated')),
  constraint app_user_email_lower_ck check (email is null or email = lower(email)),
  constraint app_user_id_kind_uk unique (id, kind),
  constraint app_user_entra_uk unique (entra_tenant_id, entra_object_id),
  constraint app_user_service_uk unique (service_name),
  constraint app_user_kind_shape_ck check (
       (kind = 'internal' and entra_tenant_id is not null and entra_object_id is not null and service_name is null)
    or (kind = 'external' and entra_tenant_id is null and entra_object_id is null and service_name is null and email is not null)
    or (kind = 'service' and service_name is not null and entra_tenant_id is null and entra_object_id is null
                          and email is null and status in ('active', 'deactivated'))
  )
);
create unique index app_user_ext_email_uk on iam.app_user (email)
  where kind = 'external' and status <> 'deactivated';

create table iam.staff_position (
  id uuid primary key default uuidv7(),
  user_id uuid not null,
  user_kind text not null default 'internal',
  job_title_code text not null,
  job_family text not null,
  unit_id uuid not null,
  line_manager_id uuid,
  valid tstzrange not null,
  set_by uuid not null,
  reason text not null,
  constraint staff_position_user_kind_ck check (user_kind = 'internal'),
  constraint staff_position_user_fk foreign key (user_id, user_kind) references iam.app_user (id, kind),
  constraint staff_position_title_fk foreign key (job_title_code) references iam.job_title (code),
  constraint staff_position_family_fk foreign key (job_family) references iam.job_family (code),
  constraint staff_position_unit_fk foreign key (unit_id) references core.org_unit (id),
  constraint staff_position_line_manager_fk foreign key (line_manager_id) references iam.app_user (id),
  constraint staff_position_set_by_fk foreign key (set_by) references iam.app_user (id),
  constraint staff_position_set_by_ck check (set_by <> user_id),
  constraint staff_position_line_manager_ck check (line_manager_id is distinct from user_id),
  -- R2.5: all temporal ranges use the half-open [) convention explicitly.
  -- `empty` is allowed: deprovisioning closes a future-dated period that never
  -- started by setting it to 'empty', which has no bounds at all.
  -- The exclusion constraints above only prevent overlap; this prevents a
  -- caller from quietly switching to [] or () bounds and changing overlap
  -- semantics at a boundary instant.
  constraint staff_position_valid_bounds_ck check (
    isempty(valid) or (lower_inc(valid) and not upper_inc(valid))
  ),
  constraint staff_position_ex exclude using gist (user_id with =, valid with &&)
);
create index staff_position_line_manager_ix on iam.staff_position (line_manager_id);
create index staff_position_unit_ix on iam.staff_position (unit_id);

create table iam.role_assignment (
  id uuid primary key default uuidv7(),
  user_id uuid not null,
  user_kind text not null default 'internal',
  db_role text not null,
  scope_type text not null,
  scope_unit_id uuid,
  source text not null,
  position_id uuid,
  valid tstzrange not null default tstzrange(now(), null),
  granted_by uuid not null,
  grant_reason text not null,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text,
  constraint role_assignment_user_kind_ck check (user_kind = 'internal'),
  constraint role_assignment_user_fk foreign key (user_id, user_kind) references iam.app_user (id, kind),
  constraint role_assignment_role_fk foreign key (db_role) references iam.db_role (role_name),
  constraint role_assignment_unit_fk foreign key (scope_unit_id) references core.org_unit (id),
  constraint role_assignment_position_fk foreign key (position_id) references iam.staff_position (id),
  constraint role_assignment_granted_by_fk foreign key (granted_by) references iam.app_user (id),
  constraint role_assignment_revoked_by_fk foreign key (revoked_by) references iam.app_user (id),
  constraint role_assignment_scope_ck check ((scope_type = 'global') = (scope_unit_id is null)),
  constraint role_assignment_scope_type_ck check (scope_type in ('global', 'unit')),
  constraint role_assignment_source_ck check (source in ('position', 'manual', 'break_glass')),
  constraint role_assignment_source_position_ck check ((source = 'position') = (position_id is not null)),
  -- Invariant I7: nobody grants themselves a role. H-10 documents exactly one
  -- exception, the break-glass self-activation, and couples it to the exact shape
  -- that function creates, so no other path can write a self-grant.
  constraint role_assignment_granted_by_ck check (
    granted_by <> user_id
    or (source = 'break_glass' and db_role = 'int_sysadmin' and scope_type = 'global')
  ),
  -- R2.5: explicit [) range convention (empty ranges allowed, see staff_position).
  constraint role_assignment_valid_bounds_ck check (
    isempty(valid) or (lower_inc(valid) and not upper_inc(valid))
  ),
  constraint role_assignment_ex exclude using gist (
    user_id with =, db_role with =,
    (coalesce(scope_unit_id, '00000000-0000-0000-0000-000000000000'::uuid)) with =,
    valid with &&
  ) where (revoked_at is null)
);
create index role_assignment_active_ix on iam.role_assignment (user_id, db_role) where revoked_at is null;

create table iam.user_identity (
  id uuid primary key default uuidv7(),
  user_id uuid not null,
  user_kind text not null default 'external',
  provider text not null,
  issuer text not null,
  subject text not null,
  tenant_id uuid,
  object_id uuid,
  email_at_link text,
  linked_at timestamptz not null default now(),
  last_used_at timestamptz,
  unlinked_at timestamptz,
  constraint user_identity_user_kind_ck check (user_kind = 'external'),
  constraint user_identity_user_fk foreign key (user_id, user_kind) references iam.app_user (id, kind),
  constraint user_identity_provider_ck check (provider in ('microsoft', 'google')),
  constraint user_identity_email_lower_ck check (email_at_link is null or email_at_link = lower(email_at_link))
);
create unique index user_identity_active_uk on iam.user_identity (issuer, subject)
  where unlinked_at is null;

create table iam.password_credential (
  user_id uuid not null,
  user_kind text not null default 'external',
  hash text not null,
  set_at timestamptz not null default now(),
  must_change boolean not null default false,
  constraint password_credential_pk primary key (user_id),
  constraint password_credential_user_kind_ck check (user_kind = 'external'),
  constraint password_credential_user_fk foreign key (user_id, user_kind) references iam.app_user (id, kind)
);

-- Second factor for external password users (H-09, Q2 = yes). The shared secret is
-- stored in `secret` and never leaves the database: `auth.totp_verify` is the only
-- reader. `last_step` is the 30 s counter already accepted, which makes replay of a
-- captured code a no-op rather than a second acceptance.
create table iam.totp_credential (
  user_id uuid not null,
  user_kind text not null default 'external',
  secret bytea not null,
  digits integer not null default 6,
  period integer not null default 30,
  algorithm text not null default 'sha1',
  enrolled_at timestamptz not null default now(),
  confirmed_at timestamptz,
  last_step bigint,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  constraint totp_credential_pk primary key (user_id),
  constraint totp_credential_user_kind_ck check (user_kind = 'external'),
  constraint totp_credential_digits_ck check (digits between 6 and 8),
  constraint totp_credential_period_ck check (period between 15 and 120),
  constraint totp_credential_algorithm_ck check (algorithm in ('sha1', 'sha256', 'sha512')),
  constraint totp_credential_secret_ck check (octet_length(secret) >= 10),
  constraint totp_credential_user_fk foreign key (user_id, user_kind) references iam.app_user (id, kind)
);

create table iam.one_time_token (
  id uuid primary key default uuidv7(),
  user_id uuid not null,
  purpose text not null,
  token_hash bytea not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid,
  constraint one_time_token_user_fk foreign key (user_id) references iam.app_user (id),
  constraint one_time_token_created_by_fk foreign key (created_by) references iam.app_user (id),
  constraint one_time_token_purpose_ck check (purpose in ('invite', 'password_reset')),
  constraint one_time_token_hash_uk unique (token_hash)
);

create table iam.session (
  id uuid primary key default uuidv7(),
  user_id uuid not null,
  user_kind text not null,
  active_role text not null,
  auth_method text not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  idle_expires_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoke_reason text,
  client_ip inet,
  user_agent text,
  constraint session_user_kind_ck check (user_kind in ('internal', 'external')),
  constraint session_user_fk foreign key (user_id, user_kind) references iam.app_user (id, kind),
  constraint session_role_fk foreign key (active_role) references iam.db_role (role_name),
  constraint session_auth_method_ck check (auth_method in ('entra', 'microsoft', 'google', 'pwd')),
  constraint session_external_role_ck check ((user_kind = 'external') = (active_role = 'ext_user'))
);
create index session_user_active_ix on iam.session (user_id) where revoked_at is null;

-- H-10: break-glass accounts. An emergency identity is an ordinary internal app user
-- listed here; this row is the only place break-glass authority can come from.
-- The account holds no `iam.staff_position` and no live `iam.role_assignment` while it
-- is dormant, which is why dormancy needs no check anywhere: a dormant account simply
-- cannot pass `private.pre_request`.
create table iam.break_glass_account (
  user_id uuid primary key,
  label text not null,
  enabled boolean not null default true,
  activated_at timestamptz,
  valid_until timestamptz,
  reason text,
  last_drill_at timestamptz,
  constraint break_glass_account_user_fk foreign key (user_id) references iam.app_user (id),
  constraint break_glass_account_label_ck check (btrim(label) <> ''),
  constraint break_glass_account_window_ck check (
    (activated_at is null and valid_until is null and reason is null)
    or (activated_at is not null and valid_until is not null
        and reason is not null and btrim(reason) <> '')
  ),
  constraint break_glass_account_window_order_ck check (
    valid_until is null or valid_until > activated_at
  ),
  constraint break_glass_account_cap_ck check (
    valid_until is null or valid_until <= activated_at + interval '4 hours'
  )
);

-- R1.6: the explicit matrix of operations a break-glass session may NEVER
-- perform. ADR-0020 already bars emergency accounts from staff positions; this
-- table makes the prohibition enumerable and gives future regulated RPCs a
-- single place to register their action codes. See ADR-0022.
create table iam.break_glass_forbidden_action (
  action_code text primary key,
  description text not null,
  constraint break_glass_forbidden_action_code_ck check (btrim(action_code) <> ''),
  constraint break_glass_forbidden_action_description_ck check (btrim(description) <> '')
);
alter table iam.break_glass_forbidden_action enable row level security;

create table iam.org_membership (
  id uuid primary key default uuidv7(),
  user_id uuid not null,
  user_kind text not null default 'external',
  org_id uuid not null,
  member_role text not null,
  valid tstzrange not null default tstzrange(now(), null),
  granted_by uuid not null,
  revoked_at timestamptz,
  revoked_by uuid,
  constraint org_membership_user_kind_ck check (user_kind = 'external'),
  constraint org_membership_user_fk foreign key (user_id, user_kind) references iam.app_user (id, kind),
  constraint org_membership_org_fk foreign key (org_id) references party.organization (id),
  constraint org_membership_granted_by_fk foreign key (granted_by) references iam.app_user (id),
  constraint org_membership_revoked_by_fk foreign key (revoked_by) references iam.app_user (id),
  constraint org_membership_role_ck check (member_role in ('org_admin', 'requester', 'viewer')),
  -- R2.5: explicit [) range convention (empty ranges allowed, see staff_position).
  constraint org_membership_valid_bounds_ck check (
    isempty(valid) or (lower_inc(valid) and not upper_inc(valid))
  ),
  constraint org_membership_ex exclude using gist (user_id with =, org_id with =, valid with &&)
    where (revoked_at is null)
);

create table iam.login_attempt (
  id bigint generated always as identity,
  at timestamptz not null default now(),
  login_name text,
  client_ip inet,
  outcome text not null,
  reason text,
  constraint login_attempt_pk primary key (id),
  constraint login_attempt_name_lower_ck check (login_name is null or login_name = lower(login_name))
);

-- R2-H01: Multi-replica pre-authentication session store (CSRF tokens and OAuth
-- PKCE/state/nonce transactions before login promotes the session into iam.session).
create table iam.pre_auth_session (
  id text primary key,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  constraint pre_auth_session_id_ck check (btrim(id) <> '')
);
create index pre_auth_session_expires_ix on iam.pre_auth_session (expires_at);

-- R2-H01: Multi-replica step-up authentication throttle store (isolated from
-- iam.login_attempt so step-up failures never lock out primary sign-in).
create table iam.step_up_attempt (
  id bigint generated always as identity,
  at timestamptz not null default now(),
  user_id text not null,
  client_ip text not null,
  session_id text,
  outcome text not null,
  constraint step_up_attempt_pk primary key (id),
  constraint step_up_attempt_outcome_ck check (outcome in ('success', 'failure'))
);
create index step_up_attempt_user_at_ix on iam.step_up_attempt (user_id, at);
create index step_up_attempt_at_ix on iam.step_up_attempt (at);

alter table iam.db_role enable row level security;
alter table iam.job_family enable row level security;
alter table iam.job_grade enable row level security;
alter table iam.job_title enable row level security;
alter table iam.default_role_rule enable row level security;
alter table iam.authority_rule enable row level security;
alter table iam.app_user enable row level security;
alter table iam.staff_position enable row level security;
alter table iam.role_assignment enable row level security;
alter table iam.user_identity enable row level security;
alter table iam.password_credential enable row level security;
alter table iam.totp_credential enable row level security;
alter table iam.one_time_token enable row level security;
alter table iam.session enable row level security;
alter table iam.org_membership enable row level security;
alter table iam.login_attempt enable row level security;
alter table iam.pre_auth_session enable row level security;
alter table iam.step_up_attempt enable row level security;
alter table iam.break_glass_account enable row level security;

create trigger app_user_stamp
before insert or update on iam.app_user
for each row execute function private.stamp();

create trigger app_user_revoke_sessions
after update of status on iam.app_user
for each row execute function private.app_user_revoke_sessions();

create trigger role_assignment_sod
before insert or update on iam.role_assignment
for each row execute function private.role_assignment_sod();

create trigger app_user_audit_capture
after insert or update or delete on iam.app_user
for each row execute function private.audit_capture();

create trigger staff_position_audit_capture
after insert or update or delete on iam.staff_position
for each row execute function private.audit_capture();

create trigger role_assignment_audit_capture
after insert or update or delete on iam.role_assignment
for each row execute function private.audit_capture();

create trigger org_membership_audit_capture
after insert or update or delete on iam.org_membership
for each row execute function private.audit_capture();

create trigger user_identity_audit_capture
after insert or update or delete on iam.user_identity
for each row execute function private.audit_capture();

create trigger password_credential_audit_capture
after insert or update or delete on iam.password_credential
for each row execute function private.audit_capture();

create trigger totp_credential_audit_capture
after insert or update or delete on iam.totp_credential
for each row execute function private.audit_capture();

create trigger one_time_token_audit_capture
after insert or update or delete on iam.one_time_token
for each row execute function private.audit_capture();

create trigger break_glass_account_audit_capture
after insert or update or delete on iam.break_glass_account
for each row execute function private.audit_capture();


-- I-06 & I-10: HR/sysadmin read access and internal directory read policies.
create policy app_user_admin_read on iam.app_user
  for select to int_hr, int_sysadmin using (true);

create policy app_user_internal_read on iam.app_user
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_finance
  using (kind = 'internal' and status in ('active', 'invited'));

grant select on iam.app_user to int_hr, int_sysadmin;
grant select (id, display_name, email, kind, status) on iam.app_user to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_finance;

create policy job_title_read on iam.job_title
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_hr, int_finance, int_sysadmin
  using (true);

grant select (code, label_en, label_zh, job_family, active) on iam.job_title to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_finance, int_sysadmin;
grant select on iam.job_title to int_hr;

create policy staff_position_admin_read on iam.staff_position
  for select to int_hr using (true);

create policy staff_position_staff_read on iam.staff_position
  for select to int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
                int_compliance, int_finance, int_sysadmin
  using (valid @> now());

grant select on iam.staff_position to int_hr;
grant select (id, user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason) on iam.staff_position to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_finance, int_sysadmin;

create policy org_membership_ext_read on iam.org_membership
  for select to ext_user
  using (user_id = private.uid() and revoked_at is null and valid @> now());

create policy org_membership_staff_read on iam.org_membership
  for select to int_coordinator, int_sysadmin, int_compliance, int_manager
  using (true);

grant select on iam.org_membership to
  ext_user, int_coordinator, int_sysadmin, int_compliance, int_manager;


-- H-10: the break-glass registry is readable by HO Compliance (who reviews every
-- activation) and by system administrators (who maintain it). It is deliberately not
-- granted to the break-glass account itself: a dormant account must not be able to
-- look its own window up, and an active one acts as int_sysadmin, whose authority here
-- comes from the assignment rather than from a row it can rewrite.
create policy break_glass_account_compliance_read on iam.break_glass_account
  for select to int_compliance, int_sysadmin using (true);

grant select on iam.break_glass_account to int_compliance, int_sysadmin;


-- H-13: positions proposed from an external attribute source (Entra today) are staged
-- here and confirmed by HR. A proposal is not a position: it grants nothing, and the
-- position is created by the ordinary `api.staff_position_set` path so the authority,
-- scope and audit checks are the same whether HR typed it or accepted a proposal.
-- `job_title_code` and `unit_id` are nullable because the directory attribute usually
-- does not map exactly onto an internal code; HR fills them in when confirming.
create table iam.position_proposal (
  id uuid primary key default uuidv7(),
  user_id uuid not null,
  user_kind text not null default 'internal',
  job_title_code text,
  unit_id uuid,
  entra_job_title text,
  entra_department text,
  entra_office text,
  source text not null default 'entra',
  source_payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  proposed_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid,
  decision_reason text,
  staff_position_id uuid,
  proposed_by uuid,
  constraint position_proposal_user_kind_ck check (user_kind = 'internal'),
  constraint position_proposal_user_fk foreign key (user_id, user_kind) references iam.app_user (id, kind),
  constraint position_proposal_proposed_by_fk foreign key (proposed_by) references iam.app_user (id),
  constraint position_proposal_title_fk foreign key (job_title_code) references iam.job_title (code),
  constraint position_proposal_unit_fk foreign key (unit_id) references core.org_unit (id),
  constraint position_proposal_source_ck check (source in ('entra', 'hr')),
  constraint position_proposal_status_ck check (status in ('pending', 'confirmed', 'rejected')),
  constraint position_proposal_decision_ck check (
    (status = 'pending') = (decided_at is null)
    and (status <> 'rejected' or staff_position_id is null)
  ),
  constraint position_proposal_decided_by_fk foreign key (decided_by) references iam.app_user (id),
  constraint position_proposal_position_fk foreign key (staff_position_id) references iam.staff_position (id)
);

alter table iam.position_proposal enable row level security;

create unique index position_proposal_pending_ix
  on iam.position_proposal (user_id) where status = 'pending';
create index position_proposal_status_ix on iam.position_proposal (status, proposed_at);

create policy position_proposal_hr_read on iam.position_proposal
  for select to int_hr, int_sysadmin using (true);

grant select on iam.position_proposal to int_hr, int_sysadmin;

create trigger position_proposal_audit_capture
after insert or update or delete on iam.position_proposal
for each row execute function private.audit_capture();
