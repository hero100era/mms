-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION assert_sysadmin()
RETURNS void
LANGUAGE plpgsql
STABLE
AS $$
begin
  if coalesce(private.claim('role'), '') <> 'int_sysadmin' then
    raise exception 'insufficient_authority' using errcode = '42501';
  end if;
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
begin
  insert into audit_trail.event (
    event_type, outcome, actor_id, session_id, db_role, auth_method,
    on_behalf_of, initiated_by, actor_title, actor_grade, actor_unit_id,
    subject_type, subject_id, scope_unit_id, request_id, trace_id, source,
    client_ip, reason, detail
  ) values (
    p_event_type,
    p_outcome,
    nullif(c ->> 'sub', '')::uuid,
    nullif(c ->> 'sid', '')::uuid,
    coalesce(nullif(c ->> 'role', ''), session_user),
    c -> 'amr' ->> 0,
    nullif(current_setting('mms.on_behalf_of', true), '')::uuid,
    nullif(current_setting('mms.initiated_by', true), '')::uuid,
    c ->> 'title',
    nullif(c ->> 'grade', '')::int,
    nullif(c ->> 'org_unit_id', '')::uuid,
    p_subject_type,
    p_subject_id,
    p_scope_unit_id,
    h ->> 'x-request-id',
    split_part(h ->> 'traceparent', '-', 2),
    coalesce(c ->> 'src', 'web'),
    nullif(h ->> 'x-client-ip', '')::inet,
    p_reason,
    p_detail
  );
end;
$$;

CREATE OR REPLACE FUNCTION org_unit_tree_check()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_parent_type text;
  v_cycle boolean;
begin
  if new.parent_id is null then
    if new.unit_type <> 'head_office' then
      raise exception 'org_unit_parent_required';
    end if;
  else
    if new.unit_type = 'head_office' then
      raise exception 'org_unit_head_office_has_no_parent';
    end if;

    select unit_type into v_parent_type
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
  end if;

  if new.unit_type in ('regional_office', 'station', 'mts_centre') and new.region_code is null then
    raise exception 'org_unit_region_required';
  end if;

  return new;
end;
$$;

REVOKE EXECUTE ON FUNCTION assert_sysadmin() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION emit_event(p_event_type text, p_outcome text, p_subject_type text, p_subject_id uuid, p_scope_unit_id uuid, p_reason text, p_detail jsonb) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION org_unit_tree_check() FROM PUBLIC;

-- ===== schema: core  (pgschema 1.13.4) =====

set local search_path = core;

CREATE TABLE IF NOT EXISTS org_unit_type (
    code text,
    scoping text NOT NULL,
    default_family text,
    CONSTRAINT org_unit_type_pk PRIMARY KEY (code),
    CONSTRAINT org_unit_type_scoping_ck CHECK (scoping IN ('location'::text, 'routed'::text, 'global'::text))
);

ALTER TABLE org_unit_type ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_unit_type_read ON org_unit_type FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

CREATE TABLE IF NOT EXISTS region (
    code text,
    name text NOT NULL,
    CONSTRAINT region_pk PRIMARY KEY (code)
);

ALTER TABLE region ENABLE ROW LEVEL SECURITY;

CREATE POLICY region_read ON region FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

CREATE TABLE IF NOT EXISTS org_unit (
    id uuid DEFAULT uuidv7(),
    code text NOT NULL,
    name text NOT NULL,
    unit_type text NOT NULL,
    parent_id uuid,
    region_code text,
    function_code text,
    active boolean DEFAULT true NOT NULL,
    valid tstzrange DEFAULT tstzrange(now(), NULL) NOT NULL,
    CONSTRAINT org_unit_pk PRIMARY KEY (id),
    CONSTRAINT org_unit_code_uk UNIQUE (code),
    CONSTRAINT org_unit_parent_fk FOREIGN KEY (parent_id) REFERENCES org_unit (id),
    CONSTRAINT org_unit_region_fk FOREIGN KEY (region_code) REFERENCES region (code),
    CONSTRAINT org_unit_type_fk FOREIGN KEY (unit_type) REFERENCES org_unit_type (code),
    CONSTRAINT org_unit_function_ck CHECK ((unit_type = 'ho_department'::text) = (function_code IS NOT NULL)),
    CONSTRAINT org_unit_parent_ck CHECK (parent_id IS DISTINCT FROM id)
);

CREATE INDEX IF NOT EXISTS org_unit_parent_ix ON org_unit (parent_id);

CREATE INDEX IF NOT EXISTS org_unit_region_ix ON org_unit (region_code);

ALTER TABLE org_unit ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_unit_read ON org_unit FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

CREATE TABLE IF NOT EXISTS org_unit_coverage (
    id uuid DEFAULT uuidv7(),
    unit_id uuid NOT NULL,
    covered_unit_id uuid NOT NULL,
    valid tstzrange DEFAULT tstzrange(now(), NULL) NOT NULL,
    set_by uuid NOT NULL,
    reason text NOT NULL,
    CONSTRAINT org_unit_coverage_pk PRIMARY KEY (id),
    CONSTRAINT org_unit_coverage_covered_fk FOREIGN KEY (covered_unit_id) REFERENCES org_unit (id),
    CONSTRAINT org_unit_coverage_unit_fk FOREIGN KEY (unit_id) REFERENCES org_unit (id),
    CONSTRAINT org_unit_coverage_self_ck CHECK (unit_id <> covered_unit_id),
    CONSTRAINT org_unit_coverage_ex EXCLUDE USING gist (unit_id WITH =, covered_unit_id WITH =, valid WITH &&)
);

CREATE INDEX IF NOT EXISTS org_unit_coverage_covered_ix ON org_unit_coverage (covered_unit_id);

ALTER TABLE org_unit_coverage ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_unit_coverage_read ON org_unit_coverage FOR SELECT TO int_compliance, int_coordinator, int_manager, int_sysadmin USING (true);

CREATE TABLE IF NOT EXISTS routing_rule (
    id uuid DEFAULT uuidv7(),
    work_type text NOT NULL,
    region_code text,
    handling_unit_id uuid NOT NULL,
    valid tstzrange DEFAULT tstzrange(now(), NULL) NOT NULL,
    CONSTRAINT routing_rule_pk PRIMARY KEY (id),
    CONSTRAINT routing_rule_handling_fk FOREIGN KEY (handling_unit_id) REFERENCES org_unit (id),
    CONSTRAINT routing_rule_region_fk FOREIGN KEY (region_code) REFERENCES region (code),
    CONSTRAINT routing_rule_ex EXCLUDE USING gist (work_type WITH =, COALESCE(region_code, '*'::text) WITH =, valid WITH &&)
);

CREATE INDEX IF NOT EXISTS routing_rule_handling_ix ON routing_rule (handling_unit_id);

ALTER TABLE routing_rule ENABLE ROW LEVEL SECURITY;

CREATE POLICY routing_rule_read ON routing_rule FOR SELECT TO int_compliance, int_coordinator, int_manager, int_sysadmin USING (true);

CREATE OR REPLACE FUNCTION org_unit_descendants(
    p_roots uuid[]
)
RETURNS TABLE(id uuid)
LANGUAGE sql
STABLE
AS $$
  with recursive d(id) as (
    select unnest(p_roots)
    union
    select u.id
      from core.org_unit u
      join d on u.parent_id = d.id
  )
  select id from d;
$$;

CREATE OR REPLACE TRIGGER org_unit_tree_check
    BEFORE INSERT OR UPDATE ON org_unit
    FOR EACH ROW
    EXECUTE FUNCTION private.org_unit_tree_check();

REVOKE EXECUTE ON FUNCTION org_unit_descendants(p_roots uuid[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION org_unit_descendants(p_roots uuid[]) TO int_auditor;

GRANT EXECUTE ON FUNCTION org_unit_descendants(p_roots uuid[]) TO int_compliance;

GRANT EXECUTE ON FUNCTION org_unit_descendants(p_roots uuid[]) TO int_coordinator;

GRANT EXECUTE ON FUNCTION org_unit_descendants(p_roots uuid[]) TO int_finance;

GRANT EXECUTE ON FUNCTION org_unit_descendants(p_roots uuid[]) TO int_hr;

GRANT EXECUTE ON FUNCTION org_unit_descendants(p_roots uuid[]) TO int_manager;

GRANT EXECUTE ON FUNCTION org_unit_descendants(p_roots uuid[]) TO int_surveyor;

GRANT EXECUTE ON FUNCTION org_unit_descendants(p_roots uuid[]) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION org_unit_descendants(p_roots uuid[]) TO int_viewer;

GRANT SELECT ON TABLE org_unit TO int_auditor;

GRANT SELECT ON TABLE org_unit TO int_compliance;

GRANT SELECT ON TABLE org_unit TO int_coordinator;

GRANT SELECT ON TABLE org_unit TO int_finance;

GRANT SELECT ON TABLE org_unit TO int_hr;

GRANT SELECT ON TABLE org_unit TO int_manager;

GRANT SELECT ON TABLE org_unit TO int_surveyor;

GRANT SELECT ON TABLE org_unit TO int_sysadmin;

GRANT SELECT ON TABLE org_unit TO int_viewer;

GRANT SELECT ON TABLE org_unit_coverage TO int_auditor;

GRANT SELECT ON TABLE org_unit_coverage TO int_compliance;

GRANT SELECT ON TABLE org_unit_coverage TO int_coordinator;

GRANT SELECT ON TABLE org_unit_coverage TO int_finance;

GRANT SELECT ON TABLE org_unit_coverage TO int_hr;

GRANT SELECT ON TABLE org_unit_coverage TO int_manager;

GRANT SELECT ON TABLE org_unit_coverage TO int_surveyor;

GRANT SELECT ON TABLE org_unit_coverage TO int_sysadmin;

GRANT SELECT ON TABLE org_unit_coverage TO int_viewer;

GRANT SELECT ON TABLE org_unit_type TO int_auditor;

GRANT SELECT ON TABLE org_unit_type TO int_compliance;

GRANT SELECT ON TABLE org_unit_type TO int_coordinator;

GRANT SELECT ON TABLE org_unit_type TO int_finance;

GRANT SELECT ON TABLE org_unit_type TO int_hr;

GRANT SELECT ON TABLE org_unit_type TO int_manager;

GRANT SELECT ON TABLE org_unit_type TO int_surveyor;

GRANT SELECT ON TABLE org_unit_type TO int_sysadmin;

GRANT SELECT ON TABLE org_unit_type TO int_viewer;

GRANT SELECT ON TABLE region TO int_auditor;

GRANT SELECT ON TABLE region TO int_compliance;

GRANT SELECT ON TABLE region TO int_coordinator;

GRANT SELECT ON TABLE region TO int_finance;

GRANT SELECT ON TABLE region TO int_hr;

GRANT SELECT ON TABLE region TO int_manager;

GRANT SELECT ON TABLE region TO int_surveyor;

GRANT SELECT ON TABLE region TO int_sysadmin;

GRANT SELECT ON TABLE region TO int_viewer;

GRANT SELECT ON TABLE routing_rule TO int_auditor;

GRANT SELECT ON TABLE routing_rule TO int_compliance;

GRANT SELECT ON TABLE routing_rule TO int_coordinator;

GRANT SELECT ON TABLE routing_rule TO int_finance;

GRANT SELECT ON TABLE routing_rule TO int_hr;

GRANT SELECT ON TABLE routing_rule TO int_manager;

GRANT SELECT ON TABLE routing_rule TO int_surveyor;

GRANT SELECT ON TABLE routing_rule TO int_sysadmin;

GRANT SELECT ON TABLE routing_rule TO int_viewer;

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION org_coverage_end(
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
  v_covered uuid;
begin
  perform private.assert_sysadmin();
  perform private.set_change_context(p_reason);

  select covered_unit_id into v_covered
    from core.org_unit_coverage
   where id = p_id and upper_inf(valid);

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
  perform private.assert_sysadmin();
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
  perform private.assert_sysadmin();
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
  perform private.assert_sysadmin();
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

CREATE OR REPLACE FUNCTION routing_rule_set(
    p_work_type text,
    p_region_code text,
    p_handling_unit_id uuid,
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

CREATE OR REPLACE VIEW org_units WITH (security_invoker=true) AS
 SELECT id,
    code,
    name,
    unit_type,
    parent_id,
    region_code,
    function_code,
    active,
    valid
   FROM core.org_unit u;

REVOKE EXECUTE ON FUNCTION org_coverage_end(p_id uuid, p_reason text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION org_coverage_set(p_unit_id uuid, p_covered_unit_id uuid, p_reason text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION org_unit_close(p_id uuid, p_reason text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION org_unit_create(p_code text, p_name text, p_unit_type text, p_parent_id uuid, p_region_code text, p_function_code text, p_reason text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION org_unit_update(p_id uuid, p_name text, p_parent_id uuid, p_region_code text, p_function_code text, p_reason text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION routing_rule_set(p_work_type text, p_region_code text, p_handling_unit_id uuid, p_reason text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION org_coverage_end(p_id uuid, p_reason text) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION org_coverage_set(p_unit_id uuid, p_covered_unit_id uuid, p_reason text) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION org_unit_close(p_id uuid, p_reason text) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION org_unit_create(p_code text, p_name text, p_unit_type text, p_parent_id uuid, p_region_code text, p_function_code text, p_reason text) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION org_unit_update(p_id uuid, p_name text, p_parent_id uuid, p_region_code text, p_function_code text, p_reason text) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION routing_rule_set(p_work_type text, p_region_code text, p_handling_unit_id uuid, p_reason text) TO int_sysadmin;

GRANT SELECT ON TABLE org_units TO int_auditor;

GRANT SELECT ON TABLE org_units TO int_compliance;

GRANT SELECT ON TABLE org_units TO int_coordinator;

GRANT SELECT ON TABLE org_units TO int_finance;

GRANT SELECT ON TABLE org_units TO int_hr;

GRANT SELECT ON TABLE org_units TO int_manager;

GRANT SELECT ON TABLE org_units TO int_surveyor;

GRANT SELECT ON TABLE org_units TO int_sysadmin;

GRANT SELECT ON TABLE org_units TO int_viewer;
