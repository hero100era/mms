-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION org_coverage_set(
    p_unit_id uuid,
    p_covered_unit_id uuid,
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
