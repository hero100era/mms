-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION assert_sysadmin()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if coalesce(private.claim('role'), '') <> 'int_sysadmin' then
    raise exception 'insufficient_authority' using errcode = '42501';
  end if;
  perform set_config('mms.authority_title', 'System Administrator', true);
  perform set_config('mms.authority_unit_id', coalesce((select id::text from core.org_unit where unit_type = 'head_office' limit 1), ''), true);
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

  if coalesce(nullif(c ->> 'role', ''), session_user) = 'int_sysadmin' then
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
    coalesce(nullif(c ->> 'role', ''), session_user),
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
    coalesce(c ->> 'src', 'web'),
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

-- ===== schema: core  (pgschema 1.13.4) =====

set local search_path = core;

CREATE OR REPLACE TRIGGER org_unit_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON org_unit
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER org_unit_coverage_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON org_unit_coverage
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER routing_rule_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON routing_rule
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

-- ===== schema: party  (pgschema 1.13.4) =====

set local search_path = party;

CREATE OR REPLACE TRIGGER organization_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON organization
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

-- ===== schema: iam  (pgschema 1.13.4) =====

set local search_path = iam;

CREATE OR REPLACE TRIGGER app_user_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON app_user
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER one_time_token_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON one_time_token
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER org_membership_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON org_membership
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER password_credential_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON password_credential
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER role_assignment_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON role_assignment
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER staff_position_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON staff_position
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER user_identity_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON user_identity
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION staff_position_close(
    p_user_id uuid,
    p_reason text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_unit uuid;
begin
  perform private.assert_authority('hr.position.set');
  if p_user_id = private.uid() then
    raise exception 'cannot_close_own_position' using errcode = '42501';
  end if;
  perform private.set_change_context(p_reason);

  select unit_id into v_unit from iam.staff_position
   where user_id = p_user_id and valid @> now() for update;
  if not found then
    raise exception 'current_position_not_found';
  end if;

  perform private.assert_in_scope(v_unit);

  update iam.staff_position
     set valid = tstzrange(lower(valid), now())
   where user_id = p_user_id and valid @> now();

  update iam.role_assignment
     set revoked_at = now(), revoked_by = private.uid(), revoke_reason = p_reason
   where user_id = p_user_id and source = 'position' and revoked_at is null;

  if not exists (
    select 1 from iam.role_assignment
     where user_id = p_user_id and revoked_at is null and valid @> now()
  ) then
    update iam.app_user set status = 'suspended' where id = p_user_id and status = 'active';
  end if;

  perform private.emit_event(
    'iam.position.closed', 'success', 'app_user', p_user_id, v_unit, p_reason, '{}'::jsonb);
end;
$$;
