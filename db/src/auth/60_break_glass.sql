
-- The token claims signAccessToken() adds for an active break-glass window:
-- `src = 'break_glass'` (audit attribution for every action in the window) and
-- `bg = <valid_until epoch seconds>`.
create function auth.break_glass_claims(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when b.valid_until is null or b.valid_until <= now() then null
           else jsonb_build_object(
             'src', 'break_glass',
             'bg', floor(extract(epoch from b.valid_until))::bigint
           )
         end
    from iam.break_glass_account b
   where b.user_id = p_user_id
     and b.enabled;
$$;

create function auth.break_glass_activate(
  p_user_id uuid,
  p_reason text,
  p_valid_until timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_label text;
  v_enabled boolean;
  v_now timestamptz;
  v_until timestamptz;
  v_live int;
  v_assignment iam.role_assignment;
  v_existing jsonb;
begin
  if p_reason is null or btrim(p_reason) = '' then
    perform private.emit_event(
      'auth.breakglass.failure', 'failure', 'user', p_user_id, null, null,
      jsonb_build_object('reason', 'reason_required'));
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select label, enabled into v_label, v_enabled
    from iam.break_glass_account
   where user_id = p_user_id
     for update;
  if not found then
    raise exception 'not_break_glass_account' using errcode = '42501';
  end if;
  if not v_enabled then
    perform private.emit_event(
      'auth.breakglass.denied', 'denied', 'user', p_user_id, null, null,
      jsonb_build_object('reason', 'disabled'));
    raise exception 'break_glass_disabled' using errcode = '42501';
  end if;

  -- Already active: report the window instead of stacking a second assignment.
  if exists (
    select 1 from iam.role_assignment a
     where a.user_id = p_user_id
       and a.source = 'break_glass'
       and a.revoked_at is null
       and a.valid && tstzrange(now(), null, '[)')
  ) then
    select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb) into v_existing
      from iam.role_assignment a
     where a.user_id = p_user_id
       and a.source = 'break_glass'
       and a.revoked_at is null
       and a.valid && tstzrange(now(), null, '[)');
    return jsonb_build_object(
      'activated', false,
      'reason', 'already_active',
      'assignments', v_existing
    );
  end if;

  -- The window is bounded by the card, whatever the caller asks for.
  v_now := clock_timestamp();
  v_until := least(coalesce(p_valid_until, v_now + interval '4 hours'), v_now + interval '4 hours');
  if v_until <= v_now then
    raise exception 'invalid_validity_window' using errcode = '22023';
  end if;

  -- Exactly one global int_sysadmin assignment while the window is open.
  select count(*) into v_live
    from iam.role_assignment a
   where a.user_id = p_user_id
     and a.db_role = 'int_sysadmin'
     and a.revoked_at is null
     and a.valid @> v_now;
  if v_live > 0 then
    raise exception 'already_holds_sysadmin' using errcode = '23514';
  end if;

  insert into iam.role_assignment (
    user_id, user_kind, db_role, scope_type, scope_unit_id,
    source, position_id, valid, granted_by, grant_reason
  ) values (
    p_user_id, 'internal', 'int_sysadmin', 'global', null,
    'break_glass', null, tstzrange(v_now, v_until, '[)'), p_user_id, btrim(p_reason)
  )
  returning * into v_assignment;

  update iam.break_glass_account
     set activated_at = v_now,
         valid_until = v_until,
         reason = btrim(p_reason)
   where user_id = p_user_id;

  perform private.emit_event(
    'auth.breakglass.activated', 'success', 'user', p_user_id, null, btrim(p_reason),
    jsonb_build_object(
      'label', v_label,
      'assignment_id', v_assignment.id,
      'valid_until', v_until,
      'window_hours', round(extract(epoch from (v_until - v_now)) / 3600, 2)
    )
  );

  -- Immediate alerts, through the existing outbox, so an activation cannot pass
  -- unnoticed even when nobody reads the audit trail.
  insert into core.outbox (kind, payload, status)
  select 'break_glass_alert',
         jsonb_build_object(
           'user_id', p_user_id,
           'label', v_label,
           'reason', btrim(p_reason),
           'valid_until', v_until,
           'audience', audience
         ),
         'pending'
    from unnest(array['it_security', 'ho_compliance']) as audience;

  return jsonb_build_object(
    'activated', true,
    'assignment_id', v_assignment.id,
    'valid_until', v_until
  );
end;
$$;

create function auth.break_glass_deactivate(p_user_id uuid, p_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
  v_label text;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select label into v_label from iam.break_glass_account where user_id = p_user_id;
  if not found then
    raise exception 'not_break_glass_account' using errcode = '42501';
  end if;

  update iam.role_assignment
     set revoked_at = now(),
         revoked_by = p_user_id,
         revoke_reason = btrim(p_reason),
         valid = tstzrange(lower(valid), least(now(), upper(valid)), '[)')
   where user_id = p_user_id
     and source = 'break_glass'
     and revoked_at is null;
  get diagnostics v_count = row_count;

  -- Revoke every live session the account opened, so nothing outlives the window.
  update iam.session
     set revoked_at = now(), revoke_reason = 'break_glass_deactivated'
   where user_id = p_user_id
     and revoked_at is null;

  update iam.break_glass_account
     set activated_at = null,
         valid_until = null,
         reason = null
   where user_id = p_user_id;

  perform private.emit_event(
    'auth.breakglass.deactivated', 'success', 'user', p_user_id, null, btrim(p_reason),
    jsonb_build_object('label', v_label, 'assignments_revoked', v_count)
  );

  return v_count;
end;
$$;

create function auth.break_glass_failure(p_user_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.emit_event(
    'auth.breakglass.failure', 'failure', 'user', p_user_id, null, null,
    jsonb_build_object('reason', coalesce(p_reason, 'unknown')));
end;
$$;

revoke all on function auth.break_glass_claims(uuid) from public;
revoke all on function auth.break_glass_deactivate(uuid, text) from public;
revoke all on function auth.break_glass_failure(uuid, text) from public;
grant execute on function auth.break_glass_claims(uuid) to auth_gateway;
grant execute on function auth.break_glass_deactivate(uuid, text) to auth_gateway;
grant execute on function auth.break_glass_failure(uuid, text) to auth_gateway;

revoke all on function auth.break_glass_activate(uuid, text, timestamptz) from public;
grant execute on function auth.break_glass_activate(uuid, text, timestamptz) to auth_gateway;

-- H-10: the state the break-glass page needs, readable while the account is dormant.
-- This cannot go through PostgREST: a dormant account holds no assignment, so
-- `private.pre_request` refuses every API call, and the account that exists to fix a
-- lockout would be unable to learn that it is dormant. It runs as a definer function
-- granted to the gateway role and reads exactly one row.
create function auth.break_glass_state(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'label', b.label,
    'enabled', b.enabled,
    'dormant', b.valid_until is null or b.valid_until <= now(),
    'valid_until', b.valid_until,
    'reason', b.reason,
    'last_drill_at', b.last_drill_at,
    -- The drill is the control that keeps the account usable on the day it is needed.
    -- Overdue is computed on read against the 92-day quarterly threshold.
    'drill_overdue', b.last_drill_at is null
      or b.last_drill_at <= now() - interval '92 days'
  )
  from iam.break_glass_account b
  where b.user_id = p_user_id;
$$;

revoke all on function auth.break_glass_state(uuid) from public;
grant execute on function auth.break_glass_state(uuid) to auth_gateway;

-- H-10 / R8.5: the accounts whose drill is overdue. Overdue is evaluated against
-- the explicit 92-day quarterly threshold.
create function auth.break_glass_drill_overdue()
returns table(user_id uuid, label text, last_drill_at timestamptz, days_since_drill int)
language sql
stable
security definer
set search_path = ''
as $$
  select b.user_id,
         b.label,
         b.last_drill_at,
         case
           when b.last_drill_at is null then null
           else floor(extract(epoch from (now() - b.last_drill_at)) / 86400)::int
         end
    from iam.break_glass_account b
   where b.enabled
     and (b.last_drill_at is null or b.last_drill_at <= now() - interval '92 days')
   order by b.last_drill_at nulls first;
$$;

revoke all on function auth.break_glass_drill_overdue() from public;
grant execute on function auth.break_glass_drill_overdue() to auth_gateway;

-- R8.5: Asynchronous cleanup for expired break-glass accounts.
-- Synchronous denial in private.pre_request() immediately denies requests the moment
-- valid_until passes; this function sweeps expired sessions and resets the activation window.
create function auth.break_glass_sweep_expired()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int := 0;
  v_rec record;
begin
  for v_rec in
    select user_id, label
      from iam.break_glass_account
     where enabled = true
       and valid_until is not null
       and valid_until <= now()
       for update
  loop
    update iam.session
       set revoked_at = now(),
           revoke_reason = 'break_glass_expired'
     where user_id = v_rec.user_id
       and revoked_at is null;

    update iam.break_glass_account
       set activated_at = null,
           valid_until = null,
           reason = null
     where user_id = v_rec.user_id;

    perform private.emit_event(
      'auth.breakglass.deactivated', 'success', 'user', v_rec.user_id, null,
      'break-glass activation window expired (asynchronous cleanup)',
      jsonb_build_object('label', v_rec.label)
    );

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function auth.break_glass_sweep_expired() from public;
grant execute on function auth.break_glass_sweep_expired() to auth_gateway, worker;

-- R1.6: record a completed break-glass drill. The emitted audit event is the
-- evidence record (it enters the existing sealed audit pipeline), and
-- last_drill_at drives auth.break_glass_drill_overdue(). Only the gateway may
-- call this; it is not reachable from PostgREST capability roles.
create function auth.break_glass_drill_record(
  p_user_id uuid,
  p_operator text,
  p_outcome text,
  p_evidence jsonb default '{}'::jsonb
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_at timestamptz := clock_timestamp();
  v_label text;
begin
  if p_operator is null or btrim(p_operator) = '' then
    raise exception 'operator_required' using errcode = '22023';
  end if;
  if p_outcome not in ('passed', 'failed') then
    raise exception 'invalid_drill_outcome' using errcode = '22023';
  end if;

  update iam.break_glass_account
     set last_drill_at = case when p_outcome = 'passed' then v_at else last_drill_at end
   where user_id = p_user_id
     and enabled
  returning label into v_label;

  if not found then
    raise exception 'break_glass_account_not_found' using errcode = '22023';
  end if;

  perform private.emit_event(
    'auth.breakglass.drill_recorded', 'success', 'break_glass_account', p_user_id, null, null,
    jsonb_build_object(
      'operator', btrim(p_operator),
      'outcome', p_outcome,
      'label', v_label,
      'performed_at', v_at,
      'evidence', coalesce(p_evidence, '{}'::jsonb)
    )
  );

  return v_at;
end;
$$;

revoke all on function auth.break_glass_drill_record(uuid, text, text, jsonb) from public;
grant execute on function auth.break_glass_drill_record(uuid, text, text, jsonb) to auth_gateway;

