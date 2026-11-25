-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION enqueue_security_alert(
    p_alert_type text,
    p_severity text,
    p_source text,
    p_message text,
    p_details jsonb DEFAULT '{}'
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_job_id uuid;
begin
  insert into core.outbox (kind, payload, status)
  values (
    'security_alert',
    jsonb_build_object(
      'alert_type', p_alert_type,
      'severity', p_severity,
      'source', p_source,
      'message', p_message,
      'details', coalesce(p_details, '{}'::jsonb)
    ),
    'pending'
  )
  returning id into v_job_id;

  return v_job_id;
end;
$$;

REVOKE EXECUTE ON FUNCTION enqueue_security_alert(p_alert_type text, p_severity text, p_source text, p_message text, p_details jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION pre_request()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  c jsonb := private.claims();
  r text := c ->> 'role';
  k text;
  v_bg bigint := nullif(c ->> 'bg', '')::bigint;
begin
  select kind into k from iam.db_role where role_name = r;
  if k is null then
    raise exception using errcode = 'PT403', message = 'role_not_allowed';
  end if;
  if k = 'anon' then
    if c ? 'sub' then
      raise exception using errcode = 'PT401', message = 'anon_with_subject';
    end if;
    return;
  end if;
  -- Only the capability roles the plan exposes through PostgREST may pass this
  -- gate. The owner, migrator, sealer, worker and other login roles can hold a
  -- valid session too, but they must never reach the PostgREST execution path.
  if k not in ('internal', 'external') then
    raise exception using errcode = 'PT403', message = 'role_not_allowed';
  end if;
  -- H-10 / R8.5: Synchronous denial. A break-glass session must satisfy at request time:
  -- session active AND break-glass activation active AND current timestamp < activation expiry.
  -- Even if physical session revocation has not yet run asynchronously, this gate immediately
  -- denies the request the exact moment the activation window closes.
  if v_bg is not null and v_bg <= extract(epoch from now())::bigint then
    raise exception using errcode = 'PT401', message = 'break_glass_expired';
  end if;
  if exists (
    select 1 from iam.break_glass_account b
     where b.user_id = (c ->> 'sub')::uuid
       and (
         (b.valid_until is not null and now() >= b.valid_until)
         or (c ->> 'src' = 'break_glass' and (b.valid_until is null or now() >= b.valid_until))
       )
  ) then
    raise exception using errcode = 'PT401', message = 'break_glass_expired';
  end if;
  if not exists (
    select 1
      from iam.session s
      join iam.app_user u on u.id = s.user_id
     where s.id = (c ->> 'sid')::uuid
       and s.user_id = (c ->> 'sub')::uuid
       and s.active_role = r
       and s.revoked_at is null
       and now() < s.idle_expires_at
       and now() < s.expires_at
       and u.status = 'active'
       and ((k = 'external' and u.kind = 'external')
         or (k = 'internal' and u.kind = 'internal' and exists (
               select 1 from iam.role_assignment a
                where a.user_id = u.id
                  and a.db_role = r
                  and a.revoked_at is null
                  and a.valid @> now())))
  ) then
    raise exception using errcode = 'PT401', message = 'session_invalid';
  end if;
end;
$$;

GRANT EXECUTE ON FUNCTION enqueue_security_alert(p_alert_type text, p_severity text, p_source text, p_message text, p_details jsonb) TO audit_sealer;

GRANT EXECUTE ON FUNCTION enqueue_security_alert(p_alert_type text, p_severity text, p_source text, p_message text, p_details jsonb) TO auth_gateway;

GRANT EXECUTE ON FUNCTION enqueue_security_alert(p_alert_type text, p_severity text, p_source text, p_message text, p_details jsonb) TO worker;

-- ===== schema: auth  (pgschema 1.13.4) =====

set local search_path = auth;

CREATE OR REPLACE FUNCTION break_glass_sweep_expired()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
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

REVOKE EXECUTE ON FUNCTION break_glass_sweep_expired() FROM PUBLIC;

CREATE OR REPLACE FUNCTION break_glass_drill_overdue()
RETURNS TABLE(user_id uuid, label text, last_drill_at timestamptz, days_since_drill integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
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

CREATE OR REPLACE FUNCTION break_glass_state(
    p_user_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
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

GRANT EXECUTE ON FUNCTION break_glass_sweep_expired() TO auth_gateway;

GRANT EXECUTE ON FUNCTION break_glass_sweep_expired() TO worker;

GRANT USAGE ON SCHEMA auth TO worker;
