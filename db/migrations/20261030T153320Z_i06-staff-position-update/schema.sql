-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

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
  v_old_position_id uuid;
  v_old_title text;
  v_old_unit uuid;
  v_old_lower timestamptz;
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

  select p.id, p.job_title_code, p.unit_id, lower(p.valid)
    into v_old_position_id, v_old_title, v_old_unit, v_old_lower
    from iam.staff_position p
   where p.user_id = p_user_id and p.valid @> now();

  update iam.role_assignment
     set revoked_at = now(), revoked_by = private.uid(), revoke_reason = p_reason
   where user_id = p_user_id
     and source = 'position'
     and revoked_at is null;

  if v_old_position_id is not null and v_old_lower >= p_valid_from then
    update iam.staff_position
       set job_title_code = p_job_title_code,
           job_family = v_family,
           unit_id = p_unit_id,
           line_manager_id = p_line_manager_id,
           valid = tstzrange(p_valid_from, null),
           set_by = private.uid(),
           reason = p_reason
     where id = v_old_position_id
    returning id into v_position_id;
  else
    if v_old_position_id is not null then
      update iam.staff_position
         set valid = tstzrange(lower(valid), p_valid_from)
       where id = v_old_position_id;
    end if;

    insert into iam.staff_position
      (user_id, user_kind, job_title_code, job_family, unit_id, line_manager_id, valid, set_by, reason)
    values
      (p_user_id, 'internal', p_job_title_code, v_family, p_unit_id, p_line_manager_id,
       tstzrange(p_valid_from, null), private.uid(), p_reason)
    returning id into v_position_id;
  end if;

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
