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

  -- 1. Close active and future positions
  update iam.staff_position
     set valid = case
                   when lower(valid) < now() then tstzrange(lower(valid), now())
                   else 'empty'::tstzrange
                 end,
         reason = p_reason
   where user_id = p_user_id
     and not isempty(valid)
     and (upper_inf(valid) or upper(valid) > now());
  get diagnostics v_closed_positions = row_count;

  -- 2. Revoke active role assignments
  update iam.role_assignment
     set revoked_at = now(),
         revoked_by = v_worker_id,
         revoke_reason = p_reason
   where user_id = p_user_id
     and revoked_at is null;
  get diagnostics v_revoked_assignments = row_count;

  -- Count active sessions that will be revoked by user deactivation
  select count(*) into v_revoked_sessions
    from iam.session
   where user_id = p_user_id
     and revoked_at is null;

  -- 3. Transition user status to deactivated
  -- Trigger private.app_user_revoke_sessions automatically revokes all active sessions in iam.session
  update iam.app_user
     set status = 'deactivated'
   where id = p_user_id;

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
