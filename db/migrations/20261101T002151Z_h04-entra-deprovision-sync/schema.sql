-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION deprovision_staff_user(
    p_user_id uuid,
    p_reason text,
    p_details jsonb DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user iam.app_user;
  v_worker_id uuid;
  v_worker_name text;
  v_revoked_sessions int := 0;
  v_revoked_assignments int := 0;
  v_closed_positions int := 0;
begin
  if session_user not in ('worker', 'int_sysadmin', 'postgres')
     and coalesce(nullif(current_setting('role', true), 'none'), '') not in ('worker', 'int_sysadmin') then
    raise exception 'worker_or_admin_role_required' using errcode = '42501';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_user
    from iam.app_user
   where id = p_user_id and kind = 'internal'
     for update;

  if not found then
    raise exception 'staff_user_not_found' using errcode = 'P0002';
  end if;

  if v_user.status = 'deactivated' then
    return jsonb_build_object(
      'user_id', p_user_id,
      'status', 'already_deactivated',
      'deactivated', false
    );
  end if;

  -- Setup actor identity for worker if session or role is worker
  if session_user = 'worker' or coalesce(nullif(current_setting('role', true), 'none'), '') = 'worker' then
    select id, display_name into v_worker_id, v_worker_name
      from iam.app_user
     where kind = 'service' and service_name = 'worker' and status = 'active';

    if v_worker_id is null then
      insert into iam.app_user (id, kind, display_name, service_name, status)
      values ('00000000-0000-0000-0000-000000000001', 'service', 'Outbox Worker', 'worker', 'active')
      on conflict (service_name) do update set status = 'active'
      returning id, display_name into v_worker_id, v_worker_name;
    end if;

    perform set_config('request.jwt.claims',
      jsonb_build_object(
        'sub', v_worker_id::text,
        'name', coalesce(v_worker_name, 'worker'),
        'role', 'worker',
        'src', 'job'
      )::text, true);
  else
    v_worker_id := private.uid();
  end if;

  perform set_config('mms.reason', p_reason, true);

  -- 1. Close active positions
  update iam.staff_position
     set valid = tstzrange(lower(valid), now()),
         reason = p_reason
   where user_id = p_user_id and valid @> now();
  get diagnostics v_closed_positions = row_count;

  -- 2. Revoke active role assignments
  update iam.role_assignment
     set revoked_at = now(),
         revoked_by = v_worker_id,
         revoke_reason = p_reason
   where user_id = p_user_id
     and revoked_at is null;
  get diagnostics v_revoked_assignments = row_count;

  -- 3. Transition user status to deactivated
  -- Trigger private.app_user_revoke_sessions automatically revokes all active sessions in iam.session
  update iam.app_user
     set status = 'deactivated'
   where id = p_user_id;

  select count(*) into v_revoked_sessions
    from iam.session
   where user_id = p_user_id
     and revoke_reason = 'user_deactivated';

  -- 4. Emit regulated audit event
  perform private.emit_event(
    'auth.user.deactivated',
    'success',
    'app_user',
    p_user_id,
    null,
    p_reason,
    jsonb_build_object(
      'user_id', p_user_id,
      'email', v_user.email,
      'display_name', v_user.display_name,
      'entra_tenant_id', v_user.entra_tenant_id,
      'entra_object_id', v_user.entra_object_id,
      'closed_positions', v_closed_positions,
      'revoked_assignments', v_revoked_assignments,
      'details', p_details
    )
  );

  return jsonb_build_object(
    'user_id', p_user_id,
    'status', 'deactivated',
    'deactivated', true,
    'closed_positions', v_closed_positions,
    'revoked_assignments', v_revoked_assignments,
    'revoked_sessions', v_revoked_sessions
  );
end;
$$;

CREATE OR REPLACE FUNCTION entra_sync_list_staff()
RETURNS TABLE(user_id uuid, entra_tenant_id uuid, entra_object_id uuid, display_name text, email text, status text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if session_user not in ('worker', 'int_sysadmin', 'postgres')
     and coalesce(nullif(current_setting('role', true), 'none'), '') not in ('worker', 'int_sysadmin') then
    raise exception 'worker_or_admin_role_required' using errcode = '42501';
  end if;

  return query
  select u.id, u.entra_tenant_id, u.entra_object_id, u.display_name, u.email, u.status
    from iam.app_user u
   where u.kind = 'internal'
     and u.status in ('active', 'suspended')
     and u.entra_tenant_id is not null
     and u.entra_object_id is not null
   order by u.id;
end;
$$;

CREATE OR REPLACE FUNCTION record_entra_sync_run(
    p_status text,
    p_users_checked integer,
    p_users_deprovisioned integer,
    p_deprovisioned_user_ids uuid[],
    p_error_message text DEFAULT NULL,
    p_detail jsonb DEFAULT '{}'
)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_run_id bigint;
begin
  if session_user not in ('worker', 'int_sysadmin', 'postgres')
     and coalesce(nullif(current_setting('role', true), 'none'), '') not in ('worker', 'int_sysadmin') then
    raise exception 'worker_or_admin_role_required' using errcode = '42501';
  end if;

  insert into audit_trail.entra_sync_run (
    status, users_checked, users_deprovisioned, deprovisioned_user_ids, error_message, detail
  )
  values (
    p_status, p_users_checked, p_users_deprovisioned, coalesce(p_deprovisioned_user_ids, '{}'), p_error_message, p_detail
  )
  returning id into v_run_id;

  return v_run_id;
end;
$$;

REVOKE EXECUTE ON FUNCTION deprovision_staff_user(p_user_id uuid, p_reason text, p_details jsonb) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION entra_sync_list_staff() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION record_entra_sync_run(p_status text, p_users_checked integer, p_users_deprovisioned integer, p_deprovisioned_user_ids uuid[], p_error_message text, p_detail jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION deprovision_staff_user(p_user_id uuid, p_reason text, p_details jsonb) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION deprovision_staff_user(p_user_id uuid, p_reason text, p_details jsonb) TO worker;

GRANT EXECUTE ON FUNCTION entra_sync_list_staff() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION entra_sync_list_staff() TO worker;

GRANT EXECUTE ON FUNCTION record_entra_sync_run(p_status text, p_users_checked integer, p_users_deprovisioned integer, p_deprovisioned_user_ids uuid[], p_error_message text, p_detail jsonb) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION record_entra_sync_run(p_status text, p_users_checked integer, p_users_deprovisioned integer, p_deprovisioned_user_ids uuid[], p_error_message text, p_detail jsonb) TO worker;

-- ===== schema: audit_trail  (pgschema 1.13.4) =====

set local search_path = audit_trail;

CREATE TABLE IF NOT EXISTS entra_sync_run (
    id bigint GENERATED ALWAYS AS IDENTITY,
    run_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    status text NOT NULL,
    users_checked integer DEFAULT 0 NOT NULL,
    users_deprovisioned integer DEFAULT 0 NOT NULL,
    deprovisioned_user_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    error_message text,
    detail jsonb DEFAULT '{}' NOT NULL,
    CONSTRAINT entra_sync_run_pk PRIMARY KEY (id),
    CONSTRAINT entra_sync_run_status_ck CHECK (status IN ('clean'::text, 'deprovisioned'::text, 'failed'::text))
);

CREATE INDEX IF NOT EXISTS entra_sync_run_time_ix ON entra_sync_run (run_at);

ALTER TABLE entra_sync_run ENABLE ROW LEVEL SECURITY;

CREATE POLICY entra_sync_run_insert ON entra_sync_run FOR INSERT TO int_sysadmin, worker WITH CHECK (true);

CREATE POLICY entra_sync_run_read ON entra_sync_run FOR SELECT TO audit_sealer, int_compliance, int_sysadmin, worker USING (true);

CREATE OR REPLACE TRIGGER entra_sync_run_append_only
    BEFORE UPDATE OR DELETE ON entra_sync_run
    FOR EACH ROW
    EXECUTE FUNCTION private.reconciliation_append_only();

GRANT SELECT ON TABLE entra_sync_run TO int_compliance;

GRANT INSERT, SELECT ON TABLE entra_sync_run TO int_sysadmin;

GRANT INSERT, SELECT ON TABLE entra_sync_run TO worker;

-- ===== schema: auth  (pgschema 1.13.4) =====

set local search_path = auth;

CREATE OR REPLACE FUNCTION resolve_entra(
    p_tid uuid,
    p_oid uuid,
    p_upn text,
    p_name text,
    p_app_roles text[]
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_config auth.config;
  v_user iam.app_user;
  v_roles jsonb;
begin
  select * into v_config from auth.config where singleton;
  if v_config.entra_tenant_id is null then
    raise exception 'entra_tenant_not_configured' using errcode = '42501';
  end if;
  if p_tid is null or p_oid is null or p_tid <> v_config.entra_tenant_id then
    raise exception 'foreign_tenant' using errcode = '42501';
  end if;
  if not coalesce(p_app_roles, '{}') @> array[v_config.entra_app_role] then
    raise exception 'mms_user_role_required' using errcode = '42501';
  end if;
  if coalesce(p_app_roles, '{}') && array['Guest', 'MMS.Guest'] then
    raise exception 'guest_denied' using errcode = '42501';
  end if;

  insert into iam.app_user (kind, display_name, email, status, entra_tenant_id, entra_object_id)
  values (
    'internal',
    coalesce(nullif(trim(p_name), ''), coalesce(p_upn, p_oid::text)),
    case when p_upn like '%@%' then lower(p_upn) end,
    'active',
    p_tid,
    p_oid
  )
  on conflict (entra_tenant_id, entra_object_id) do update
    set display_name = excluded.display_name,
        email = coalesce(excluded.email, iam.app_user.email),
        status = case when iam.app_user.status = 'deactivated' then 'active' else iam.app_user.status end
  returning * into v_user;

  select coalesce(jsonb_agg(distinct a.db_role order by a.db_role), '[]'::jsonb)
    into v_roles
    from iam.role_assignment a
   where a.user_id = v_user.id
     and a.revoked_at is null
     and a.valid @> now();

  return jsonb_build_object(
    'user_id', v_user.id,
    'status', v_user.status,
    'assignable_roles', v_roles
  );
end;
$$;
