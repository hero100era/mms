
create function private.entra_sync_list_staff()
returns table (
  user_id uuid,
  entra_tenant_id uuid,
  entra_object_id uuid,
  display_name text,
  email text,
  status text,
  has_position boolean
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if not private.is_worker_or_admin() then
    raise exception 'worker_or_admin_role_required' using errcode = '42501';
  end if;

  return query
  select u.id, u.entra_tenant_id, u.entra_object_id, u.display_name, u.email, u.status,
         exists (
           select 1 from iam.staff_position sp
            where sp.user_id = u.id and upper(sp.valid) is null
         ) as has_position
    from iam.app_user u
   where u.kind = 'internal'
     and u.status in ('active', 'suspended')
     and u.entra_tenant_id is not null
     and u.entra_object_id is not null
   order by u.id;
end;
$$;

create function private.deprovision_staff_user(
  p_user_id uuid,
  p_reason text,
  p_details jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user iam.app_user;
  v_worker_id uuid;
  v_worker_name text;
  v_revoked_sessions int := 0;
  v_revoked_assignments int := 0;
  v_closed_positions int := 0;
begin
  if not private.is_worker_or_admin() then
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
  if private.is_worker() then
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

create function private.record_entra_sync_run(
  p_status text,
  p_users_checked int,
  p_users_deprovisioned int,
  p_deprovisioned_user_ids uuid[],
  p_error_message text default null,
  p_detail jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id bigint;
begin
  if not private.is_worker_or_admin() then
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

revoke all on function private.entra_sync_list_staff() from public;
revoke all on function private.deprovision_staff_user(uuid, text, jsonb) from public;
revoke all on function private.record_entra_sync_run(text, int, int, uuid[], text, jsonb) from public;

grant execute on function private.entra_sync_list_staff() to worker, int_sysadmin;
grant execute on function private.deprovision_staff_user(uuid, text, jsonb) to worker, int_sysadmin;
grant execute on function private.record_entra_sync_run(text, int, int, uuid[], text, jsonb) to worker, int_sysadmin;

-- H-13: stage a position proposal from directory attributes. Called by the Entra sync
-- (worker) and available to a sysadmin for a manual stage. It writes a proposal, never a
-- position: HR confirms it through api.position_proposal_confirm, which goes through the
-- ordinary staff_position_set path so authority, scope and audit are identical.
--
-- The guesses are exact code matches only. A directory string like
-- "Senior Surveyor (Asia)" is not mapped onto a job title here, because inventing that
-- mapping inside a function would silently encode an organisational decision.
create function private.position_proposal_record(
  p_user_id uuid,
  p_entra_job_title text,
  p_entra_department text,
  p_entra_office text,
  p_payload jsonb default '{}'::jsonb,
  p_proposed_by uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user iam.app_user;
  v_title text;
  v_unit uuid;
  v_id uuid;
  v_proposer uuid;
begin
  if not (private.is_worker_or_admin() or coalesce(private.active_role(), '') = 'int_hr') then
    raise exception 'worker_or_admin_role_required' using errcode = '42501';
  end if;

  select * into v_user from iam.app_user
   where id = p_user_id and kind = 'internal' and status = 'active';
  if not found then
    raise exception 'internal_user_not_found';
  end if;

  select t.code into v_title from iam.job_title t
   where t.active and lower(t.code) = lower(btrim(coalesce(p_entra_job_title, '')));
  select u.id into v_unit from core.org_unit u
   where u.active and lower(u.code) = lower(btrim(coalesce(p_entra_office, ''))) limit 1;

  v_proposer := case
    when private.is_worker() then coalesce(p_proposed_by, nullif(private.uid(), '00000000-0000-0000-0000-000000000001'::uuid))
    else nullif(private.uid(), '00000000-0000-0000-0000-000000000001'::uuid)
  end;

  insert into iam.position_proposal (
    user_id, job_title_code, unit_id, entra_job_title, entra_department, entra_office,
    source, source_payload, proposed_by
  )
  values (
    v_user.id, v_title, v_unit,
    nullif(btrim(p_entra_job_title), ''),
    nullif(btrim(p_entra_department), ''),
    nullif(btrim(p_entra_office), ''),
    case when private.is_worker() then 'entra' else 'hr' end,
    coalesce(p_payload, '{}'::jsonb),
    v_proposer
  )
  on conflict (user_id) where status = 'pending'
  do update set job_title_code = excluded.job_title_code,
                unit_id = excluded.unit_id,
                entra_job_title = excluded.entra_job_title,
                entra_department = excluded.entra_department,
                entra_office = excluded.entra_office,
                source_payload = excluded.source_payload,
                proposed_by = coalesce(excluded.proposed_by, iam.position_proposal.proposed_by),
                proposed_at = now()
  returning id into v_id;

  perform private.emit_event(
    'iam.position.proposed', 'success', 'staff_user', v_user.id, v_unit,
    'position proposed from directory attributes',
    jsonb_build_object('proposal_id', v_id, 'job_title_guess', v_title, 'unit_guess', v_unit)
  );
  return v_id;
end;
$$;

revoke all on function private.position_proposal_record(uuid, text, text, text, jsonb, uuid) from public;
grant execute on function private.position_proposal_record(uuid, text, text, text, jsonb, uuid) to worker, int_hr, int_sysadmin;
