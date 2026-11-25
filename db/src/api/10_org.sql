-- API surface for the organisation model (flow C, sysadmin only).

create view api.org_units
with (security_invoker = true)
as
select u.id, u.code, u.name, u.unit_type, u.parent_id, u.region_code,
       u.function_code, u.active, u.valid
  from core.org_unit u;

create view api.org_unit_hierarchy
with (security_invoker = true)
as
with recursive tree as (
  select u.id,
         u.code,
         u.name,
         u.unit_type,
         u.parent_id,
         u.region_code,
         u.function_code,
         u.active,
         u.level,
         u.path::text as path,
         array[u.name]::text[] as path_names,
         array[u.id]::uuid[] as path_ids,
         array[u.code]::text[] as path_codes
    from core.org_unit u
   where u.parent_id is null
  union all
  select u.id,
         u.code,
         u.name,
         u.unit_type,
         u.parent_id,
         u.region_code,
         u.function_code,
         u.active,
         u.level,
         u.path::text as path,
         t.path_names || u.name,
         t.path_ids || u.id,
         t.path_codes || u.code
    from core.org_unit u
    join tree t on u.parent_id = t.id
   where not (u.id = any(t.path_ids))
)
select t.id,
       t.code,
       t.name,
       t.unit_type,
       t.parent_id,
       t.region_code,
       t.function_code,
       t.active,
       t.level,
       t.path,
       array_to_string(t.path_names, ' > ') as full_path,
       t.path_ids,
       t.path_codes,
       (
         select count(*)
           from iam.staff_position p
           join iam.app_user au on au.id = p.user_id
          where p.unit_id = t.id
            and p.valid @> now()
            and au.kind = 'internal'
            and au.status in ('active', 'invited')
       ) as direct_staff_count
  from tree t;

create function api.org_unit_create(
  p_code text,
  p_name text,
  p_unit_type text,
  p_parent_id uuid,
  p_region_code text,
  p_function_code text,
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
  -- Two callers may create a unit (ADR-0018): a sysadmin anywhere in the tree, or
  -- a delegated regional administrator inside their own scope. The delegated path
  -- needs a position that carries the authority rule AND a parent the caller
  -- already administers, so it can never add a unit above itself.
  if not private.is_sysadmin() then
    perform private.assert_authority('org.unit.create');
    perform private.assert_in_scope(p_parent_id);
  end if;
  perform private.set_change_context(p_reason);

  insert into core.org_unit (code, name, unit_type, parent_id, region_code, function_code)
  values (p_code, p_name, p_unit_type, p_parent_id, p_region_code, p_function_code)
  returning id into v_id;

  perform private.emit_event(
    'org.unit.created', 'success', 'org_unit', v_id, v_id, p_reason,
    jsonb_build_object('code', p_code, 'unit_type', p_unit_type));

  return v_id;
end;
$$;

create function api.org_unit_update(
  p_id uuid,
  p_name text,
  p_parent_id uuid,
  p_region_code text,
  p_function_code text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_sysadmin() then
    perform private.assert_authority('org.unit.create');
    perform private.assert_in_scope(p_id);
    -- Re-parenting moves a whole subtree, and the authority that its positions
    -- carry, across an administrative boundary: that stays an org-design decision
    -- reserved for the sysadmin (ADR-0018).
    if p_parent_id is distinct from (select parent_id from core.org_unit where id = p_id) then
      raise exception 'parent_change_requires_sysadmin' using errcode = '42501';
    end if;
  end if;
  perform private.set_change_context(p_reason);

  update core.org_unit
     set name = p_name,
         parent_id = p_parent_id,
         region_code = p_region_code,
         function_code = p_function_code
   where id = p_id;

  if not found then
    raise exception 'org_unit_not_found';
  end if;

  perform private.emit_event(
    'org.unit.changed', 'success', 'org_unit', p_id, p_id, p_reason, '{}'::jsonb);
end;
$$;

create function api.org_unit_close(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_sysadmin() then
    perform private.assert_authority('org.unit.close');
    perform private.assert_in_scope(p_id);
  end if;
  perform private.set_change_context(p_reason);

  update core.org_unit
     set active = false,
         valid = tstzrange(lower(valid), now())
   where id = p_id and active;

  if not found then
    raise exception 'org_unit_not_found_or_already_closed';
  end if;

  perform private.emit_event(
    'org.unit.closed', 'success', 'org_unit', p_id, p_id, p_reason, '{}'::jsonb);
end;
$$;

create function api.org_coverage_set(
  p_unit_id uuid,
  p_covered_unit_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_actor uuid := nullif(private.claim('sub'), '')::uuid;
begin
  perform private.assert_sysadmin();
  perform private.set_change_context(p_reason);

  if v_actor is null then
    raise exception 'actor_required';
  end if;

  if p_unit_id = nullif(private.claim('org_unit_id'), '')::uuid then
    raise exception 'cannot_change_own_coverage' using errcode = '42501';
  end if;

  -- R2.5: serialise coverage changes for this subject unit before closing the
  -- open period and opening a new one.
  perform 1 from core.org_unit where id = p_unit_id for update;

  update core.org_unit_coverage
     set valid = tstzrange(lower(valid), now())
   where unit_id = p_unit_id
     and covered_unit_id = p_covered_unit_id
     and upper_inf(valid);

  insert into core.org_unit_coverage (unit_id, covered_unit_id, set_by, reason)
  values (p_unit_id, p_covered_unit_id, v_actor, p_reason)
  returning id into v_id;

  perform private.emit_event(
    'org.coverage.granted', 'success', 'org_unit_coverage', v_id, p_covered_unit_id,
    p_reason, jsonb_build_object('unit_id', p_unit_id, 'covered_unit_id', p_covered_unit_id));

  return v_id;
end;
$$;

create function api.org_coverage_end(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_covered uuid;
begin
  perform private.assert_sysadmin();
  perform private.set_change_context(p_reason);

  select covered_unit_id into v_covered
    from core.org_unit_coverage
   where id = p_id and upper_inf(valid)
   for update;

  if v_covered is null then
    raise exception 'coverage_not_found_or_already_ended';
  end if;

  update core.org_unit_coverage
     set valid = tstzrange(lower(valid), now())
   where id = p_id;

  perform private.emit_event(
    'org.coverage.ended', 'success', 'org_unit_coverage', p_id, v_covered,
    p_reason, '{}'::jsonb);
end;
$$;

create function api.routing_rule_set(
  p_work_type text,
  p_region_code text,
  p_handling_unit_id uuid,
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
  perform private.set_change_context(p_reason);

  update core.routing_rule
     set valid = tstzrange(lower(valid), now())
   where work_type = p_work_type
     and region_code is not distinct from p_region_code
     and upper_inf(valid);

  insert into core.routing_rule (work_type, region_code, handling_unit_id)
  values (p_work_type, p_region_code, p_handling_unit_id)
  returning id into v_id;

  perform private.emit_event(
    'org.routing_rule.changed', 'success', 'routing_rule', v_id, p_handling_unit_id,
    p_reason, jsonb_build_object('work_type', p_work_type, 'region_code', p_region_code));

  return v_id;
end;
$$;

revoke all on function api.org_unit_create(text, text, text, uuid, text, text, text) from public;
revoke all on function api.org_unit_update(uuid, text, uuid, text, text, text) from public;
revoke all on function api.org_unit_close(uuid, text) from public;
revoke all on function api.org_coverage_set(uuid, uuid, text) from public;
revoke all on function api.org_coverage_end(uuid, text) from public;
revoke all on function api.routing_rule_set(text, text, uuid, text) from public;

grant execute on function api.org_unit_create(text, text, text, uuid, text, text, text)
  to int_sysadmin, int_coordinator, int_manager;
grant execute on function api.org_unit_update(uuid, text, uuid, text, text, text)
  to int_sysadmin, int_coordinator, int_manager;
grant execute on function api.org_unit_close(uuid, text) to int_sysadmin, int_coordinator, int_manager;
grant execute on function api.org_coverage_set(uuid, uuid, text) to int_sysadmin;
grant execute on function api.org_coverage_end(uuid, text) to int_sysadmin;
grant execute on function api.routing_rule_set(text, text, uuid, text) to int_sysadmin;

grant select on api.org_units to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

grant select on api.org_unit_hierarchy to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

