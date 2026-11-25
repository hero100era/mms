-- Private helpers. These functions are referenced by policies and triggers in
-- later schemas, so the runner and plan database create them with
-- check_function_bodies = off.

create function private.claims()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;

create function private.claim(p_claim text)
returns text
language sql
stable
as $$
  select nullif(private.claims() ->> p_claim, '');
$$;

create function private.audit_source()
returns text
language sql
stable
set search_path = ''
as $$
  -- H-10: `src` names who acted. A break-glass claim only counts while its own
  -- window is open, so a captured token degrades to its unprivileged default
  -- (`web`, or `dba` for a request that carries no claims at all) instead of
  -- claiming break-glass authority in the audit trail after the fact.
  select coalesce(
    case when private.claims() ->> 'src' = 'break_glass'
          and (private.claims() ->> 'bg')::bigint > extract(epoch from now())::bigint
         then 'break_glass' end,
    private.claims() ->> 'src',
    case when private.claims() = '{}'::jsonb then 'dba' else 'web' end
  );
$$;

create function private.audit_redact(p_schema text, p_table text, p_row jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_row is null then null
    else coalesce(
      (select jsonb_object_agg(e.key,
         case when x.mode = 'mask' then to_jsonb('***'::text) else e.value end)
       from jsonb_each(p_row) as e(key, value)
       left join audit_trail.excluded_column x
         on x.schema_name = p_schema
        and x.table_name = p_table
        and x.column_name = e.key
       where x.mode is distinct from 'omit'),
      '{}'::jsonb)
  end;
$$;

create function private.change_log_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max_sealed xid8;
begin
  if tg_op = 'DELETE'
     and current_setting('mms.retention_purge_allowed', true) = 'true'
     and private.caller_role() in ('audit_sealer', 'worker', 'int_sysadmin', 'mms_owner', 'migrator', 'postgres') then
    select max(to_xid) into v_max_sealed from audit_trail.seal;
    if v_max_sealed is not null and old.tx_id < v_max_sealed then
      return old;
    end if;
  end if;
  raise exception 'audit_trail.change_log is append-only';
end;
$$;

create function private.event_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max_sealed xid8;
begin
  if tg_op = 'DELETE'
     and current_setting('mms.retention_purge_allowed', true) = 'true'
     and private.caller_role() in ('audit_sealer', 'worker', 'int_sysadmin', 'mms_owner', 'migrator', 'postgres') then
    select max(to_xid) into v_max_sealed from audit_trail.seal;
    if v_max_sealed is not null and old.tx_id < v_max_sealed then
      return old;
    end if;
  end if;
  raise exception 'audit_trail.event is append-only';
end;
$$;

create function private.audit_no_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception '%.% cannot be truncated', tg_table_schema, tg_table_name;
end;
$$;

revoke all on function private.audit_no_truncate() from public;

create function private.seal_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'audit_trail.seal is append-only';
end;
$$;

create function private.reconciliation_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'audit reconciliation records are append-only';
end;
$$;

create function private.crypto_shred_key_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'audit_trail.crypto_shred_key records cannot be deleted';
  end if;
  if tg_op = 'UPDATE' then
    if old.key_status = 'shredded' then
      raise exception 'shredded keys cannot be modified or restored';
    end if;
    if new.subject_id <> old.subject_id then
      raise exception 'subject_id is immutable';
    end if;
    if old.key_status = 'active' and new.key_status not in ('active', 'shredded') then
      raise exception 'crypto_shred_key status can only transition to shredded';
    end if;
    return new;
  end if;
  return new;
end;
$$;

create function private.retention_purge_run_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'audit_trail.retention_purge_run is append-only';
end;
$$;

create function private.audit_capture()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  c     jsonb := private.claims();
  h     jsonb := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  raw_o jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  raw_n jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_raw_key text := coalesce(raw_n ->> 'id', raw_o ->> 'id', raw_n ->> 'code', raw_o ->> 'code');
  v_row_id  uuid := case
    when v_raw_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then v_raw_key::uuid
    else null
  end;
  cols  text[];
begin
  if tg_op = 'UPDATE' then
    select array_agg(k.key order by k.key) into cols
      from jsonb_object_keys(raw_n) as k(key)
     where raw_n -> k.key is distinct from raw_o -> k.key
       and k.key not in ('updated_at', 'row_version');
    if cols is null then
      return null;
    end if;
  end if;

  insert into audit_trail.change_log (
    schema_name, table_name, op, row_id, row_key, old_row, new_row, changed_cols,
    actor_id, actor_label, db_role, session_id, auth_method, on_behalf_of, initiated_by,
    request_id, trace_id, source, client_ip, reason
  ) values (
    tg_table_schema, tg_table_name, left(tg_op, 1),
    v_row_id,
    v_raw_key,
    private.audit_redact(tg_table_schema, tg_table_name, raw_o),
    private.audit_redact(tg_table_schema, tg_table_name, raw_n),
    cols,
    nullif(c ->> 'sub', '')::uuid,
    c ->> 'name',
    coalesce(nullif(c ->> 'role', ''), private.caller_role()),
    nullif(c ->> 'sid', '')::uuid,
    c -> 'amr' ->> 0,
    nullif(current_setting('mms.on_behalf_of', true), '')::uuid,
    nullif(current_setting('mms.initiated_by', true), '')::uuid,
    h ->> 'x-request-id',
    split_part(h ->> 'traceparent', '-', 2),
    private.audit_source(),
    nullif(h ->> 'x-client-ip', '')::inet,
    nullif(current_setting('mms.reason', true), '')
  );
  return null;
end;
$$;

create function private.set_change_context(p_reason text, p_on_behalf_of uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required';
  end if;
  if p_on_behalf_of is not null and not exists (
    select 1 from party.organization where id = p_on_behalf_of
  ) then
    raise exception 'invalid_on_behalf_of' using errcode = '22023';
  end if;
  perform set_config('mms.reason', p_reason, true);
  perform set_config('mms.on_behalf_of', coalesce(p_on_behalf_of::text, ''), true);
end;
$$;

revoke all on function private.claims() from public;
revoke all on function private.audit_source() from public;
revoke all on function private.claim(text) from public;
revoke all on function private.audit_redact(text, text, jsonb) from public;
revoke all on function private.change_log_append_only() from public;
revoke all on function private.event_append_only() from public;
revoke all on function private.seal_append_only() from public;
revoke all on function private.reconciliation_append_only() from public;
revoke all on function private.crypto_shred_key_guard() from public;
revoke all on function private.retention_purge_run_append_only() from public;
revoke all on function private.audit_capture() from public;
revoke all on function private.set_change_context(text, uuid) from public;

grant execute on function private.claims() to int_compliance, int_sysadmin, int_manager;
grant execute on function private.claim(text) to int_compliance, int_sysadmin, int_manager;
grant execute on function private.set_change_context(text, uuid) to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

create function private.org_unit_tree_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent_type text;
  v_parent_level int;
  v_parent_path extensions.ltree;
  v_parent_code text;
  v_label text;
  v_cycle boolean;
begin
  v_label := coalesce(
    nullif(regexp_replace(new.code, '[^A-Za-z0-9_]', '_', 'g'), ''),
    replace(new.id::text, '-', '_')
  );

  if new.parent_id is null then
    if new.unit_type <> 'head_office' then
      raise exception 'org_unit_parent_required';
    end if;
    new.level := 0;
    new.path := v_label::extensions.ltree;
  else
    if new.unit_type = 'head_office' then
      raise exception 'org_unit_head_office_has_no_parent';
    end if;

    select unit_type, level, path, code
      into v_parent_type, v_parent_level, v_parent_path, v_parent_code
      from core.org_unit
     where id = new.parent_id;

    if v_parent_type is null then
      raise exception 'org_unit_parent_not_found';
    end if;

    if not (
      (v_parent_type = 'head_office' and new.unit_type in
        ('ho_department', 'regional_office', 'plan_approval_centre', 'mts_centre'))
      or (v_parent_type = 'regional_office' and new.unit_type = 'station')
    ) then
      raise exception 'org_unit_invalid_parent_type: % under %', new.unit_type, v_parent_type;
    end if;

    with recursive ancestors(id) as (
      select new.parent_id
      union
      select u.parent_id
        from core.org_unit u
        join ancestors a on u.id = a.id
       where u.parent_id is not null
    )
    select exists (select 1 from ancestors where id = new.id) into v_cycle;

    if v_cycle then
      raise exception 'org_unit_cycle';
    end if;

    new.level := coalesce(v_parent_level, 0) + 1;
    if v_parent_path is null then
      v_parent_path := coalesce(
        nullif(regexp_replace(v_parent_code, '[^A-Za-z0-9_]', '_', 'g'), ''),
        replace(new.parent_id::text, '-', '_')
      )::extensions.ltree;
    end if;
    new.path := v_parent_path operator(extensions.||) v_label::extensions.ltree;
  end if;

  if new.unit_type in ('regional_office', 'station', 'mts_centre') and new.region_code is null then
    raise exception 'org_unit_region_required';
  end if;

  return new;
end;
$$;

create function private.org_unit_path_cascade()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.path::text is distinct from new.path::text or old.level is distinct from new.level then
    update core.org_unit
       set parent_id = parent_id
     where parent_id = new.id;
  end if;
  return null;
end;
$$;

-- True when the caller's active role is the sysadmin role. This is the
-- symmetric companion to assert_sysadmin(): the org functions branch on it to
-- pick the unconditional sysadmin path or the delegated, scope-limited one
-- (ADR-0018), so a delegated caller can be told `unauthorised` rather than the
-- body running the wrong branch.
create function private.is_sysadmin()
returns boolean
language sql
stable
as $$
  select coalesce(private.claim('role'), '') = 'int_sysadmin';
$$;

revoke all on function private.is_sysadmin() from public;
grant execute on function private.is_sysadmin() to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

create function private.assert_sysadmin()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if coalesce(private.claim('role'), '') <> 'int_sysadmin' then
    raise exception 'insufficient_authority' using errcode = '42501';
  end if;
  perform set_config('mms.authority_title', 'System Administrator', true);
  perform set_config('mms.authority_unit_id', coalesce((select id::text from core.org_unit where unit_type = 'head_office' limit 1), ''), true);
end;
$$;

create function private.emit_event(
  p_event_type text,
  p_outcome text,
  p_subject_type text,
  p_subject_id uuid,
  p_scope_unit_id uuid,
  p_reason text,
  p_detail jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c jsonb := private.claims();
  h jsonb := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  v_reason_required boolean;
  v_reason text := coalesce(p_reason, nullif(current_setting('mms.reason', true), ''));
  v_on_behalf_of uuid := nullif(current_setting('mms.on_behalf_of', true), '')::uuid;
  v_authority_rule_id uuid := coalesce((p_detail ->> 'authority_rule_id')::uuid, nullif(current_setting('mms.authority_rule_id', true), '')::uuid);
  v_actor_title text := coalesce(nullif(current_setting('mms.authority_title', true), ''), c ->> 'title');
  v_actor_grade int := coalesce(nullif(current_setting('mms.authority_grade', true), '')::int, nullif(c ->> 'grade', '')::int);
  v_actor_unit_id uuid := coalesce(nullif(current_setting('mms.authority_unit_id', true), '')::uuid, nullif(c ->> 'org_unit_id', '')::uuid);
  v_pos record;
begin
  select reason_required into v_reason_required
    from audit_trail.event_type
   where code = p_event_type;
  if not found then
    raise exception 'invalid_event_type: %', p_event_type using errcode = '22023';
  end if;

  if v_reason_required and (v_reason is null or btrim(v_reason) = '') then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  if v_on_behalf_of is not null and not exists (
    select 1 from party.organization where id = v_on_behalf_of
  ) then
    raise exception 'invalid_on_behalf_of' using errcode = '22023';
  end if;

  if v_actor_title is null or v_actor_grade is null or v_actor_unit_id is null then
    select p.job_title_code, t.grade, p.unit_id
      into v_pos
      from iam.staff_position p
      join iam.job_title t on t.code = p.job_title_code
     where p.user_id = nullif(c ->> 'sub', '')::uuid
       and p.valid @> now()
     limit 1;
    if found then
      v_actor_title := coalesce(v_actor_title, v_pos.job_title_code);
      v_actor_grade := coalesce(v_actor_grade, v_pos.grade);
      v_actor_unit_id := coalesce(v_actor_unit_id, v_pos.unit_id);
    end if;
  end if;

  if coalesce(nullif(c ->> 'role', ''), private.caller_role()) = 'int_sysadmin' then
    v_actor_title := coalesce(v_actor_title, 'System Administrator');
    if v_actor_unit_id is null then
      select id into v_actor_unit_id from core.org_unit where unit_type = 'head_office' limit 1;
    end if;
  end if;

  insert into audit_trail.event (
    event_type, outcome, actor_id, session_id, db_role, auth_method,
    on_behalf_of, initiated_by, actor_title, actor_grade, actor_unit_id,
    authority_rule_id, subject_type, subject_id, scope_unit_id,
    request_id, trace_id, source, client_ip, reason, detail
  ) values (
    p_event_type,
    p_outcome,
    nullif(c ->> 'sub', '')::uuid,
    nullif(c ->> 'sid', '')::uuid,
    coalesce(nullif(c ->> 'role', ''), private.caller_role()),
    c -> 'amr' ->> 0,
    v_on_behalf_of,
    nullif(current_setting('mms.initiated_by', true), '')::uuid,
    v_actor_title,
    v_actor_grade,
    v_actor_unit_id,
    v_authority_rule_id,
    p_subject_type,
    p_subject_id,
    p_scope_unit_id,
    h ->> 'x-request-id',
    split_part(h ->> 'traceparent', '-', 2),
    private.audit_source(),
    nullif(h ->> 'x-client-ip', '')::inet,
    v_reason,
    p_detail
  );

  perform set_config('mms.authority_rule_id', '', true);
  perform set_config('mms.authority_title', '', true);
  perform set_config('mms.authority_grade', '', true);
  perform set_config('mms.authority_unit_id', '', true);
  perform set_config('mms.reason', '', true);
  perform set_config('mms.on_behalf_of', '', true);
end;
$$;

revoke all on function private.org_unit_tree_check() from public;
revoke all on function private.org_unit_path_cascade() from public;
revoke all on function private.assert_sysadmin() from public;

-- R1.1: `emit_event` is called only from within other SECURITY DEFINER functions
-- and from the audit-capture trigger. No capability role may call it directly: a
-- direct caller supplies its own `request.jwt.claims`, so a granted `int_sysadmin`
-- could stamp any `db_role` (e.g. `worker`) onto the audit trail. The trigger and
-- the definer bodies run as `mms_owner`, so the owner-only grant is sufficient.
revoke all on function private.emit_event(text, text, text, uuid, uuid, text, jsonb) from public;
revoke all on function private.emit_event(text, text, text, uuid, uuid, text, jsonb) from int_compliance, int_sysadmin;

