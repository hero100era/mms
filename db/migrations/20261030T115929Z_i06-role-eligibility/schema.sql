-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION assert_role_eligible(
    p_user_id uuid,
    p_db_role text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if p_db_role = 'int_sysadmin' then
    return;
  end if;
  if exists (
    select 1
      from iam.staff_position p
      join core.org_unit u on u.id = p.unit_id
      join iam.default_role_rule r on r.db_role = p_db_role
     where p.user_id = p_user_id
       and p.valid @> now()
       and (r.unit_type is null or r.unit_type = u.unit_type)
       and (r.unit_function is null or r.unit_function = u.function_code)
       and (r.job_family is null or r.job_family = p.job_family)
       and p.grade between r.min_grade and r.max_grade
  ) then
    return;
  end if;
  perform private.emit_event(
    'authz.denied.insufficient_authority', 'denied', 'app_user', p_user_id, null, null,
    jsonb_build_object('role', p_db_role, 'reason', 'role_not_eligible'));
  raise exception 'role_not_eligible' using errcode = '42501';
end;
$$;

REVOKE EXECUTE ON FUNCTION assert_role_eligible(p_user_id uuid, p_db_role text) FROM PUBLIC;

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION role_assignment_grant(
    p_user_id uuid,
    p_db_role text,
    p_scope_type text,
    p_scope_unit_id uuid,
    p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_id uuid;
begin
  perform private.assert_sysadmin();
  if p_user_id = private.uid() then
    raise exception 'cannot_grant_self' using errcode = '42501';
  end if;
  perform private.assert_role_eligible(p_user_id, p_db_role);
  perform private.set_change_context(p_reason);

  insert into iam.role_assignment
    (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
  values
    (p_user_id, 'internal', p_db_role, p_scope_type, p_scope_unit_id, 'manual', private.uid(), p_reason)
  returning id into v_id;

  perform private.emit_event(
    'iam.assignment.granted', 'success', 'app_user', p_user_id, p_scope_unit_id, p_reason,
    jsonb_build_object('db_role', p_db_role, 'scope_type', p_scope_type, 'assignment_id', v_id));
  return v_id;
end;
$$;
