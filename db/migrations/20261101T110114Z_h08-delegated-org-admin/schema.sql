-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION is_sysadmin()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  select coalesce(private.claim('role'), '') = 'int_sysadmin';
$$;

REVOKE EXECUTE ON FUNCTION is_sysadmin() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION is_sysadmin() TO int_auditor;

GRANT EXECUTE ON FUNCTION is_sysadmin() TO int_compliance;

GRANT EXECUTE ON FUNCTION is_sysadmin() TO int_coordinator;

GRANT EXECUTE ON FUNCTION is_sysadmin() TO int_finance;

GRANT EXECUTE ON FUNCTION is_sysadmin() TO int_hr;

GRANT EXECUTE ON FUNCTION is_sysadmin() TO int_manager;

GRANT EXECUTE ON FUNCTION is_sysadmin() TO int_surveyor;

GRANT EXECUTE ON FUNCTION is_sysadmin() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION is_sysadmin() TO int_viewer;

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION org_unit_close(
    p_id uuid,
    p_reason text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
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

CREATE OR REPLACE FUNCTION org_unit_create(
    p_code text,
    p_name text,
    p_unit_type text,
    p_parent_id uuid,
    p_region_code text,
    p_function_code text,
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

CREATE OR REPLACE FUNCTION org_unit_update(
    p_id uuid,
    p_name text,
    p_parent_id uuid,
    p_region_code text,
    p_function_code text,
    p_reason text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
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

GRANT EXECUTE ON FUNCTION org_unit_close(p_id uuid, p_reason text) TO int_coordinator;

GRANT EXECUTE ON FUNCTION org_unit_close(p_id uuid, p_reason text) TO int_manager;

GRANT EXECUTE ON FUNCTION org_unit_create(p_code text, p_name text, p_unit_type text, p_parent_id uuid, p_region_code text, p_function_code text, p_reason text) TO int_coordinator;

GRANT EXECUTE ON FUNCTION org_unit_create(p_code text, p_name text, p_unit_type text, p_parent_id uuid, p_region_code text, p_function_code text, p_reason text) TO int_manager;

GRANT EXECUTE ON FUNCTION org_unit_update(p_id uuid, p_name text, p_parent_id uuid, p_region_code text, p_function_code text, p_reason text) TO int_coordinator;

GRANT EXECUTE ON FUNCTION org_unit_update(p_id uuid, p_name text, p_parent_id uuid, p_region_code text, p_function_code text, p_reason text) TO int_manager;
