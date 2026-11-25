-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION assert_authority(
    p_action_code text,
    p_amount numeric DEFAULT NULL
)
RETURNS TABLE(rule_id uuid, title text, grade integer, unit_id uuid, unit_type text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_position record;
  v_rule record;
begin
  select * into v_position from private.my_position();
  if not found then
    perform private.emit_event(
      'authz.denied.insufficient_authority', 'denied', 'authority_rule', null, null, null,
      jsonb_build_object('action', p_action_code, 'role', private.active_role(), 'reason', 'no_position'));
    raise exception 'insufficient_authority' using errcode = '42501';
  end if;

  select r.id, r.min_grade, r.max_amount
    into v_rule
    from iam.authority_rule r
   where r.action_code = p_action_code
     and r.db_role = private.active_role()
     and (r.job_family is null or r.job_family = v_position.job_family)
     and (r.unit_type is null or r.unit_type = v_position.unit_type)
     and v_position.grade >= r.min_grade
     and r.valid @> now()
     and (r.max_amount is null or (p_amount is not null and p_amount <= r.max_amount))
   order by r.min_grade desc, r.max_amount nulls first
   limit 1;

  if not found then
    perform private.emit_event(
      'authz.denied.insufficient_authority', 'denied', 'authority_rule', null,
      v_position.unit_id, null,
      jsonb_build_object(
        'action', p_action_code,
        'role', private.active_role(),
        'title', v_position.job_title_code,
        'grade', v_position.grade,
        'unit_type', v_position.unit_type,
        'amount', p_amount));
    raise exception 'insufficient_authority' using errcode = '42501';
  end if;

  return query select v_rule.id, v_position.job_title_code, v_position.grade,
                      v_position.unit_id, v_position.unit_type;
end;
$$;

CREATE OR REPLACE FUNCTION assert_in_scope(
    p_unit_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if p_unit_id is null then
    raise exception 'unit_required' using errcode = '22023';
  end if;
  if p_unit_id = any (private.my_units())
     or p_unit_id = any (private.my_offices()) then
    return;
  end if;
  perform private.emit_event(
    'authz.denied.out_of_scope', 'denied', 'org_unit', p_unit_id, p_unit_id, null,
    jsonb_build_object('role', private.active_role()));
  raise exception 'out_of_scope' using errcode = '42501';
end;
$$;

REVOKE EXECUTE ON FUNCTION assert_authority(p_action_code text, p_amount numeric) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION assert_in_scope(p_unit_id uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION assert_authority(p_action_code text, p_amount numeric) TO int_auditor;

GRANT EXECUTE ON FUNCTION assert_authority(p_action_code text, p_amount numeric) TO int_compliance;

GRANT EXECUTE ON FUNCTION assert_authority(p_action_code text, p_amount numeric) TO int_coordinator;

GRANT EXECUTE ON FUNCTION assert_authority(p_action_code text, p_amount numeric) TO int_finance;

GRANT EXECUTE ON FUNCTION assert_authority(p_action_code text, p_amount numeric) TO int_hr;

GRANT EXECUTE ON FUNCTION assert_authority(p_action_code text, p_amount numeric) TO int_manager;

GRANT EXECUTE ON FUNCTION assert_authority(p_action_code text, p_amount numeric) TO int_surveyor;

GRANT EXECUTE ON FUNCTION assert_authority(p_action_code text, p_amount numeric) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION assert_authority(p_action_code text, p_amount numeric) TO int_viewer;

GRANT EXECUTE ON FUNCTION assert_in_scope(p_unit_id uuid) TO int_auditor;

GRANT EXECUTE ON FUNCTION assert_in_scope(p_unit_id uuid) TO int_compliance;

GRANT EXECUTE ON FUNCTION assert_in_scope(p_unit_id uuid) TO int_coordinator;

GRANT EXECUTE ON FUNCTION assert_in_scope(p_unit_id uuid) TO int_finance;

GRANT EXECUTE ON FUNCTION assert_in_scope(p_unit_id uuid) TO int_hr;

GRANT EXECUTE ON FUNCTION assert_in_scope(p_unit_id uuid) TO int_manager;

GRANT EXECUTE ON FUNCTION assert_in_scope(p_unit_id uuid) TO int_surveyor;

GRANT EXECUTE ON FUNCTION assert_in_scope(p_unit_id uuid) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION assert_in_scope(p_unit_id uuid) TO int_viewer;

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION my_assignments()
RETURNS TABLE(id uuid, db_role text, scope_type text, scope_unit_id uuid, source text, valid tstzrange)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select a.id, a.db_role, a.scope_type, a.scope_unit_id, a.source, a.valid
    from iam.role_assignment a
   where a.user_id = private.uid()
     and a.revoked_at is null
     and a.valid @> now()
   order by a.db_role;
$$;

CREATE OR REPLACE FUNCTION my_authorities()
RETURNS TABLE(action_code text, rule_id uuid, max_amount numeric, currency character, requires_qualification boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select r.action_code, r.id, r.max_amount, r.currency, r.requires_qualification
    from iam.authority_rule r
    join private.my_position() p on true
   where r.db_role = private.active_role()
     and (r.job_family is null or r.job_family = p.job_family)
     and (r.unit_type is null or r.unit_type = p.unit_type)
     and p.grade >= r.min_grade
     and r.valid @> now()
   order by r.action_code, r.min_grade;
$$;

CREATE OR REPLACE FUNCTION my_position()
RETURNS TABLE(job_title_code text, job_family text, grade integer, unit_id uuid, unit_type text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select * from private.my_position();
$$;

CREATE OR REPLACE FUNCTION my_reports()
RETURNS TABLE(user_id uuid, display_name text, title text, unit_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select u.id, u.display_name, p.job_title_code, p.unit_id
    from private.my_reports() r(user_id)
    join iam.app_user u on u.id = r.user_id
    left join iam.staff_position p on p.user_id = r.user_id and p.valid @> now()
   order by u.display_name;
$$;

CREATE OR REPLACE FUNCTION my_scope_units()
RETURNS TABLE(unit_id uuid, unit_type text, name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select u.id, u.unit_type, u.name
    from unnest(private.my_units()) as x(id)
    join core.org_unit u on u.id = x.id
   order by u.unit_type, u.name;
$$;

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

CREATE OR REPLACE FUNCTION role_assignment_revoke(
    p_id uuid,
    p_reason text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user uuid;
  v_role text;
begin
  perform private.assert_sysadmin();
  perform private.set_change_context(p_reason);

  update iam.role_assignment
     set revoked_at = now(), revoked_by = private.uid(), revoke_reason = p_reason
   where id = p_id and revoked_at is null
  returning user_id, db_role into v_user, v_role;

  if not found then
    raise exception 'assignment_not_found_or_revoked';
  end if;

  perform private.emit_event(
    'iam.assignment.revoked', 'success', 'app_user', v_user, null, p_reason,
    jsonb_build_object('db_role', v_role, 'assignment_id', p_id));
end;
$$;

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

CREATE OR REPLACE FUNCTION staff_position_set(
    p_user_id uuid,
    p_job_title_code text,
    p_unit_id uuid,
    p_family_override text,
    p_line_manager_id uuid,
    p_valid_from timestamptz,
    p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user iam.app_user;
  v_unit core.org_unit;
  v_unit_type core.org_unit_type;
  v_title iam.job_title;
  v_family text;
  v_position_id uuid;
  v_old_title text;
  v_old_unit uuid;
begin
  perform private.assert_authority('hr.position.set');
  perform private.assert_in_scope(p_unit_id);
  if p_user_id = private.uid() then
    raise exception 'cannot_set_own_position' using errcode = '42501';
  end if;
  perform private.set_change_context(p_reason);

  select * into v_user from iam.app_user where id = p_user_id and kind = 'internal' for update;
  if not found then
    raise exception 'internal_user_not_found';
  end if;
  select * into v_unit from core.org_unit where id = p_unit_id and active;
  if not found then
    raise exception 'org_unit_not_found';
  end if;
  select * into v_unit_type from core.org_unit_type where code = v_unit.unit_type;
  select * into v_title from iam.job_title where code = p_job_title_code and active;
  if not found then
    raise exception 'job_title_not_found';
  end if;

  v_family := coalesce(p_family_override, v_title.job_family, v_unit_type.default_family);
  if v_family is null then
    raise exception 'job_family_required' using errcode = '22023';
  end if;

  select p.job_title_code, p.unit_id into v_old_title, v_old_unit
    from iam.staff_position p
   where p.user_id = p_user_id and p.valid @> now();

  update iam.staff_position
     set valid = tstzrange(lower(valid), p_valid_from)
   where user_id = p_user_id
     and valid @> now()
     and lower(valid) < p_valid_from;

  update iam.role_assignment
     set revoked_at = now(), revoked_by = private.uid(), revoke_reason = p_reason
   where user_id = p_user_id
     and source = 'position'
     and revoked_at is null;

  insert into iam.staff_position
    (user_id, user_kind, job_title_code, job_family, unit_id, line_manager_id, valid, set_by, reason)
  values
    (p_user_id, 'internal', p_job_title_code, v_family, p_unit_id, p_line_manager_id,
     tstzrange(p_valid_from, null), private.uid(), p_reason)
  returning id into v_position_id;

  insert into iam.role_assignment
    (user_id, user_kind, db_role, scope_type, scope_unit_id, source, position_id, valid, granted_by, grant_reason)
  select p_user_id, 'internal', x.db_role,
         case when x.scope_unit_id is null then 'global' else 'unit' end,
         x.scope_unit_id, 'position', v_position_id, tstzrange(p_valid_from, null),
         private.uid(), p_reason
    from (
      select r.db_role,
             case r.scope_target
               when 'own_unit' then
                 case when v_unit.unit_type in ('head_office', 'ho_department') then null else v_unit.id end
               when 'parent_unit' then v_unit.parent_id
               else null
             end as scope_unit_id
        from iam.default_role_rule r
       where (r.unit_type is null or r.unit_type = v_unit.unit_type)
         and (r.unit_function is null or r.unit_function = v_unit.function_code)
         and (r.job_family is null or r.job_family = v_family)
         and v_title.grade between r.min_grade and r.max_grade
    ) x
   where not exists (
     select 1 from iam.role_assignment a
      where a.user_id = p_user_id
        and a.db_role = x.db_role
        and a.scope_unit_id is not distinct from x.scope_unit_id
        and a.revoked_at is null
        and a.valid @> now()
   );

  perform private.emit_event(
    'iam.position.changed', 'success', 'app_user', p_user_id, p_unit_id, p_reason,
    jsonb_build_object(
      'old_title', v_old_title, 'old_unit_id', v_old_unit,
      'new_title', p_job_title_code, 'new_unit_id', p_unit_id,
      'family', v_family, 'grade', v_title.grade));

  return v_position_id;
end;
$$;

CREATE OR REPLACE VIEW staff_positions WITH (security_invoker=true) AS
 SELECT p.id,
    p.user_id,
    u.display_name,
    p.job_title_code,
    p.job_family,
    p.unit_id,
    p.line_manager_id,
    p.valid,
    p.set_by,
    p.reason
   FROM iam.staff_position p
     JOIN iam.app_user u ON u.id = p.user_id;

REVOKE EXECUTE ON FUNCTION my_assignments() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION my_authorities() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION my_position() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION my_reports() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION my_scope_units() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION role_assignment_grant(p_user_id uuid, p_db_role text, p_scope_type text, p_scope_unit_id uuid, p_reason text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION role_assignment_revoke(p_id uuid, p_reason text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION staff_position_close(p_user_id uuid, p_reason text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION staff_position_set(p_user_id uuid, p_job_title_code text, p_unit_id uuid, p_family_override text, p_line_manager_id uuid, p_valid_from timestamp with time zone, p_reason text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION my_assignments() TO int_auditor;

GRANT EXECUTE ON FUNCTION my_assignments() TO int_compliance;

GRANT EXECUTE ON FUNCTION my_assignments() TO int_coordinator;

GRANT EXECUTE ON FUNCTION my_assignments() TO int_finance;

GRANT EXECUTE ON FUNCTION my_assignments() TO int_hr;

GRANT EXECUTE ON FUNCTION my_assignments() TO int_manager;

GRANT EXECUTE ON FUNCTION my_assignments() TO int_surveyor;

GRANT EXECUTE ON FUNCTION my_assignments() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION my_assignments() TO int_viewer;

GRANT EXECUTE ON FUNCTION my_authorities() TO int_auditor;

GRANT EXECUTE ON FUNCTION my_authorities() TO int_compliance;

GRANT EXECUTE ON FUNCTION my_authorities() TO int_coordinator;

GRANT EXECUTE ON FUNCTION my_authorities() TO int_finance;

GRANT EXECUTE ON FUNCTION my_authorities() TO int_hr;

GRANT EXECUTE ON FUNCTION my_authorities() TO int_manager;

GRANT EXECUTE ON FUNCTION my_authorities() TO int_surveyor;

GRANT EXECUTE ON FUNCTION my_authorities() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION my_authorities() TO int_viewer;

GRANT EXECUTE ON FUNCTION my_position() TO int_auditor;

GRANT EXECUTE ON FUNCTION my_position() TO int_compliance;

GRANT EXECUTE ON FUNCTION my_position() TO int_coordinator;

GRANT EXECUTE ON FUNCTION my_position() TO int_finance;

GRANT EXECUTE ON FUNCTION my_position() TO int_hr;

GRANT EXECUTE ON FUNCTION my_position() TO int_manager;

GRANT EXECUTE ON FUNCTION my_position() TO int_surveyor;

GRANT EXECUTE ON FUNCTION my_position() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION my_position() TO int_viewer;

GRANT EXECUTE ON FUNCTION my_reports() TO int_compliance;

GRANT EXECUTE ON FUNCTION my_reports() TO int_hr;

GRANT EXECUTE ON FUNCTION my_reports() TO int_manager;

GRANT EXECUTE ON FUNCTION my_reports() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION my_scope_units() TO int_auditor;

GRANT EXECUTE ON FUNCTION my_scope_units() TO int_compliance;

GRANT EXECUTE ON FUNCTION my_scope_units() TO int_coordinator;

GRANT EXECUTE ON FUNCTION my_scope_units() TO int_finance;

GRANT EXECUTE ON FUNCTION my_scope_units() TO int_hr;

GRANT EXECUTE ON FUNCTION my_scope_units() TO int_manager;

GRANT EXECUTE ON FUNCTION my_scope_units() TO int_surveyor;

GRANT EXECUTE ON FUNCTION my_scope_units() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION my_scope_units() TO int_viewer;

GRANT EXECUTE ON FUNCTION role_assignment_grant(p_user_id uuid, p_db_role text, p_scope_type text, p_scope_unit_id uuid, p_reason text) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION role_assignment_revoke(p_id uuid, p_reason text) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION staff_position_close(p_user_id uuid, p_reason text) TO int_hr;

GRANT EXECUTE ON FUNCTION staff_position_set(p_user_id uuid, p_job_title_code text, p_unit_id uuid, p_family_override text, p_line_manager_id uuid, p_valid_from timestamp with time zone, p_reason text) TO int_hr;

GRANT SELECT ON TABLE staff_positions TO int_hr;

GRANT SELECT ON TABLE staff_positions TO int_sysadmin;
