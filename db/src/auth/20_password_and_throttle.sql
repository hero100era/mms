create function auth.password_lookup(p_login_name text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object('user_id', u.id, 'hash', c.hash, 'status', u.status)
       from iam.app_user u
       left join iam.password_credential c on c.user_id = u.id
      where u.kind = 'external'
        and u.email = lower(p_login_name)
        and u.status in ('invited', 'active', 'suspended')),
    jsonb_build_object('status', 'unknown')
  );
$$;

create function auth.is_throttled(
  p_login_name text,
  p_ip inet,
  p_window interval default interval '15 minutes',
  p_max_attempts int default 5
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) >= p_max_attempts
    from iam.login_attempt a
   where a.at > now() - p_window
     and a.outcome = 'failure'
     and (a.login_name = lower(p_login_name) or a.client_ip = p_ip);
$$;

create function auth.record_attempt(
  p_login_name text,
  p_ip inet,
  p_outcome text,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_count int;
begin
  insert into iam.login_attempt (login_name, client_ip, outcome, reason)
  values (lower(p_login_name), p_ip, p_outcome, p_reason);

  if p_outcome = 'failure' then
    select count(*) into v_count
      from iam.login_attempt a
     where a.at > now() - interval '15 minutes'
       and a.outcome = 'failure'
       and (a.login_name = lower(p_login_name) or a.client_ip = p_ip);

    if v_count = 5 then
      select id into v_user_id
        from iam.app_user
       where email = lower(p_login_name)
         and kind = 'external'
         and status <> 'deactivated';

      perform auth.log_event(
        'auth.lockout',
        'failure',
        v_user_id,
        jsonb_build_object(
          'login_name', lower(p_login_name),
          'client_ip', p_ip::text,
          'reason', coalesce(p_reason, 'too_many_failures')
        )
      );
    end if;
  end if;
end;
$$;

-- R2-H01: Multi-replica step-up throttle functions (dedicated namespace isolated
-- from iam.login_attempt).
create function auth.step_up_status(
  p_user_id text,
  p_ip text,
  p_session_id text default null,
  p_window interval default interval '15 minutes',
  p_max_attempts int default 5
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cutoff timestamptz := now() - p_window;
  v_user_count int;
  v_user_oldest timestamptz;
  v_ip_count int;
  v_ip_oldest timestamptz;
  v_sess_count int := 0;
  v_sess_oldest timestamptz := null;
  v_throttled boolean := false;
  v_oldest_throttled timestamptz := null;
  v_retry_after int := 60;
begin
  select count(*), min(a.at)
    into v_user_count, v_user_oldest
    from iam.step_up_attempt a
   where a.user_id = p_user_id
     and a.outcome = 'failure'
     and a.at > v_cutoff;

  select count(*), min(a.at)
    into v_ip_count, v_ip_oldest
    from iam.step_up_attempt a
   where a.user_id = p_user_id
     and a.client_ip = p_ip
     and a.outcome = 'failure'
     and a.at > v_cutoff;

  if p_session_id is not null then
    select count(*), min(a.at)
      into v_sess_count, v_sess_oldest
      from iam.step_up_attempt a
     where a.user_id = p_user_id
       and a.session_id = p_session_id
       and a.outcome = 'failure'
       and a.at > v_cutoff;
  end if;

  if v_user_count >= p_max_attempts then
    v_throttled := true;
    v_oldest_throttled := coalesce(least(v_oldest_throttled, v_user_oldest), v_user_oldest);
  end if;
  if v_ip_count >= p_max_attempts then
    v_throttled := true;
    v_oldest_throttled := coalesce(least(v_oldest_throttled, v_ip_oldest), v_ip_oldest);
  end if;
  if p_session_id is not null and v_sess_count >= p_max_attempts then
    v_throttled := true;
    v_oldest_throttled := coalesce(least(v_oldest_throttled, v_sess_oldest), v_sess_oldest);
  end if;

  if v_throttled and v_oldest_throttled is not null then
    v_retry_after := greatest(1, ceil(extract(epoch from (v_oldest_throttled + p_window - now())))::int);
  end if;

  return jsonb_build_object(
    'throttled', v_throttled,
    'retry_after', v_retry_after
  );
end;
$$;

create function auth.step_up_record(
  p_user_id text,
  p_ip text,
  p_success boolean,
  p_session_id text default null,
  p_window interval default interval '15 minutes'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_success then
    delete from iam.step_up_attempt
     where user_id = p_user_id
       and outcome = 'failure';
    return;
  end if;

  insert into iam.step_up_attempt (user_id, client_ip, session_id, outcome)
  values (p_user_id, p_ip, p_session_id, 'failure');

  -- Opportunistic cleanup of expired step-up throttle records
  delete from iam.step_up_attempt
   where at < now() - (p_window * 2);
end;
$$;

create function auth.step_up_clear(p_user_id text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null then
    delete from iam.step_up_attempt;
  else
    delete from iam.step_up_attempt where user_id = p_user_id;
  end if;
end;
$$;

revoke all on function auth.step_up_status(text, text, text, interval, int) from public;
revoke all on function auth.step_up_record(text, text, boolean, text, interval) from public;
revoke all on function auth.step_up_clear(text) from public;

grant execute on function auth.step_up_status(text, text, text, interval, int) to auth_gateway;
grant execute on function auth.step_up_record(text, text, boolean, text, interval) to auth_gateway;
grant execute on function auth.step_up_clear(text) to auth_gateway;
