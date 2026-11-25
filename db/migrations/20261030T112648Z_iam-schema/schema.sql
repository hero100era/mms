-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION active_role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  select private.claim('role');
$$;

CREATE OR REPLACE FUNCTION uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  select nullif(private.claim('sub'), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION my_org_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select coalesce(array_agg(m.org_id), '{}')
  from iam.org_membership m
  where m.user_id = private.uid()
    and m.revoked_at is null
    and m.valid @> now();
$$;

CREATE OR REPLACE FUNCTION my_position()
RETURNS TABLE(job_title_code text, job_family text, grade integer, unit_id uuid, unit_type text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select p.job_title_code, p.job_family, t.grade, p.unit_id, u.unit_type
  from iam.staff_position p
  join iam.job_title t on t.code = p.job_title_code
  join core.org_unit u on u.id = p.unit_id
  where p.user_id = private.uid()
    and p.valid @> now();
$$;

CREATE OR REPLACE FUNCTION my_reports()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  with recursive r(user_id) as (
    select p.user_id
      from iam.staff_position p
     where p.line_manager_id = private.uid()
       and p.valid @> now()
    union
    select p.user_id
      from iam.staff_position p
      join r on p.line_manager_id = r.user_id
     where p.valid @> now()
  )
  select user_id from r;
$$;

CREATE OR REPLACE FUNCTION my_scope()
RETURNS TABLE(is_global boolean, unit_ids uuid[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select coalesce(bool_or(a.scope_type = 'global'), false),
         coalesce(array_agg(a.scope_unit_id) filter (where a.scope_type = 'unit'), '{}')
  from iam.role_assignment a
  where a.user_id = private.uid()
    and a.db_role = private.active_role()
    and a.revoked_at is null
    and a.valid @> now();
$$;

CREATE OR REPLACE FUNCTION my_offices()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  with s as (select * from private.my_scope()),
  roots as (
    select unnest(s.unit_ids) as id from s
    union
    select c.covered_unit_id
      from s
      join core.org_unit_coverage c on c.unit_id = any (s.unit_ids)
     where c.valid @> now()
  )
  select case when (select is_global from s) then
           (select coalesce(array_agg(id), '{}') from core.org_unit where unit_type = 'station' and active)
         else
           (select coalesce(array_agg(distinct d.id), '{}')
              from core.org_unit_descendants(array(select id from roots)) d
             where d.unit_type = 'station')
         end;
$$;

CREATE OR REPLACE FUNCTION my_units()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select case when s.is_global then
           (select coalesce(array_agg(u.id), '{}') from core.org_unit u where u.active)
         else
           (select coalesce(array_agg(distinct d.id), '{}') from core.org_unit_descendants(s.unit_ids) d)
         end
  from private.my_scope() s;
$$;

CREATE OR REPLACE FUNCTION stamp()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if tg_op = 'INSERT' then
    new.created_at := coalesce(new.created_at, now());
    new.created_by := coalesce(new.created_by, private.uid());
    new.updated_at := now();
    new.updated_by := coalesce(new.updated_by, private.uid());
    new.row_version := 1;
  elsif tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.updated_at := now();
    new.updated_by := coalesce(private.uid(), old.updated_by);
    new.row_version := old.row_version + 1;
  end if;
  return new;
end;
$$;

REVOKE EXECUTE ON FUNCTION active_role() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION my_offices() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION my_org_ids() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION my_position() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION my_reports() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION my_scope() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION my_units() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION stamp() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION uid() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION active_role() TO ext_user;

GRANT EXECUTE ON FUNCTION active_role() TO int_auditor;

GRANT EXECUTE ON FUNCTION active_role() TO int_compliance;

GRANT EXECUTE ON FUNCTION active_role() TO int_coordinator;

GRANT EXECUTE ON FUNCTION active_role() TO int_finance;

GRANT EXECUTE ON FUNCTION active_role() TO int_hr;

GRANT EXECUTE ON FUNCTION active_role() TO int_manager;

GRANT EXECUTE ON FUNCTION active_role() TO int_surveyor;

GRANT EXECUTE ON FUNCTION active_role() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION active_role() TO int_viewer;

GRANT EXECUTE ON FUNCTION active_role() TO web_anon;

GRANT EXECUTE ON FUNCTION claim(p_claim text) TO ext_user;

GRANT EXECUTE ON FUNCTION claim(p_claim text) TO int_auditor;

GRANT EXECUTE ON FUNCTION claim(p_claim text) TO int_coordinator;

GRANT EXECUTE ON FUNCTION claim(p_claim text) TO int_finance;

GRANT EXECUTE ON FUNCTION claim(p_claim text) TO int_hr;

GRANT EXECUTE ON FUNCTION claim(p_claim text) TO int_surveyor;

GRANT EXECUTE ON FUNCTION claim(p_claim text) TO int_viewer;

GRANT EXECUTE ON FUNCTION claim(p_claim text) TO web_anon;

GRANT EXECUTE ON FUNCTION claims() TO ext_user;

GRANT EXECUTE ON FUNCTION claims() TO int_auditor;

GRANT EXECUTE ON FUNCTION claims() TO int_coordinator;

GRANT EXECUTE ON FUNCTION claims() TO int_finance;

GRANT EXECUTE ON FUNCTION claims() TO int_hr;

GRANT EXECUTE ON FUNCTION claims() TO int_surveyor;

GRANT EXECUTE ON FUNCTION claims() TO int_viewer;

GRANT EXECUTE ON FUNCTION claims() TO web_anon;

GRANT EXECUTE ON FUNCTION my_offices() TO ext_user;

GRANT EXECUTE ON FUNCTION my_offices() TO int_auditor;

GRANT EXECUTE ON FUNCTION my_offices() TO int_compliance;

GRANT EXECUTE ON FUNCTION my_offices() TO int_coordinator;

GRANT EXECUTE ON FUNCTION my_offices() TO int_finance;

GRANT EXECUTE ON FUNCTION my_offices() TO int_hr;

GRANT EXECUTE ON FUNCTION my_offices() TO int_manager;

GRANT EXECUTE ON FUNCTION my_offices() TO int_surveyor;

GRANT EXECUTE ON FUNCTION my_offices() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION my_offices() TO int_viewer;

GRANT EXECUTE ON FUNCTION my_org_ids() TO ext_user;

GRANT EXECUTE ON FUNCTION my_org_ids() TO int_auditor;

GRANT EXECUTE ON FUNCTION my_org_ids() TO int_compliance;

GRANT EXECUTE ON FUNCTION my_org_ids() TO int_coordinator;

GRANT EXECUTE ON FUNCTION my_org_ids() TO int_finance;

GRANT EXECUTE ON FUNCTION my_org_ids() TO int_hr;

GRANT EXECUTE ON FUNCTION my_org_ids() TO int_manager;

GRANT EXECUTE ON FUNCTION my_org_ids() TO int_surveyor;

GRANT EXECUTE ON FUNCTION my_org_ids() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION my_org_ids() TO int_viewer;

GRANT EXECUTE ON FUNCTION my_position() TO int_auditor;

GRANT EXECUTE ON FUNCTION my_position() TO int_compliance;

GRANT EXECUTE ON FUNCTION my_position() TO int_coordinator;

GRANT EXECUTE ON FUNCTION my_position() TO int_finance;

GRANT EXECUTE ON FUNCTION my_position() TO int_hr;

GRANT EXECUTE ON FUNCTION my_position() TO int_manager;

GRANT EXECUTE ON FUNCTION my_position() TO int_surveyor;

GRANT EXECUTE ON FUNCTION my_position() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION my_position() TO int_viewer;

GRANT EXECUTE ON FUNCTION my_reports() TO int_compliance;

GRANT EXECUTE ON FUNCTION my_reports() TO int_hr;

GRANT EXECUTE ON FUNCTION my_reports() TO int_manager;

GRANT EXECUTE ON FUNCTION my_reports() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION my_scope() TO ext_user;

GRANT EXECUTE ON FUNCTION my_scope() TO int_auditor;

GRANT EXECUTE ON FUNCTION my_scope() TO int_compliance;

GRANT EXECUTE ON FUNCTION my_scope() TO int_coordinator;

GRANT EXECUTE ON FUNCTION my_scope() TO int_finance;

GRANT EXECUTE ON FUNCTION my_scope() TO int_hr;

GRANT EXECUTE ON FUNCTION my_scope() TO int_manager;

GRANT EXECUTE ON FUNCTION my_scope() TO int_surveyor;

GRANT EXECUTE ON FUNCTION my_scope() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION my_scope() TO int_viewer;

GRANT EXECUTE ON FUNCTION my_units() TO ext_user;

GRANT EXECUTE ON FUNCTION my_units() TO int_auditor;

GRANT EXECUTE ON FUNCTION my_units() TO int_compliance;

GRANT EXECUTE ON FUNCTION my_units() TO int_coordinator;

GRANT EXECUTE ON FUNCTION my_units() TO int_finance;

GRANT EXECUTE ON FUNCTION my_units() TO int_hr;

GRANT EXECUTE ON FUNCTION my_units() TO int_manager;

GRANT EXECUTE ON FUNCTION my_units() TO int_surveyor;

GRANT EXECUTE ON FUNCTION my_units() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION my_units() TO int_viewer;

GRANT EXECUTE ON FUNCTION uid() TO ext_user;

GRANT EXECUTE ON FUNCTION uid() TO int_auditor;

GRANT EXECUTE ON FUNCTION uid() TO int_compliance;

GRANT EXECUTE ON FUNCTION uid() TO int_coordinator;

GRANT EXECUTE ON FUNCTION uid() TO int_finance;

GRANT EXECUTE ON FUNCTION uid() TO int_hr;

GRANT EXECUTE ON FUNCTION uid() TO int_manager;

GRANT EXECUTE ON FUNCTION uid() TO int_surveyor;

GRANT EXECUTE ON FUNCTION uid() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION uid() TO int_viewer;

GRANT EXECUTE ON FUNCTION uid() TO web_anon;

-- ===== schema: core  (pgschema 1.13.4) =====

set local search_path = core;

CREATE TABLE IF NOT EXISTS outbox (
    id uuid DEFAULT uuidv7(),
    kind text NOT NULL,
    payload jsonb DEFAULT '{}' NOT NULL,
    status text DEFAULT 'pending' NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_at timestamptz DEFAULT now() NOT NULL,
    enqueued_by uuid,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT outbox_pkey PRIMARY KEY (id),
    CONSTRAINT outbox_attempts_ck CHECK (attempts >= 0),
    CONSTRAINT outbox_status_ck CHECK (status IN ('pending'::text, 'processing'::text, 'done'::text, 'failed'::text))
);

CREATE INDEX IF NOT EXISTS outbox_pending_ix ON outbox (next_at) WHERE (status = 'pending'::text);

-- ===== schema: party  (pgschema 1.13.4) =====

set local search_path = party;

CREATE TABLE IF NOT EXISTS organization (
    id uuid DEFAULT uuidv7(),
    name text NOT NULL,
    org_type text NOT NULL,
    status text DEFAULT 'active' NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamptz DEFAULT now() NOT NULL,
    updated_by uuid,
    row_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT organization_pkey PRIMARY KEY (id),
    CONSTRAINT organization_org_type_ck CHECK (org_type IN ('company'::text, 'other'::text)),
    CONSTRAINT organization_status_ck CHECK (status IN ('active'::text, 'inactive'::text))
);

CREATE OR REPLACE TRIGGER organization_stamp
    BEFORE INSERT OR UPDATE ON organization
    FOR EACH ROW
    EXECUTE FUNCTION private.stamp();

-- ===== schema: iam  (pgschema 1.13.4) =====

set local search_path = iam;

CREATE TABLE IF NOT EXISTS app_user (
    id uuid DEFAULT uuidv7(),
    kind text NOT NULL,
    display_name text NOT NULL,
    email text,
    email_verified_at timestamptz,
    status text DEFAULT 'invited' NOT NULL,
    entra_tenant_id uuid,
    entra_object_id uuid,
    service_name text,
    preferred_locale text DEFAULT 'en' NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamptz DEFAULT now() NOT NULL,
    updated_by uuid,
    row_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT app_user_pkey PRIMARY KEY (id),
    CONSTRAINT app_user_entra_uk UNIQUE (entra_tenant_id, entra_object_id),
    CONSTRAINT app_user_id_kind_uk UNIQUE (id, kind),
    CONSTRAINT app_user_service_uk UNIQUE (service_name),
    CONSTRAINT app_user_email_lower_ck CHECK (email IS NULL OR email = lower(email)),
    CONSTRAINT app_user_kind_ck CHECK (kind IN ('internal'::text, 'external'::text, 'service'::text)),
    CONSTRAINT app_user_kind_shape_ck CHECK (kind = 'internal'::text AND entra_tenant_id IS NOT NULL AND entra_object_id IS NOT NULL AND service_name IS NULL OR kind = 'external'::text AND entra_tenant_id IS NULL AND entra_object_id IS NULL AND service_name IS NULL AND email IS NOT NULL OR kind = 'service'::text AND service_name IS NOT NULL AND entra_tenant_id IS NULL AND entra_object_id IS NULL AND email IS NULL AND (status IN ('active'::text, 'deactivated'::text))),
    CONSTRAINT app_user_status_ck CHECK (status IN ('invited'::text, 'active'::text, 'suspended'::text, 'deactivated'::text))
);

CREATE UNIQUE INDEX IF NOT EXISTS app_user_ext_email_uk ON app_user (email) WHERE (kind = 'external'::text) AND (status <> 'deactivated'::text);

ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS db_role (
    role_name text,
    kind text NOT NULL,
    description text NOT NULL,
    CONSTRAINT db_role_pk PRIMARY KEY (role_name),
    CONSTRAINT db_role_kind_ck CHECK (kind IN ('anon'::text, 'external'::text, 'internal'::text))
);

ALTER TABLE db_role ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS job_family (
    code text,
    label_en text NOT NULL,
    label_zh text,
    CONSTRAINT job_family_pk PRIMARY KEY (code)
);

ALTER TABLE job_family ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS authority_rule (
    id uuid DEFAULT uuidv7(),
    action_code text NOT NULL,
    db_role text NOT NULL,
    job_family text,
    unit_type text,
    min_grade integer NOT NULL,
    max_amount numeric(18,2),
    currency character(3),
    requires_qualification boolean DEFAULT false NOT NULL,
    valid tstzrange DEFAULT tstzrange(now(), NULL) NOT NULL,
    note text,
    CONSTRAINT authority_rule_pkey PRIMARY KEY (id),
    CONSTRAINT authority_rule_family_fk FOREIGN KEY (job_family) REFERENCES job_family (code),
    CONSTRAINT authority_rule_role_fk FOREIGN KEY (db_role) REFERENCES db_role (role_name),
    CONSTRAINT authority_rule_amount_ck CHECK ((max_amount IS NULL) = (currency IS NULL)),
    CONSTRAINT authority_rule_min_grade_ck CHECK (min_grade >= 1)
);

CREATE INDEX IF NOT EXISTS authority_rule_action_ix ON authority_rule (action_code, db_role);

ALTER TABLE authority_rule ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS default_role_rule (
    id uuid DEFAULT uuidv7(),
    unit_type text,
    unit_function text,
    job_family text,
    min_grade integer NOT NULL,
    max_grade integer NOT NULL,
    db_role text NOT NULL,
    scope_target text NOT NULL,
    CONSTRAINT default_role_rule_pkey PRIMARY KEY (id),
    CONSTRAINT default_role_rule_family_fk FOREIGN KEY (job_family) REFERENCES job_family (code),
    CONSTRAINT default_role_rule_role_fk FOREIGN KEY (db_role) REFERENCES db_role (role_name),
    CONSTRAINT default_role_rule_grade_ck CHECK (min_grade <= max_grade),
    CONSTRAINT default_role_rule_scope_ck CHECK (scope_target IN ('own_unit'::text, 'parent_unit'::text, 'global'::text))
);

ALTER TABLE default_role_rule ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS job_grade (
    grade integer,
    label_en text NOT NULL,
    CONSTRAINT job_grade_pk PRIMARY KEY (grade),
    CONSTRAINT job_grade_range_ck CHECK (grade >= 0 AND grade <= 8)
);

ALTER TABLE job_grade ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS job_title (
    code text,
    label_en text NOT NULL,
    label_zh text,
    job_family text,
    grade integer NOT NULL,
    active boolean DEFAULT true NOT NULL,
    CONSTRAINT job_title_pk PRIMARY KEY (code),
    CONSTRAINT job_title_family_fk FOREIGN KEY (job_family) REFERENCES job_family (code),
    CONSTRAINT job_title_grade_fk FOREIGN KEY (grade) REFERENCES job_grade (grade)
);

ALTER TABLE job_title ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS login_attempt (
    id bigint GENERATED ALWAYS AS IDENTITY,
    at timestamptz DEFAULT now() NOT NULL,
    login_name text,
    client_ip inet,
    outcome text NOT NULL,
    reason text,
    CONSTRAINT login_attempt_pk PRIMARY KEY (id),
    CONSTRAINT login_attempt_name_lower_ck CHECK (login_name IS NULL OR login_name = lower(login_name))
);

ALTER TABLE login_attempt ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS one_time_token (
    id uuid DEFAULT uuidv7(),
    user_id uuid NOT NULL,
    purpose text NOT NULL,
    token_hash bytea NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_by uuid,
    CONSTRAINT one_time_token_pkey PRIMARY KEY (id),
    CONSTRAINT one_time_token_hash_uk UNIQUE (token_hash),
    CONSTRAINT one_time_token_created_by_fk FOREIGN KEY (created_by) REFERENCES app_user (id),
    CONSTRAINT one_time_token_user_fk FOREIGN KEY (user_id) REFERENCES app_user (id),
    CONSTRAINT one_time_token_purpose_ck CHECK (purpose IN ('invite'::text, 'password_reset'::text))
);

ALTER TABLE one_time_token ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS org_membership (
    id uuid DEFAULT uuidv7(),
    user_id uuid NOT NULL,
    user_kind text DEFAULT 'external' NOT NULL,
    org_id uuid NOT NULL,
    member_role text NOT NULL,
    valid tstzrange DEFAULT tstzrange(now(), NULL) NOT NULL,
    granted_by uuid NOT NULL,
    revoked_at timestamptz,
    revoked_by uuid,
    CONSTRAINT org_membership_pkey PRIMARY KEY (id),
    CONSTRAINT org_membership_granted_by_fk FOREIGN KEY (granted_by) REFERENCES app_user (id),
    CONSTRAINT org_membership_revoked_by_fk FOREIGN KEY (revoked_by) REFERENCES app_user (id),
    CONSTRAINT org_membership_user_fk FOREIGN KEY (user_id, user_kind) REFERENCES app_user (id, kind),
    CONSTRAINT org_membership_role_ck CHECK (member_role IN ('org_admin'::text, 'requester'::text, 'viewer'::text)),
    CONSTRAINT org_membership_user_kind_ck CHECK (user_kind = 'external'::text),
    CONSTRAINT org_membership_ex EXCLUDE USING gist (user_id WITH =, org_id WITH =, valid WITH &&) WHERE (revoked_at IS NULL)
);

ALTER TABLE org_membership ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS password_credential (
    user_id uuid,
    user_kind text DEFAULT 'external' NOT NULL,
    hash text NOT NULL,
    set_at timestamptz DEFAULT now() NOT NULL,
    must_change boolean DEFAULT false NOT NULL,
    CONSTRAINT password_credential_pk PRIMARY KEY (user_id),
    CONSTRAINT password_credential_user_fk FOREIGN KEY (user_id, user_kind) REFERENCES app_user (id, kind),
    CONSTRAINT password_credential_user_kind_ck CHECK (user_kind = 'external'::text)
);

ALTER TABLE password_credential ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS session (
    id uuid DEFAULT uuidv7(),
    user_id uuid NOT NULL,
    user_kind text NOT NULL,
    active_role text NOT NULL,
    auth_method text NOT NULL,
    data jsonb DEFAULT '{}' NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    last_seen_at timestamptz DEFAULT now() NOT NULL,
    idle_expires_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    revoke_reason text,
    client_ip inet,
    user_agent text,
    CONSTRAINT session_pkey PRIMARY KEY (id),
    CONSTRAINT session_role_fk FOREIGN KEY (active_role) REFERENCES db_role (role_name),
    CONSTRAINT session_user_fk FOREIGN KEY (user_id, user_kind) REFERENCES app_user (id, kind),
    CONSTRAINT session_auth_method_ck CHECK (auth_method IN ('entra'::text, 'microsoft'::text, 'google'::text, 'pwd'::text)),
    CONSTRAINT session_external_role_ck CHECK ((user_kind = 'external'::text) = (active_role = 'ext_user'::text)),
    CONSTRAINT session_user_kind_ck CHECK (user_kind IN ('internal'::text, 'external'::text))
);

CREATE INDEX IF NOT EXISTS session_user_active_ix ON session (user_id) WHERE (revoked_at IS NULL);

ALTER TABLE session ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS staff_position (
    id uuid DEFAULT uuidv7(),
    user_id uuid NOT NULL,
    user_kind text DEFAULT 'internal' NOT NULL,
    job_title_code text NOT NULL,
    job_family text NOT NULL,
    unit_id uuid NOT NULL,
    line_manager_id uuid,
    valid tstzrange NOT NULL,
    set_by uuid NOT NULL,
    reason text NOT NULL,
    CONSTRAINT staff_position_pkey PRIMARY KEY (id),
    CONSTRAINT staff_position_family_fk FOREIGN KEY (job_family) REFERENCES job_family (code),
    CONSTRAINT staff_position_line_manager_fk FOREIGN KEY (line_manager_id) REFERENCES app_user (id),
    CONSTRAINT staff_position_set_by_fk FOREIGN KEY (set_by) REFERENCES app_user (id),
    CONSTRAINT staff_position_title_fk FOREIGN KEY (job_title_code) REFERENCES job_title (code),
    CONSTRAINT staff_position_user_fk FOREIGN KEY (user_id, user_kind) REFERENCES app_user (id, kind),
    CONSTRAINT staff_position_line_manager_ck CHECK (line_manager_id IS DISTINCT FROM user_id),
    CONSTRAINT staff_position_set_by_ck CHECK (set_by <> user_id),
    CONSTRAINT staff_position_user_kind_ck CHECK (user_kind = 'internal'::text),
    CONSTRAINT staff_position_ex EXCLUDE USING gist (user_id WITH =, valid WITH &&)
);

ALTER TABLE staff_position ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS role_assignment (
    id uuid DEFAULT uuidv7(),
    user_id uuid NOT NULL,
    user_kind text DEFAULT 'internal' NOT NULL,
    db_role text NOT NULL,
    scope_type text NOT NULL,
    scope_unit_id uuid,
    source text NOT NULL,
    position_id uuid,
    valid tstzrange DEFAULT tstzrange(now(), NULL) NOT NULL,
    granted_by uuid NOT NULL,
    grant_reason text NOT NULL,
    revoked_at timestamptz,
    revoked_by uuid,
    revoke_reason text,
    CONSTRAINT role_assignment_pkey PRIMARY KEY (id),
    CONSTRAINT role_assignment_granted_by_fk FOREIGN KEY (granted_by) REFERENCES app_user (id),
    CONSTRAINT role_assignment_position_fk FOREIGN KEY (position_id) REFERENCES staff_position (id),
    CONSTRAINT role_assignment_revoked_by_fk FOREIGN KEY (revoked_by) REFERENCES app_user (id),
    CONSTRAINT role_assignment_role_fk FOREIGN KEY (db_role) REFERENCES db_role (role_name),
    CONSTRAINT role_assignment_user_fk FOREIGN KEY (user_id, user_kind) REFERENCES app_user (id, kind),
    CONSTRAINT role_assignment_granted_by_ck CHECK (granted_by <> user_id),
    CONSTRAINT role_assignment_scope_ck CHECK ((scope_type = 'global'::text) = (scope_unit_id IS NULL)),
    CONSTRAINT role_assignment_scope_type_ck CHECK (scope_type IN ('global'::text, 'unit'::text)),
    CONSTRAINT role_assignment_source_ck CHECK (source IN ('position'::text, 'manual'::text)),
    CONSTRAINT role_assignment_source_position_ck CHECK ((source = 'position'::text) = (position_id IS NOT NULL)),
    CONSTRAINT role_assignment_user_kind_ck CHECK (user_kind = 'internal'::text),
    CONSTRAINT role_assignment_ex EXCLUDE USING gist (user_id WITH =, db_role WITH =, COALESCE(scope_unit_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =, valid WITH &&) WHERE (revoked_at IS NULL)
);

CREATE INDEX IF NOT EXISTS role_assignment_active_ix ON role_assignment (user_id, db_role) WHERE (revoked_at IS NULL);

ALTER TABLE role_assignment ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS user_identity (
    id uuid DEFAULT uuidv7(),
    user_id uuid NOT NULL,
    user_kind text DEFAULT 'external' NOT NULL,
    provider text NOT NULL,
    issuer text NOT NULL,
    subject text NOT NULL,
    tenant_id uuid,
    object_id uuid,
    email_at_link text,
    linked_at timestamptz DEFAULT now() NOT NULL,
    last_used_at timestamptz,
    unlinked_at timestamptz,
    CONSTRAINT user_identity_pkey PRIMARY KEY (id),
    CONSTRAINT user_identity_user_fk FOREIGN KEY (user_id, user_kind) REFERENCES app_user (id, kind),
    CONSTRAINT user_identity_email_lower_ck CHECK (email_at_link IS NULL OR email_at_link = lower(email_at_link)),
    CONSTRAINT user_identity_provider_ck CHECK (provider IN ('microsoft'::text, 'google'::text)),
    CONSTRAINT user_identity_user_kind_ck CHECK (user_kind = 'external'::text)
);

CREATE UNIQUE INDEX IF NOT EXISTS user_identity_active_uk ON user_identity (issuer, subject) WHERE (unlinked_at IS NULL);

ALTER TABLE user_identity ENABLE ROW LEVEL SECURITY;

ALTER TABLE authority_rule
ADD CONSTRAINT authority_rule_unit_type_fk FOREIGN KEY (unit_type) REFERENCES core.org_unit_type (code);

ALTER TABLE default_role_rule
ADD CONSTRAINT default_role_rule_unit_type_fk FOREIGN KEY (unit_type) REFERENCES core.org_unit_type (code);

ALTER TABLE org_membership
ADD CONSTRAINT org_membership_org_fk FOREIGN KEY (org_id) REFERENCES party.organization (id);

ALTER TABLE role_assignment
ADD CONSTRAINT role_assignment_unit_fk FOREIGN KEY (scope_unit_id) REFERENCES core.org_unit (id);

ALTER TABLE staff_position
ADD CONSTRAINT staff_position_unit_fk FOREIGN KEY (unit_id) REFERENCES core.org_unit (id);

CREATE OR REPLACE TRIGGER app_user_stamp
    BEFORE INSERT OR UPDATE ON app_user
    FOR EACH ROW
    EXECUTE FUNCTION private.stamp();
