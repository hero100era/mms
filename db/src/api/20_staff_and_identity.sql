-- I-06: positions, assignments and self-service authority context.

create function api.my_position()
returns table(job_title_code text, job_family text, grade int, unit_id uuid, unit_type text)
language sql
stable
security definer
set search_path = ''
as $$
  select * from private.my_position();
$$;

create function api.my_scope_units()
returns table(unit_id uuid, unit_type text, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.unit_type, u.name
    from unnest(private.my_units()) as x(id)
    join core.org_unit u on u.id = x.id
   order by u.unit_type, u.name;
$$;

create function api.my_authorities()
returns table(action_code text, rule_id uuid, max_amount numeric, currency char(3), requires_qualification boolean)
language sql
stable
security definer
set search_path = ''
as $$
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

create function api.my_reports()
returns table(user_id uuid, display_name text, title text, unit_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.display_name, p.job_title_code, p.unit_id
    from private.my_reports() r(user_id)
    join iam.app_user u on u.id = r.user_id
    left join iam.staff_position p on p.user_id = r.user_id and p.valid @> now()
   order by u.display_name;
$$;

create function api.my_assignments()
returns table(id uuid, db_role text, scope_type text, scope_unit_id uuid, source text, valid tstzrange)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.db_role, a.scope_type, a.scope_unit_id, a.source, a.valid
    from iam.role_assignment a
   where a.user_id = private.uid()
     and a.revoked_at is null
     and a.valid @> now()
   order by a.db_role;
$$;

create function api.staff_position_set(
  p_user_id uuid,
  p_job_title_code text,
  p_unit_id uuid,
  p_family_override text,
  p_line_manager_id uuid,
  p_valid_from timestamptz,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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
  v_valid_from timestamptz;
begin
  perform private.assert_authority('hr.position.set');
  perform private.assert_in_scope(p_unit_id);
  if p_user_id = private.uid() then
    raise exception 'cannot_set_own_position' using errcode = '42501';
  end if;
  perform private.set_change_context(p_reason);

  v_valid_from := coalesce(p_valid_from, now());

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
   where p.user_id = p_user_id
     and (p.valid @> v_valid_from or upper(p.valid) is null)
   order by lower(p.valid) desc
   limit 1
   for update;

  if v_old_position_id is not null and v_valid_from < v_old_lower then
    raise exception 'valid_from_precedes_current_position' using errcode = '22023';
  end if;

  update iam.role_assignment
     set revoked_at = now(), revoked_by = private.uid(), revoke_reason = p_reason
   where user_id = p_user_id
     and source = 'position'
     and revoked_at is null;

  if v_old_position_id is not null and v_old_lower = v_valid_from then
    update iam.staff_position
       set job_title_code = p_job_title_code,
           job_family = v_family,
           unit_id = p_unit_id,
           line_manager_id = p_line_manager_id,
           valid = tstzrange(v_valid_from, null),
           set_by = private.uid(),
           reason = p_reason
     where id = v_old_position_id
    returning id into v_position_id;
  else
    if v_old_position_id is not null then
      update iam.staff_position
         set valid = tstzrange(lower(valid), v_valid_from)
       where id = v_old_position_id;
    end if;

    insert into iam.staff_position
      (user_id, user_kind, job_title_code, job_family, unit_id, line_manager_id, valid, set_by, reason)
    values
      (p_user_id, 'internal', p_job_title_code, v_family, p_unit_id, p_line_manager_id,
       tstzrange(v_valid_from, null), private.uid(), p_reason)
    returning id into v_position_id;
  end if;

  insert into iam.role_assignment
    (user_id, user_kind, db_role, scope_type, scope_unit_id, source, position_id, valid, granted_by, grant_reason)
  select p_user_id, 'internal', x.db_role,
         case when x.scope_unit_id is null then 'global' else 'unit' end,
         x.scope_unit_id, 'position', v_position_id, tstzrange(v_valid_from, null),
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
        and a.valid && tstzrange(v_valid_from, null)
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

create function api.staff_position_close(p_user_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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

  -- R2.5: lock the subject before closing periods and suspending the user.
  perform 1 from iam.app_user where id = p_user_id for update;

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

create function api.role_assignment_grant(
  p_user_id uuid,
  p_db_role text,
  p_scope_type text,
  p_scope_unit_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.assert_sysadmin();
  if p_user_id = private.uid() then
    raise exception 'cannot_grant_self' using errcode = '42501';
  end if;
  perform private.assert_role_eligible(p_user_id, p_db_role);
  perform private.set_change_context(p_reason);

  -- R2.5: lock the subject user before opening a new assignment period.
  perform 1 from iam.app_user where id = p_user_id for update;

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

create function api.role_assignment_revoke(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_role text;
  v_scope_unit uuid;
begin
  perform private.assert_sysadmin();
  perform private.set_change_context(p_reason);

  update iam.role_assignment
     set revoked_at = now(), revoked_by = private.uid(), revoke_reason = p_reason
   where id = p_id and revoked_at is null
  returning user_id, db_role, scope_unit_id into v_user, v_role, v_scope_unit;

  if not found then
    raise exception 'assignment_not_found_or_revoked';
  end if;

  perform private.emit_event(
    'iam.assignment.revoked', 'success', 'app_user', v_user, v_scope_unit, p_reason,
    jsonb_build_object('db_role', v_role, 'assignment_id', p_id));
end;
$$;

create view api.staff_positions
with (security_invoker = true)
as
select p.id, p.user_id, u.display_name, p.job_title_code, p.job_family, p.unit_id,
       p.line_manager_id, p.valid, p.set_by, p.reason
  from iam.staff_position p
  join iam.app_user u on u.id = p.user_id;

revoke all on function api.my_position() from public;
revoke all on function api.my_scope_units() from public;
revoke all on function api.my_authorities() from public;
revoke all on function api.my_reports() from public;
revoke all on function api.my_assignments() from public;
revoke all on function api.staff_position_set(uuid, text, uuid, text, uuid, timestamptz, text) from public;
revoke all on function api.staff_position_close(uuid, text) from public;
revoke all on function api.role_assignment_grant(uuid, text, text, uuid, text) from public;
revoke all on function api.role_assignment_revoke(uuid, text) from public;

grant execute on function api.my_position() to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;
grant execute on function api.my_scope_units() to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;
grant execute on function api.my_authorities() to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;
grant execute on function api.my_reports() to int_manager, int_compliance, int_hr, int_sysadmin;
grant execute on function api.my_assignments() to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;
grant execute on function api.staff_position_set(uuid, text, uuid, text, uuid, timestamptz, text) to int_hr;
grant execute on function api.staff_position_close(uuid, text) to int_hr;
grant execute on function api.role_assignment_grant(uuid, text, text, uuid, text) to int_sysadmin;
grant execute on function api.role_assignment_revoke(uuid, text) to int_sysadmin;
grant select on api.staff_positions to int_hr;

create view api.organizations
with (security_invoker = true)
as
select id, name, org_type, status
  from party.organization;

grant select on api.organizations to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

create view api.user_directory
with (security_invoker = true)
as
select
  u.id,
  u.display_name,
  u.email,
  p.job_title_code as title,
  p.unit_id,
  private.user_directory_grade(u.id) as grade,
  private.user_directory_line_manager(u.id) as line_manager_id
from iam.app_user u
left join iam.staff_position p on p.user_id = u.id and p.valid @> now()
where u.kind = 'internal' and u.status in ('active', 'invited');

grant select on api.user_directory to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

create view api.org_chart_nodes
with (security_invoker = true)
as
select
  u.id as user_id,
  u.display_name,
  u.email,
  u.status,
  p.job_title_code,
  jt.label_en as job_title,
  jt.label_zh as job_title_zh,
  p.job_family,
  p.unit_id,
  ou.code as unit_code,
  ou.name as unit_name,
  ou.unit_type,
  ou.region_code,
  ou.path::text as unit_path,
  lm.line_manager_id,
  m.display_name as manager_name,
  m.email as manager_email,
  mp.job_title_code as manager_job_title_code,
  mjt.label_en as manager_job_title,
  private.org_chart_direct_reports_count(u.id) as direct_reports_count
from iam.app_user u
left join iam.staff_position p on p.user_id = u.id and p.valid @> now()
left join iam.job_title jt on jt.code = p.job_title_code
left join core.org_unit ou on ou.id = p.unit_id
cross join lateral (
  select private.user_directory_line_manager(u.id) as line_manager_id
) lm
left join iam.app_user m on m.id = lm.line_manager_id and m.kind = 'internal' and m.status in ('active', 'invited')
left join iam.staff_position mp on mp.user_id = m.id and mp.valid @> now()
left join iam.job_title mjt on mjt.code = mp.job_title_code
where u.kind = 'internal'
  and u.status in ('active', 'invited');

grant select on api.org_chart_nodes to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

create function api.org_chart_management_chain(p_user_id uuid)
returns table(
  user_id uuid,
  display_name text,
  email text,
  job_title_code text,
  job_title text,
  job_family text,
  unit_id uuid,
  unit_code text,
  unit_name text,
  unit_type text,
  line_manager_id uuid,
  direct_reports_count bigint,
  level int
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_internal_caller() then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
  with recursive chain as (
    select m.id as user_id,
           m.display_name,
           m.email,
           mp.job_title_code,
           mjt.label_en as job_title,
           mp.job_family,
           mp.unit_id,
           ou.code as unit_code,
           ou.name as unit_name,
           ou.unit_type,
           mp.line_manager_id,
           1 as level,
           array[p_user_id, m.id]::uuid[] as visited
      from iam.staff_position ep
      join iam.app_user m on m.id = ep.line_manager_id
      left join iam.staff_position mp on mp.user_id = m.id and mp.valid @> now()
      left join iam.job_title mjt on mjt.code = mp.job_title_code
      left join core.org_unit ou on ou.id = mp.unit_id
     where ep.user_id = p_user_id
       and ep.valid @> now()
       and m.kind = 'internal'
       and m.status in ('active', 'invited')
       and m.id <> p_user_id
    union all
    select m.id as user_id,
           m.display_name,
           m.email,
           mp.job_title_code,
           mjt.label_en as job_title,
           mp.job_family,
           mp.unit_id,
           ou.code as unit_code,
           ou.name as unit_name,
           ou.unit_type,
           mp.line_manager_id,
           c.level + 1,
           c.visited || m.id
      from chain c
      join iam.app_user m on m.id = c.line_manager_id
      left join iam.staff_position mp on mp.user_id = m.id and mp.valid @> now()
      left join iam.job_title mjt on mjt.code = mp.job_title_code
      left join core.org_unit ou on ou.id = mp.unit_id
     where m.kind = 'internal'
       and m.status in ('active', 'invited')
       and c.level < 50
       and not (m.id = any(c.visited))
  )
  select c.user_id,
         c.display_name,
         c.email,
         c.job_title_code,
         c.job_title,
         c.job_family,
         c.unit_id,
         c.unit_code,
         c.unit_name,
         c.unit_type,
         c.line_manager_id,
         private.org_chart_direct_reports_count(c.user_id) as direct_reports_count,
         c.level
    from chain c
   order by c.level;
end;
$$;

create function api.org_chart_reports(p_manager_id uuid, p_max_depth int default null)
returns table(
  user_id uuid,
  display_name text,
  email text,
  job_title_code text,
  job_title text,
  job_family text,
  unit_id uuid,
  unit_code text,
  unit_name text,
  unit_type text,
  line_manager_id uuid,
  direct_reports_count bigint,
  level int
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_internal_caller() then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_max_depth is not null and p_max_depth < 1 then
    return;
  end if;

  return query
  with recursive reports as (
    select u.id as user_id,
           u.display_name,
           u.email,
           p.job_title_code,
           jt.label_en as job_title,
           p.job_family,
           p.unit_id,
           ou.code as unit_code,
           ou.name as unit_name,
           ou.unit_type,
           p.line_manager_id,
           1 as level,
           array[p_manager_id, u.id]::uuid[] as visited
      from iam.staff_position p
      join iam.app_user u on u.id = p.user_id
      left join iam.job_title jt on jt.code = p.job_title_code
      left join core.org_unit ou on ou.id = p.unit_id
     where p.line_manager_id = p_manager_id
       and p.valid @> now()
       and u.kind = 'internal'
       and u.status in ('active', 'invited')
       and u.id <> p_manager_id
    union all
    select u.id as user_id,
           u.display_name,
           u.email,
           p.job_title_code,
           jt.label_en as job_title,
           p.job_family,
           p.unit_id,
           ou.code as unit_code,
           ou.name as unit_name,
           ou.unit_type,
           p.line_manager_id,
           r.level + 1,
           r.visited || u.id
      from iam.staff_position p
      join reports r on p.line_manager_id = r.user_id
      join iam.app_user u on u.id = p.user_id
      left join iam.job_title jt on jt.code = p.job_title_code
      left join core.org_unit ou on ou.id = p.unit_id
     where p.valid @> now()
       and u.kind = 'internal'
       and u.status in ('active', 'invited')
       and r.level < coalesce(p_max_depth, 50)
       and not (u.id = any(r.visited))
  )
  select r.user_id,
         r.display_name,
         r.email,
         r.job_title_code,
         r.job_title,
         r.job_family,
         r.unit_id,
         r.unit_code,
         r.unit_name,
         r.unit_type,
         r.line_manager_id,
         private.org_chart_direct_reports_count(r.user_id) as direct_reports_count,
         r.level
    from reports r
   order by r.level, r.display_name;
end;
$$;

create function api.org_chart_peers(p_user_id uuid)
returns table(
  user_id uuid,
  display_name text,
  email text,
  job_title_code text,
  job_title text,
  job_family text,
  unit_id uuid,
  unit_code text,
  unit_name text,
  unit_type text,
  line_manager_id uuid,
  direct_reports_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_manager_id uuid;
begin
  if not private.is_internal_caller() then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select p.line_manager_id into v_manager_id
    from iam.staff_position p
   where p.user_id = p_user_id
     and p.valid @> now()
   limit 1;

  if v_manager_id is null then
    return;
  end if;

  return query
  select u.id as user_id,
         u.display_name,
         u.email,
         p.job_title_code,
         jt.label_en as job_title,
         p.job_family,
         p.unit_id,
         ou.code as unit_code,
         ou.name as unit_name,
         ou.unit_type,
         p.line_manager_id,
         private.org_chart_direct_reports_count(u.id) as direct_reports_count
    from iam.staff_position p
    join iam.app_user u on u.id = p.user_id
    left join iam.job_title jt on jt.code = p.job_title_code
    left join core.org_unit ou on ou.id = p.unit_id
   where p.line_manager_id = v_manager_id
     and p.user_id <> p_user_id
     and p.valid @> now()
     and u.kind = 'internal'
     and u.status in ('active', 'invited')
   order by u.display_name;
end;
$$;

create function api.org_chart_for_user(p_user_id uuid default null)
returns table(
  relation text,
  level int,
  user_id uuid,
  display_name text,
  email text,
  job_title_code text,
  job_title text,
  job_family text,
  unit_id uuid,
  unit_code text,
  unit_name text,
  unit_type text,
  line_manager_id uuid,
  direct_reports_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_target uuid := coalesce(p_user_id, private.uid());
begin
  if not private.is_internal_caller() then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if v_target is null then
    return;
  end if;

  return query
  select 'chain'::text as relation,
         -c.level as level,
         c.user_id,
         c.display_name,
         c.email,
         c.job_title_code,
         c.job_title,
         c.job_family,
         c.unit_id,
         c.unit_code,
         c.unit_name,
         c.unit_type,
         c.line_manager_id,
         c.direct_reports_count
    from api.org_chart_management_chain(v_target) c
  union all
  select 'self'::text as relation,
         0 as level,
         u.id as user_id,
         u.display_name,
         u.email,
         p.job_title_code,
         jt.label_en as job_title,
         p.job_family,
         p.unit_id,
         ou.code as unit_code,
         ou.name as unit_name,
         ou.unit_type,
         p.line_manager_id,
         private.org_chart_direct_reports_count(u.id) as direct_reports_count
    from iam.app_user u
    left join iam.staff_position p on p.user_id = u.id and p.valid @> now()
    left join iam.job_title jt on jt.code = p.job_title_code
    left join core.org_unit ou on ou.id = p.unit_id
   where u.id = v_target
     and u.kind = 'internal'
     and u.status in ('active', 'invited')
  union all
  select 'peer'::text as relation,
         0 as level,
         pr.user_id,
         pr.display_name,
         pr.email,
         pr.job_title_code,
         pr.job_title,
         pr.job_family,
         pr.unit_id,
         pr.unit_code,
         pr.unit_name,
         pr.unit_type,
         pr.line_manager_id,
         pr.direct_reports_count
    from api.org_chart_peers(v_target) pr
  union all
  select 'direct_report'::text as relation,
         1 as level,
         rp.user_id,
         rp.display_name,
         rp.email,
         rp.job_title_code,
         rp.job_title,
         rp.job_family,
         rp.unit_id,
         rp.unit_code,
         rp.unit_name,
         rp.unit_type,
         rp.line_manager_id,
         rp.direct_reports_count
    from api.org_chart_reports(v_target, 1) rp
   order by level, relation, display_name;
end;
$$;

revoke all on function api.org_chart_management_chain(uuid) from public;
revoke all on function api.org_chart_reports(uuid, int) from public;
revoke all on function api.org_chart_peers(uuid) from public;
revoke all on function api.org_chart_for_user(uuid) from public;

grant execute on function api.org_chart_management_chain(uuid) to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;
grant execute on function api.org_chart_reports(uuid, int) to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;
grant execute on function api.org_chart_peers(uuid) to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;
grant execute on function api.org_chart_for_user(uuid) to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;


create function api.staff_directory()
returns table(id uuid, display_name text, kind text, status text)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.display_name, u.kind, u.status
    from iam.app_user u
   where u.kind = 'internal'
   order by u.display_name;
$$;

create function api.staff_assignments(p_user_id uuid default null)
returns table(id uuid, user_id uuid, display_name text, db_role text, scope_type text,
              scope_unit_id uuid, source text, valid tstzrange, revoked_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.user_id, u.display_name, a.db_role, a.scope_type, a.scope_unit_id,
         a.source, a.valid, a.revoked_at
    from iam.role_assignment a
    join iam.app_user u on u.id = a.user_id
   where p_user_id is null or a.user_id = p_user_id
   order by u.display_name, a.db_role;
$$;

create function api.assignable_roles(p_user_id uuid default null)
returns table(role_name text, description text, eligible boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_sysadmin();
  return query
  select r.role_name,
         r.description,
         case
           when p_user_id is null then true
           when r.role_name = 'int_sysadmin' then true
           when exists (
             select 1
               from iam.staff_position p
               join iam.job_title t on t.code = p.job_title_code
               join core.org_unit u on u.id = p.unit_id
               join iam.default_role_rule dr on dr.db_role = r.role_name
              where p.user_id = p_user_id
                and p.valid @> now()
                and (dr.unit_type is null or dr.unit_type = u.unit_type)
                and (dr.unit_function is null or dr.unit_function = u.function_code)
                and (dr.job_family is null or dr.job_family = p.job_family)
                and t.grade between dr.min_grade and dr.max_grade
           ) then true
           else false
         end as eligible
    from iam.db_role r
   where r.kind = 'internal'
   order by r.role_name;
end;
$$;

revoke all on function api.staff_directory() from public;
revoke all on function api.staff_assignments(uuid) from public;
revoke all on function api.assignable_roles(uuid) from public;
grant execute on function api.staff_directory() to int_hr, int_sysadmin;
grant execute on function api.staff_assignments(uuid) to int_hr, int_sysadmin;
grant execute on function api.assignable_roles(uuid) to int_sysadmin;

create function api.create_external_user(
  p_email text,
  p_display_name text,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_token text;
  v_expires timestamptz;
begin
  if coalesce(private.claim('role'), '') = 'int_sysadmin' then
    null;
  else
    perform private.assert_authority('iam.external_user.create');
  end if;

  perform private.set_change_context(p_reason);

  if p_email is null or btrim(p_email) = '' or p_email not like '%@%' or p_email like '% %' then
    raise exception 'invalid_email' using errcode = '22023';
  end if;

  if p_display_name is null or btrim(p_display_name) = '' then
    raise exception 'display_name_required' using errcode = '22023';
  end if;

  p_email := lower(btrim(p_email));
  p_display_name := btrim(p_display_name);

  if exists (
    select 1 from iam.app_user
     where email = p_email and kind = 'external' and status <> 'deactivated'
  ) then
    raise exception 'email_already_registered' using errcode = '23505';
  end if;

  insert into iam.app_user (kind, email, display_name, status, created_by)
  values ('external', p_email, p_display_name, 'invited', private.uid())
  returning id into v_user_id;

  v_token := encode(sha256(convert_to(
    gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8'
  )), 'hex');
  v_expires := now() + interval '72 hours';

  insert into iam.one_time_token (user_id, purpose, token_hash, expires_at, created_by)
  values (v_user_id, 'invite', sha256(convert_to(v_token, 'UTF8')), v_expires, private.uid());

  insert into core.outbox (kind, payload, status, enqueued_by)
  values (
    'invite_email',
    jsonb_build_object(
      'user_id', v_user_id,
      'email', lower(p_email),
      'display_name', p_display_name,
      'token', v_token
    ),
    'pending',
    private.uid()
  );

  perform private.emit_event(
    'auth.user.created', 'success', 'app_user', v_user_id, null, p_reason,
    jsonb_build_object('email', lower(p_email), 'kind', 'external')
  );

  perform private.emit_event(
    'auth.invite.created', 'success', 'app_user', v_user_id, null, p_reason,
    jsonb_build_object('expires_at', v_expires)
  );

  return v_user_id;
end;
$$;

create function api.invite_external_user(
  p_user_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user iam.app_user;
  v_token text;
  v_expires timestamptz;
begin
  if coalesce(private.claim('role'), '') = 'int_sysadmin' then
    null;
  else
    perform private.assert_authority('iam.external_user.create');
  end if;

  perform private.set_change_context(p_reason);

  -- R2.5: lock the subject user before changing membership/identity state.
  select * into v_user from iam.app_user where id = p_user_id and kind = 'external' for update;
  if not found then
    raise exception 'external_user_not_found';
  end if;
  if v_user.status = 'deactivated' then
    raise exception 'user_deactivated';
  end if;
  if v_user.status <> 'invited' then
    raise exception 'user_already_active_or_not_invited' using errcode = '42501';
  end if;

  v_token := encode(sha256(convert_to(
    gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8'
  )), 'hex');
  v_expires := now() + interval '72 hours';

  update iam.one_time_token
     set expires_at = now()
   where user_id = p_user_id
     and purpose = 'invite'
     and used_at is null
     and expires_at > now();

  insert into iam.one_time_token (user_id, purpose, token_hash, expires_at, created_by)
  values (p_user_id, 'invite', sha256(convert_to(v_token, 'UTF8')), v_expires, private.uid());

  insert into core.outbox (kind, payload, status, enqueued_by)
  values (
    'invite_email',
    jsonb_build_object(
      'user_id', p_user_id,
      'email', v_user.email,
      'display_name', v_user.display_name,
      'token', v_token
    ),
    'pending',
    private.uid()
  );

  perform private.emit_event(
    'auth.invite.created', 'success', 'app_user', p_user_id, null, p_reason,
    jsonb_build_object('expires_at', v_expires)
  );
end;
$$;

create function api.external_users()
returns table(id uuid, email text, display_name text, status text, created_at timestamptz, email_verified_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.email, u.display_name, u.status, u.created_at, u.email_verified_at
    from iam.app_user u
   where u.kind = 'external'
   order by u.created_at desc;
$$;

create function api.my_identities()
returns table(id uuid, provider text, issuer text, email_at_link text, linked_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.provider, i.issuer, i.email_at_link, i.linked_at
    from iam.user_identity i
   where i.user_id = private.uid()
     and i.unlinked_at is null
   order by i.linked_at desc;
$$;

revoke all on function api.create_external_user(text, text, text) from public;
revoke all on function api.invite_external_user(uuid, text) from public;
revoke all on function api.external_users() from public;
revoke all on function api.my_identities() from public;

grant execute on function api.create_external_user(text, text, text) to int_coordinator, int_sysadmin;
grant execute on function api.invite_external_user(uuid, text) to int_coordinator, int_sysadmin;
grant execute on function api.external_users() to int_coordinator, int_sysadmin;
grant execute on function api.my_identities() to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

create function api.my_profile()
returns table(id uuid, email text, display_name text, kind text, status text, created_at timestamptz, email_verified_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.email, u.display_name, u.kind, u.status, u.created_at, u.email_verified_at
    from iam.app_user u
   where u.id = private.uid();
$$;

create function api.my_sessions()
returns table(
  id uuid,
  active_role text,
  auth_method text,
  created_at timestamptz,
  last_seen_at timestamptz,
  idle_expires_at timestamptz,
  expires_at timestamptz,
  client_ip inet,
  user_agent text,
  is_current boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.active_role, s.auth_method, s.created_at, s.last_seen_at,
         s.idle_expires_at, s.expires_at, s.client_ip, s.user_agent,
         (s.id = nullif(private.claim('sid'), '')::uuid) as is_current
    from iam.session s
   where s.user_id = private.uid()
     and s.revoked_at is null
     and s.idle_expires_at > now()
     and s.expires_at > now()
   order by s.last_seen_at desc;
$$;

create function api.revoke_my_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.uid();
begin
  if v_user_id is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  update iam.session
     set revoked_at = now(), revoke_reason = 'user_revoked'
   where id = p_session_id
     and user_id = v_user_id
     and revoked_at is null;

  if not found then
    raise exception 'session_not_found_or_revoked' using errcode = '42501';
  end if;

  perform private.emit_event(
    'auth.session.revoked', 'success', 'app_user', v_user_id, null, 'user_revoked',
    jsonb_build_object('session_id', p_session_id)
  );
end;
$$;

create function api.revoke_all_my_sessions(p_keep_current boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.uid();
  v_current_sid uuid := nullif(private.claim('sid'), '')::uuid;
begin
  if v_user_id is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  update iam.session
     set revoked_at = now(), revoke_reason = case when p_keep_current then 'revoke_others' else 'logout_all' end
   where user_id = v_user_id
     and revoked_at is null
     and (not p_keep_current or id <> v_current_sid);

  perform private.emit_event(
    'auth.session.revoked', 'success', 'app_user', v_user_id, null,
    case when p_keep_current then 'revoke_others' else 'logout_all' end,
    jsonb_build_object('revoked_all', true, 'kept_current', p_keep_current)
  );
end;
$$;

revoke all on function api.my_profile() from public;
revoke all on function api.my_sessions() from public;
revoke all on function api.revoke_my_session(uuid) from public;
revoke all on function api.revoke_all_my_sessions(boolean) from public;

grant execute on function api.my_profile() to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;
grant execute on function api.my_sessions() to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;
grant execute on function api.revoke_my_session(uuid) to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;
grant execute on function api.revoke_all_my_sessions(boolean) to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;
