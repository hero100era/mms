-- H-10: break-glass status. The account that can read its own state is the caller;
-- HO Compliance and system administrators may read any account. Nothing is granted
-- to a break-glass account itself: while dormant it must not be able to load a
-- page, and while active it gets `int_sysadmin`'s surface through the assignment,
-- not through a personal grant.
create view api.break_glass_accounts
with (security_invoker = true)
as
select b.user_id, u.display_name, b.label, b.enabled,
       b.activated_at, b.valid_until, b.reason, b.last_drill_at
  from iam.break_glass_account b
  join iam.app_user u on u.id = b.user_id;

create function api.break_glass_state()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
           (select jsonb_build_object(
                     'label', b.label,
                     'enabled', b.enabled,
                     'dormant', not exists (
                         select 1 from iam.role_assignment a
                          where a.user_id = b.user_id
                            and a.source = 'break_glass'
                            and a.revoked_at is null
                            and a.valid && tstzrange(now(), null, '[)')),
                     'valid_until', b.valid_until,
                     'reason', b.reason,
                     'last_drill_at', b.last_drill_at,
                     'drill_overdue', b.last_drill_at is null or b.last_drill_at <= now() - interval '92 days'
                   )
              from iam.break_glass_account b
             where b.user_id = private.uid()),
           '{}'::jsonb);
$$;

revoke all on function api.break_glass_state() from public;

grant execute on function api.break_glass_state() to int_viewer, int_surveyor, int_auditor,
  int_coordinator, int_manager, int_hr, int_finance;
grant select on api.break_glass_accounts to int_compliance, int_sysadmin;

-- ---------------------------------------------------------------------------
-- H-10 S3: the fixed runbook for `mms_emergency`, used only when the application or
-- Entra is down. Each function does one narrow thing and can do nothing else: no
-- ad-hoc reads or writes are granted to the role, it holds no capability role (so it
-- cannot SET ROLE into int_sysadmin), and it cannot read business data through
-- PostgREST. Row changes are attributed to `dba` because a session authenticated
-- outside the BFF carries no role claim, and `private.audit_source()` says so.
-- ---------------------------------------------------------------------------

create function api.emergency_suspend_user(p_user_id uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed integer;
begin
  if not private.is_emergency() then
    raise exception 'emergency_role_required' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  perform set_config('mms.reason', btrim(p_reason), true);
  update iam.app_user
     set status = 'suspended'
   where id = p_user_id
     and status <> 'suspended';
  get diagnostics v_changed = row_count;
  return v_changed > 0;
end;
$$;

create function api.emergency_revoke_sessions(p_user_id uuid, p_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed int;
begin
  if not private.is_emergency() then
    raise exception 'emergency_role_required' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  perform set_config('mms.reason', btrim(p_reason), true);
  update iam.session
     set revoked_at = now(), revoke_reason = 'break_glass: ' || btrim(p_reason)
   where user_id = p_user_id
     and revoked_at is null;
  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

create function api.emergency_revoke_assignment(p_assignment_id uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_changed integer;
begin
  if not private.is_emergency() then
    raise exception 'emergency_role_required' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  select user_id into v_user from iam.role_assignment where id = p_assignment_id;
  if not found then
    raise exception 'assignment_not_found' using errcode = '42501';
  end if;
  perform set_config('mms.reason', btrim(p_reason), true);
  update iam.role_assignment
     set revoked_at = now(),
         revoked_by = v_user,
         revoke_reason = 'break_glass: ' || btrim(p_reason),
         valid = tstzrange(lower(valid), least(now(), upper(valid)), '[)')
   where id = p_assignment_id
     and revoked_at is null;
  get diagnostics v_changed = row_count;
  return v_changed > 0;
end;
$$;

create function api.emergency_reenable_break_glass(p_user_id uuid, p_operator text, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed int;
begin
  if not private.is_emergency() then
    raise exception 'emergency_role_required' using errcode = '42501';
  end if;
  if p_operator is null or btrim(p_operator) = '' then
    raise exception 'operator_required' using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  perform set_config('mms.reason', btrim(p_reason), true);
  update iam.break_glass_account
     set enabled = true,
         activated_at = null,
         valid_until = null,
         reason = null
   where user_id = p_user_id
     and not enabled;
  get diagnostics v_changed = row_count;
  return v_changed > 0;
end;
$$;

revoke all on function api.emergency_suspend_user(uuid, text) from public;
revoke all on function api.emergency_revoke_sessions(uuid, text) from public;
revoke all on function api.emergency_revoke_assignment(uuid, text) from public;
revoke all on function api.emergency_reenable_break_glass(uuid, text, text) from public;
grant execute on function api.emergency_suspend_user(uuid, text) to mms_emergency;
grant execute on function api.emergency_revoke_sessions(uuid, text) to mms_emergency;
grant execute on function api.emergency_revoke_assignment(uuid, text) to mms_emergency;
grant execute on function api.emergency_reenable_break_glass(uuid, text, text) to mms_emergency;

-- H-10: register an existing internal identity as a break-glass account. The identity
-- is created first (Entra provisions it on first sign-in, or an administrator creates
-- it), then designated here. A break-glass account must not hold a staff position: a
-- person's normal account carrying a position would quietly become emergency
-- authority, which is exactly what the separation exists to prevent.
create function api.break_glass_register(
  p_user_id uuid,
  p_label text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user iam.app_user;
begin
  if coalesce(private.claim('role'), '') <> 'int_sysadmin' then
    raise exception 'insufficient_authority' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_label is null or btrim(p_label) = '' then
    raise exception 'label_required' using errcode = '22023';
  end if;

  select * into v_user from iam.app_user where id = p_user_id;
  if not found then
    raise exception 'unknown_user' using errcode = '22023';
  end if;
  if v_user.kind <> 'internal' then
    raise exception 'break_glass_requires_internal_user' using errcode = '22023';
  end if;
  if v_user.status <> 'active' then
    raise exception 'break_glass_requires_active_user' using errcode = '22023';
  end if;
  if exists (
    select 1 from iam.staff_position p
     where p.user_id = p_user_id and p.valid @> now()
  ) then
    raise exception 'break_glass_account_holds_position' using errcode = '23514';
  end if;
  if exists (select 1 from iam.break_glass_account b where b.user_id = p_user_id) then
    raise exception 'already_break_glass_account' using errcode = '23505';
  end if;

  perform private.set_change_context(p_reason);

  insert into iam.break_glass_account (user_id, label)
  values (p_user_id, btrim(p_label));

  perform private.emit_event(
    'auth.breakglass.registered', 'success', 'user', p_user_id, null, p_reason,
    jsonb_build_object('label', btrim(p_label))
  );
end;
$$;

revoke all on function api.break_glass_register(uuid, text, text) from public;
grant execute on function api.break_glass_register(uuid, text, text) to int_sysadmin;

