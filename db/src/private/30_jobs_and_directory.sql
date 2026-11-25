
create function private.job_poll(p_limit int default 10)
returns table(id uuid, kind text, payload jsonb, attempts int, enqueued_by uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_worker() then
    raise exception 'worker_role_required' using errcode = '42501';
  end if;

  -- A job that another instance has already claimed (`processing`) or finished
  -- (`done`) must never be handed out twice: `job_begin` has already bumped
  -- `attempts` and set the worker context, so re-processing would re-send the
  -- invite mail and double the audit attribution. Only terminal states are
  -- retried, and `failed` is terminal here (a human re-queues it).
  --
  -- R7.2: durable outbox leasing with `FOR UPDATE SKIP LOCKED`.
  -- Reclaims orphaned jobs whose lease has expired.
  return query
  select o.id, o.kind, o.payload, o.attempts, o.enqueued_by
    from core.outbox o
   where ((o.status = 'pending' and o.next_at <= now())
          or (o.status = 'processing' and o.lease_expires_at is not null and o.lease_expires_at < now()))
   order by o.next_at, o.created_at
   limit coalesce(p_limit, 10)
     for update skip locked;
end;
$$;

create function private.job_begin(
  p_job_id uuid,
  p_lease_seconds int default 60,
  p_worker_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job core.outbox;
  v_worker_id uuid;
  v_worker_name text;
  v_worker_tag text;
begin
  if not private.is_worker() then
    raise exception 'worker_role_required' using errcode = '42501';
  end if;

  select id, display_name into v_worker_id, v_worker_name
    from iam.app_user
   where kind = 'service' and service_name = 'worker' and status = 'active';

  if v_worker_id is null then
    insert into iam.app_user (id, kind, display_name, service_name, status)
    values ('00000000-0000-0000-0000-000000000001', 'service', 'Outbox Worker', 'worker', 'active')
    on conflict (service_name) do update set status = 'active'
    returning id, display_name into v_worker_id, v_worker_name;
  end if;

  select * into v_job
    from core.outbox
   where id = p_job_id
     for update;

  if not found then
    raise exception 'job_not_found';
  end if;

  if v_job.status <> 'pending' and not (v_job.status = 'processing' and v_job.lease_expires_at < now()) then
    raise exception 'job_not_pending' using errcode = '55P03';
  end if;

  v_worker_tag := coalesce(p_worker_id, v_worker_id::text);

  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub', v_worker_id::text,
      'name', coalesce(v_worker_name, 'worker'),
      'role', 'worker',
      'src', 'job'
    )::text, true);

  if v_job.enqueued_by is not null then
    perform set_config('mms.initiated_by', v_job.enqueued_by::text, true);
  else
    perform set_config('mms.initiated_by', '', true);
  end if;

  update core.outbox
     set status = 'processing',
         attempts = attempts + 1,
         lease_expires_at = now() + (greatest(coalesce(p_lease_seconds, 60), 1) || ' seconds')::interval,
         leased_by = v_worker_tag
   where id = p_job_id
  returning * into v_job;

  return jsonb_build_object(
    'id', v_job.id,
    'kind', v_job.kind,
    'payload', v_job.payload,
    'status', v_job.status,
    'attempts', v_job.attempts,
    'max_attempts', v_job.max_attempts,
    'lease_expires_at', v_job.lease_expires_at,
    'leased_by', v_job.leased_by,
    'enqueued_by', v_job.enqueued_by,
    'created_at', v_job.created_at
  );
end;
$$;

create function private.job_complete(
  p_job_id uuid,
  p_status text default 'done',
  p_error text default null,
  p_error_class text default null,
  p_retry_delay_seconds int default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job core.outbox;
  v_worker_id uuid;
  v_worker_name text;
  v_retry_delay int;
begin
  if not private.is_worker() then
    raise exception 'worker_role_required' using errcode = '42501';
  end if;

  if p_status not in ('done', 'failed', 'dead_letter', 'retry') then
    raise exception 'invalid_job_status' using errcode = '22023';
  end if;

  select * into v_job
    from core.outbox
   where id = p_job_id and status = 'processing'
     for update;

  if not found then
    raise exception 'job_not_processing';
  end if;

  select id, display_name into v_worker_id, v_worker_name
    from iam.app_user
   where kind = 'service' and service_name = 'worker' and status = 'active';

  if v_worker_id is not null then
    perform set_config('request.jwt.claims',
      jsonb_build_object(
        'sub', v_worker_id::text,
        'name', coalesce(v_worker_name, 'worker'),
        'role', 'worker',
        'src', 'job'
      )::text, true);
  end if;

  if v_job.enqueued_by is not null then
    perform set_config('mms.initiated_by', v_job.enqueued_by::text, true);
  end if;

  if p_status = 'done' then
    update core.outbox
       set status = 'done',
           lease_expires_at = null,
           leased_by = null
     where id = p_job_id;
  elsif p_status = 'dead_letter' then
    update core.outbox
       set status = 'dead_letter',
           lease_expires_at = null,
           leased_by = null,
           last_error_class = coalesce(p_error_class, 'terminal'),
           payload = case
             when p_error is not null then jsonb_set(payload, '{error}', to_jsonb(p_error))
             else payload
           end
     where id = p_job_id;
  elsif p_status = 'retry' then
    if v_job.attempts >= v_job.max_attempts or coalesce(p_error_class, '') = 'fatal' then
      update core.outbox
         set status = 'dead_letter',
             lease_expires_at = null,
             leased_by = null,
             last_error_class = coalesce(p_error_class, 'max_attempts_exceeded'),
             payload = case
               when p_error is not null then jsonb_set(payload, '{error}', to_jsonb(p_error))
               else payload
             end
       where id = p_job_id;
    else
      v_retry_delay := coalesce(p_retry_delay_seconds, least(300, (5 * power(2, greatest(v_job.attempts - 1, 0)))::int));
      update core.outbox
         set status = 'pending',
             next_at = now() + (v_retry_delay || ' seconds')::interval,
             lease_expires_at = null,
             leased_by = null,
             last_error_class = coalesce(p_error_class, 'transient'),
             payload = case
               when p_error is not null then jsonb_set(payload, '{error}', to_jsonb(p_error))
               else payload
             end
       where id = p_job_id;
    end if;
  elsif p_status = 'failed' then
    update core.outbox
       set status = 'failed',
           lease_expires_at = null,
           leased_by = null,
           last_error_class = coalesce(p_error_class, 'unhandled'),
           payload = case
             when p_error is not null then jsonb_set(payload, '{error}', to_jsonb(p_error))
             else payload
           end
     where id = p_job_id;
  end if;
end;
$$;

create function private.job_heartbeat(
  p_job_id uuid,
  p_extend_seconds int default 60
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_worker() then
    raise exception 'worker_role_required' using errcode = '42501';
  end if;

  update core.outbox
     set lease_expires_at = now() + (greatest(coalesce(p_extend_seconds, 60), 1) || ' seconds')::interval
   where id = p_job_id
     and status = 'processing';

  if not found then
    raise exception 'job_not_processing';
  end if;
end;
$$;

revoke all on function private.job_poll(int) from public;
revoke all on function private.job_begin(uuid, int, text) from public;
revoke all on function private.job_complete(uuid, text, text, text, int) from public;
revoke all on function private.job_heartbeat(uuid, int) from public;

grant usage on schema private to worker;
grant execute on function private.job_poll(int) to worker;
grant execute on function private.job_begin(uuid, int, text) to worker;
grant execute on function private.job_complete(uuid, text, text, text, int) to worker;
grant execute on function private.job_heartbeat(uuid, int) to worker;

-- R8.5: Transactional security alert enqueuing into core.outbox.
-- Security-critical events (break-glass, seal failure, reconciliation discrepancy,
-- malware, WORM corruption) commit transactionally with this function, delegating
-- delivery to the durable outbox lease/retry/dead-letter processor.
create function private.enqueue_security_alert(
  p_alert_type text,
  p_severity text,
  p_source text,
  p_message text,
  p_details jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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

revoke all on function private.enqueue_security_alert(text, text, text, text, jsonb) from public;
grant execute on function private.enqueue_security_alert(text, text, text, text, jsonb) to audit_sealer, worker, auth_gateway;

create function private.user_directory_grade(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when private.active_role() = 'int_hr' then t.grade
    when p_user_id = private.uid() then t.grade
    when p_user_id in (select private.my_reports()) then t.grade
    else null
  end
  from iam.staff_position p
  join iam.job_title t on t.code = p.job_title_code
  where p.user_id = p_user_id
    and p.valid @> now()
  order by upper(p.valid) nulls last
  limit 1;
$$;

create function private.is_internal_caller()
returns boolean
language sql
stable
as $$
  select coalesce(private.active_role(), '') in (
    'int_viewer', 'int_surveyor', 'int_auditor', 'int_coordinator',
    'int_manager', 'int_compliance', 'int_hr', 'int_finance', 'int_sysadmin'
  );
$$;

create function private.user_directory_line_manager(p_user_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when private.is_internal_caller() then p.line_manager_id
    else null
  end
  from iam.staff_position p
  where p.user_id = p_user_id
    and p.valid @> now()
  order by upper(p.valid) nulls last
  limit 1;
$$;

create function private.org_chart_direct_reports_count(p_user_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when private.is_internal_caller() then (
      select count(*)
        from iam.staff_position p
        join iam.app_user u on u.id = p.user_id
       where p.line_manager_id = p_user_id
         and p.valid @> now()
         and u.kind = 'internal'
         and u.status in ('active', 'invited')
    )
    else 0::bigint
  end;
$$;

revoke all on function private.is_internal_caller() from public;
revoke all on function private.user_directory_grade(uuid) from public;
revoke all on function private.user_directory_line_manager(uuid) from public;
revoke all on function private.org_chart_direct_reports_count(uuid) from public;

grant execute on function private.is_internal_caller() to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant execute on function private.user_directory_grade(uuid) to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant execute on function private.user_directory_line_manager(uuid) to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant execute on function private.org_chart_direct_reports_count(uuid) to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;
