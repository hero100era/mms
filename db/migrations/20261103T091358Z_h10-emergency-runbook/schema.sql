-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION audit_source()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
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

CREATE OR REPLACE FUNCTION audit_capture()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  c     jsonb := private.claims();
  h     jsonb := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  raw_o jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  raw_n jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
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
    schema_name, table_name, op, row_id, old_row, new_row, changed_cols,
    actor_id, actor_label, db_role, session_id, auth_method, on_behalf_of, initiated_by,
    request_id, trace_id, source, client_ip, reason
  ) values (
    tg_table_schema, tg_table_name, left(tg_op, 1),
    coalesce(raw_n ->> 'id', raw_o ->> 'id')::uuid,
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

CREATE OR REPLACE FUNCTION emit_event(
    p_event_type text,
    p_outcome text,
    p_subject_type text,
    p_subject_id uuid,
    p_scope_unit_id uuid,
    p_reason text,
    p_detail jsonb DEFAULT '{}'
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
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

-- ===== schema: audit_trail  (pgschema 1.13.4) =====

set local search_path = audit_trail;

ALTER TABLE change_log DROP CONSTRAINT change_log_source_ck;

ALTER TABLE audit_trail.change_log
ADD CONSTRAINT change_log_source_ck CHECK (source IN ('web'::text, 'job'::text, 'import'::text, 'integration'::text, 'dba'::text, 'break_glass'::text)) NOT VALID;

ALTER TABLE audit_trail.change_log VALIDATE CONSTRAINT change_log_source_ck;

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION emergency_reenable_break_glass(
    p_user_id uuid,
    p_operator text,
    p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_changed int;
begin
  if coalesce(private.caller_role(), '') <> 'mms_emergency' then
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
  get diagnostics v_changed = rowcount;
  return v_changed > 0;
end;
$$;

CREATE OR REPLACE FUNCTION emergency_revoke_assignment(
    p_assignment_id uuid,
    p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user uuid;
  v_changed boolean;
begin
  if coalesce(private.caller_role(), '') <> 'mms_emergency' then
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
  get diagnostics v_changed = rowcount;
  return v_changed > 0;
end;
$$;

CREATE OR REPLACE FUNCTION emergency_revoke_sessions(
    p_user_id uuid,
    p_reason text
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_changed int;
begin
  if coalesce(private.caller_role(), '') <> 'mms_emergency' then
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
  get diagnostics v_changed = rowcount;
  return v_changed;
end;
$$;

CREATE OR REPLACE FUNCTION emergency_suspend_user(
    p_user_id uuid,
    p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_changed boolean;
begin
  if coalesce(private.caller_role(), '') <> 'mms_emergency' then
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
  get diagnostics v_changed = rowcount;
  return v_changed;
end;
$$;

REVOKE EXECUTE ON FUNCTION emergency_reenable_break_glass(p_user_id uuid, p_operator text, p_reason text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION emergency_revoke_assignment(p_assignment_id uuid, p_reason text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION emergency_revoke_sessions(p_user_id uuid, p_reason text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION emergency_suspend_user(p_user_id uuid, p_reason text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION emergency_reenable_break_glass(p_user_id uuid, p_operator text, p_reason text) TO mms_emergency;

GRANT EXECUTE ON FUNCTION emergency_revoke_assignment(p_assignment_id uuid, p_reason text) TO mms_emergency;

GRANT EXECUTE ON FUNCTION emergency_revoke_sessions(p_user_id uuid, p_reason text) TO mms_emergency;

GRANT EXECUTE ON FUNCTION emergency_suspend_user(p_user_id uuid, p_reason text) TO mms_emergency;
