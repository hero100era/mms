-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION demo_claim(
    p_claim text
)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> p_claim;
$$;

CREATE OR REPLACE FUNCTION demo_active_role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  select private.demo_claim('role');
$$;

CREATE OR REPLACE FUNCTION demo_my_units()
RETURNS TABLE(unit_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select covered_unit_id as unit_id
    from core.demo_org_coverage
   where org_unit_id = nullif(private.demo_claim('org_unit_id'), '')::uuid
  union
  select nullif(private.demo_claim('org_unit_id'), '')::uuid;
$$;

REVOKE EXECUTE ON FUNCTION demo_active_role() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION demo_claim(p_claim text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION demo_my_units() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION demo_active_role() TO int_manager;

GRANT EXECUTE ON FUNCTION demo_active_role() TO int_surveyor;

GRANT EXECUTE ON FUNCTION demo_active_role() TO int_viewer;

GRANT EXECUTE ON FUNCTION demo_claim(p_claim text) TO int_manager;

GRANT EXECUTE ON FUNCTION demo_claim(p_claim text) TO int_surveyor;

GRANT EXECUTE ON FUNCTION demo_claim(p_claim text) TO int_viewer;

GRANT EXECUTE ON FUNCTION demo_my_units() TO int_manager;

GRANT EXECUTE ON FUNCTION demo_my_units() TO int_surveyor;

GRANT EXECUTE ON FUNCTION demo_my_units() TO int_viewer;

-- ===== schema: core  (pgschema 1.13.4) =====

set local search_path = core;

CREATE TABLE IF NOT EXISTS demo_org_unit (
    id uuid DEFAULT uuidv7(),
    parent_id uuid,
    kind text NOT NULL,
    name text NOT NULL,
    CONSTRAINT demo_org_unit_pkey PRIMARY KEY (id),
    CONSTRAINT demo_org_unit_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES demo_org_unit (id),
    CONSTRAINT demo_org_unit_kind_check CHECK (kind IN ('station'::text, 'region'::text, 'mts'::text, 'plan_centre'::text, 'global'::text))
);

CREATE TABLE IF NOT EXISTS demo_org_coverage (
    org_unit_id uuid,
    covered_unit_id uuid,
    CONSTRAINT demo_org_coverage_pkey PRIMARY KEY (org_unit_id, covered_unit_id),
    CONSTRAINT demo_org_coverage_covered_unit_id_fkey FOREIGN KEY (covered_unit_id) REFERENCES demo_org_unit (id) ON DELETE CASCADE,
    CONSTRAINT demo_org_coverage_org_unit_id_fkey FOREIGN KEY (org_unit_id) REFERENCES demo_org_unit (id) ON DELETE CASCADE
);

-- ===== schema: party  (pgschema 1.13.4) =====

set local search_path = party;

CREATE TABLE IF NOT EXISTS demo_case (
    id uuid DEFAULT uuidv7(),
    handling_unit_id uuid NOT NULL,
    title text NOT NULL,
    status text DEFAULT 'open' NOT NULL,
    CONSTRAINT demo_case_pkey PRIMARY KEY (id),
    CONSTRAINT demo_case_status_check CHECK (status IN ('open'::text, 'closed'::text))
);

ALTER TABLE demo_case ENABLE ROW LEVEL SECURITY;

CREATE POLICY demo_case_select ON demo_case FOR SELECT TO int_manager, int_surveyor, int_viewer USING (handling_unit_id IN ( SELECT demo_my_units.unit_id FROM private.demo_my_units() demo_my_units(unit_id)));

CREATE TABLE IF NOT EXISTS demo_job (
    id uuid DEFAULT uuidv7(),
    office_unit_id uuid NOT NULL,
    title text NOT NULL,
    internal_note text,
    status text DEFAULT 'draft' NOT NULL,
    CONSTRAINT demo_job_pkey PRIMARY KEY (id),
    CONSTRAINT demo_job_status_check CHECK (status IN ('draft'::text, 'submitted'::text))
);

ALTER TABLE demo_job ENABLE ROW LEVEL SECURITY;

CREATE POLICY demo_job_insert ON demo_job FOR INSERT TO int_manager, int_surveyor, int_viewer WITH CHECK (office_unit_id IN ( SELECT demo_my_units.unit_id FROM private.demo_my_units() demo_my_units(unit_id)));

CREATE POLICY demo_job_select ON demo_job FOR SELECT TO int_manager, int_surveyor, int_viewer USING (office_unit_id IN ( SELECT demo_my_units.unit_id FROM private.demo_my_units() demo_my_units(unit_id)));

ALTER TABLE demo_case
ADD CONSTRAINT demo_case_handling_unit_id_fkey FOREIGN KEY (handling_unit_id) REFERENCES core.demo_org_unit (id);

ALTER TABLE demo_job
ADD CONSTRAINT demo_job_office_unit_id_fkey FOREIGN KEY (office_unit_id) REFERENCES core.demo_org_unit (id);

GRANT SELECT (handling_unit_id, id, status, title) ON TABLE demo_case TO int_manager;

GRANT SELECT (handling_unit_id, id, status, title) ON TABLE demo_case TO int_surveyor;

GRANT SELECT (handling_unit_id, id, status, title) ON TABLE demo_case TO int_viewer;

GRANT SELECT (id, status) ON TABLE demo_job TO int_manager;

GRANT SELECT (id, status) ON TABLE demo_job TO int_surveyor;

GRANT SELECT (id, status) ON TABLE demo_job TO int_viewer;

GRANT INSERT (office_unit_id, title), SELECT (office_unit_id, title) ON TABLE demo_job TO int_manager;

GRANT INSERT (office_unit_id, title), SELECT (office_unit_id, title) ON TABLE demo_job TO int_surveyor;

GRANT INSERT (office_unit_id, title), SELECT (office_unit_id, title) ON TABLE demo_job TO int_viewer;

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION demo_job_draft(
    p_title text
)
RETURNS TABLE(id uuid, title text, status text)
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
declare
  v_unit uuid := nullif(private.demo_claim('org_unit_id'), '')::uuid;
begin
  if v_unit is null then
    raise exception 'missing_org_unit';
  end if;
  return query
    insert into party.demo_job (office_unit_id, title)
    values (v_unit, p_title)
    returning demo_job.id, demo_job.title, demo_job.status;
end;
$$;

CREATE OR REPLACE FUNCTION demo_job_submit(
    p_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if private.demo_active_role() not in ('int_surveyor', 'int_manager') then
    raise exception 'insufficient_authority';
  end if;
  if not exists (
    select 1 from party.demo_job j
     where j.id = p_id
       and j.office_unit_id in (select unit_id from private.demo_my_units())
  ) then
    raise exception 'out_of_scope';
  end if;
  update party.demo_job set status = 'submitted' where id = p_id;
end;
$$;

CREATE OR REPLACE VIEW demo_cases WITH (security_invoker=true) AS
 SELECT id,
    handling_unit_id,
    title,
    status
   FROM party.demo_case;

CREATE OR REPLACE VIEW demo_jobs WITH (security_invoker=true) AS
 SELECT id,
    office_unit_id,
    title,
    status
   FROM party.demo_job;

REVOKE EXECUTE ON FUNCTION demo_job_draft(p_title text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION demo_job_submit(p_id uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION demo_job_draft(p_title text) TO int_manager;

GRANT EXECUTE ON FUNCTION demo_job_draft(p_title text) TO int_surveyor;

GRANT EXECUTE ON FUNCTION demo_job_draft(p_title text) TO int_viewer;

GRANT EXECUTE ON FUNCTION demo_job_submit(p_id uuid) TO int_manager;

GRANT EXECUTE ON FUNCTION demo_job_submit(p_id uuid) TO int_surveyor;

GRANT SELECT ON TABLE demo_cases TO int_manager;

GRANT SELECT ON TABLE demo_cases TO int_surveyor;

GRANT SELECT ON TABLE demo_cases TO int_viewer;

GRANT SELECT ON TABLE demo_jobs TO int_manager;

GRANT SELECT ON TABLE demo_jobs TO int_surveyor;

GRANT SELECT ON TABLE demo_jobs TO int_viewer;
