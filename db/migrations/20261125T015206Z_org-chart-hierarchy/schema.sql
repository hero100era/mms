-- ===== schema: private  (pgschema 1.14.1) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION is_internal_caller()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  select coalesce(private.active_role(), '') in (
    'int_viewer', 'int_surveyor', 'int_auditor', 'int_coordinator',
    'int_manager', 'int_compliance', 'int_hr', 'int_finance', 'int_sysadmin'
  );
$$;

CREATE OR REPLACE FUNCTION org_chart_direct_reports_count(
    p_user_id uuid
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select case
    when private.is_internal_caller() then (
      select count(*)
        from iam.staff_position p
        join iam.app_user u on u.id = p.user_id
       where p.line_manager_id = p_user_id
         and p.valid @> now()
         and u.kind = 'internal'
         and u.status in ('active', 'invited')
    )
    else 0::bigint
  end;
$$;

CREATE OR REPLACE FUNCTION org_unit_path_cascade()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if old.path::text is distinct from new.path::text or old.level is distinct from new.level then
    update core.org_unit
       set parent_id = parent_id
     where parent_id = new.id;
  end if;
  return null;
end;
$$;

REVOKE EXECUTE ON FUNCTION is_internal_caller() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION org_chart_direct_reports_count(p_user_id uuid) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION org_unit_path_cascade() FROM PUBLIC;

CREATE OR REPLACE FUNCTION org_unit_tree_check()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_parent_type text;
  v_parent_level int;
  v_parent_path extensions.ltree;
  v_parent_code text;
  v_label text;
  v_cycle boolean;
begin
  v_label := coalesce(
    nullif(regexp_replace(new.code, '[^A-Za-z0-9_]', '_', 'g'), ''),
    replace(new.id::text, '-', '_')
  );

  if new.parent_id is null then
    if new.unit_type <> 'head_office' then
      raise exception 'org_unit_parent_required';
    end if;
    new.level := 0;
    new.path := v_label::extensions.ltree;
  else
    if new.unit_type = 'head_office' then
      raise exception 'org_unit_head_office_has_no_parent';
    end if;

    select unit_type, level, path, code
      into v_parent_type, v_parent_level, v_parent_path, v_parent_code
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

    new.level := coalesce(v_parent_level, 0) + 1;
    if v_parent_path is null then
      v_parent_path := coalesce(
        nullif(regexp_replace(v_parent_code, '[^A-Za-z0-9_]', '_', 'g'), ''),
        replace(new.parent_id::text, '-', '_')
      )::extensions.ltree;
    end if;
    new.path := v_parent_path operator(extensions.||) v_label::extensions.ltree;
  end if;

  if new.unit_type in ('regional_office', 'station', 'mts_centre') and new.region_code is null then
    raise exception 'org_unit_region_required';
  end if;

  return new;
end;
$$;

CREATE OR REPLACE FUNCTION user_directory_line_manager(
    p_user_id uuid
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select case
    when private.is_internal_caller() then p.line_manager_id
    else null
  end
  from iam.staff_position p
  where p.user_id = p_user_id
    and p.valid @> now()
  order by upper(p.valid) nulls last
  limit 1;
$$;

GRANT EXECUTE ON FUNCTION is_internal_caller() TO int_auditor;

GRANT EXECUTE ON FUNCTION is_internal_caller() TO int_compliance;

GRANT EXECUTE ON FUNCTION is_internal_caller() TO int_coordinator;

GRANT EXECUTE ON FUNCTION is_internal_caller() TO int_finance;

GRANT EXECUTE ON FUNCTION is_internal_caller() TO int_hr;

GRANT EXECUTE ON FUNCTION is_internal_caller() TO int_manager;

GRANT EXECUTE ON FUNCTION is_internal_caller() TO int_surveyor;

GRANT EXECUTE ON FUNCTION is_internal_caller() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION is_internal_caller() TO int_viewer;

GRANT EXECUTE ON FUNCTION org_chart_direct_reports_count(p_user_id uuid) TO int_auditor;

GRANT EXECUTE ON FUNCTION org_chart_direct_reports_count(p_user_id uuid) TO int_compliance;

GRANT EXECUTE ON FUNCTION org_chart_direct_reports_count(p_user_id uuid) TO int_coordinator;

GRANT EXECUTE ON FUNCTION org_chart_direct_reports_count(p_user_id uuid) TO int_finance;

GRANT EXECUTE ON FUNCTION org_chart_direct_reports_count(p_user_id uuid) TO int_hr;

GRANT EXECUTE ON FUNCTION org_chart_direct_reports_count(p_user_id uuid) TO int_manager;

GRANT EXECUTE ON FUNCTION org_chart_direct_reports_count(p_user_id uuid) TO int_surveyor;

GRANT EXECUTE ON FUNCTION org_chart_direct_reports_count(p_user_id uuid) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION org_chart_direct_reports_count(p_user_id uuid) TO int_viewer;

-- ===== schema: core  (pgschema 1.14.1) =====

set local search_path = core;

ALTER TABLE org_unit
ADD COLUMN level integer DEFAULT 0 NOT NULL CONSTRAINT org_unit_level_ck CHECK (level >= 0);

ALTER TABLE org_unit ADD COLUMN path extensions.ltree;

CREATE OR REPLACE TRIGGER org_unit_path_cascade
    AFTER UPDATE OF code, parent_id ON org_unit
    FOR EACH ROW
    EXECUTE FUNCTION private.org_unit_path_cascade();

-- ===== schema: api  (pgschema 1.14.1) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION org_chart_management_chain(
    p_user_id uuid
)
RETURNS TABLE(user_id uuid, display_name text, email text, job_title_code text, job_title text, job_family text, unit_id uuid, unit_code text, unit_name text, unit_type text, line_manager_id uuid, direct_reports_count bigint, level integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
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

CREATE OR REPLACE FUNCTION org_chart_peers(
    p_user_id uuid
)
RETURNS TABLE(user_id uuid, display_name text, email text, job_title_code text, job_title text, job_family text, unit_id uuid, unit_code text, unit_name text, unit_type text, line_manager_id uuid, direct_reports_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
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

CREATE OR REPLACE FUNCTION org_chart_reports(
    p_manager_id uuid,
    p_max_depth integer DEFAULT NULL
)
RETURNS TABLE(user_id uuid, display_name text, email text, job_title_code text, job_title text, job_family text, unit_id uuid, unit_code text, unit_name text, unit_type text, line_manager_id uuid, direct_reports_count bigint, level integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
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

CREATE OR REPLACE FUNCTION org_chart_for_user(
    p_user_id uuid DEFAULT NULL
)
RETURNS TABLE(relation text, level integer, user_id uuid, display_name text, email text, job_title_code text, job_title text, job_family text, unit_id uuid, unit_code text, unit_name text, unit_type text, line_manager_id uuid, direct_reports_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
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

CREATE OR REPLACE VIEW org_chart_nodes WITH (security_invoker=true) AS
 SELECT u.id AS user_id,
    u.display_name,
    u.email,
    u.status,
    p.job_title_code,
    jt.label_en AS job_title,
    jt.label_zh AS job_title_zh,
    p.job_family,
    p.unit_id,
    ou.code AS unit_code,
    ou.name AS unit_name,
    ou.unit_type,
    ou.region_code,
    ou.path::text AS unit_path,
    lm.line_manager_id,
    m.display_name AS manager_name,
    m.email AS manager_email,
    mp.job_title_code AS manager_job_title_code,
    mjt.label_en AS manager_job_title,
    private.org_chart_direct_reports_count(u.id) AS direct_reports_count
   FROM iam.app_user u
     LEFT JOIN iam.staff_position p ON p.user_id = u.id AND p.valid @> now()
     LEFT JOIN iam.job_title jt ON jt.code = p.job_title_code
     LEFT JOIN core.org_unit ou ON ou.id = p.unit_id
     CROSS JOIN LATERAL ( SELECT private.user_directory_line_manager(u.id) AS line_manager_id) lm
     LEFT JOIN iam.app_user m ON m.id = lm.line_manager_id AND m.kind = 'internal'::text AND (m.status = ANY (ARRAY['active'::text, 'invited'::text]))
     LEFT JOIN iam.staff_position mp ON mp.user_id = m.id AND mp.valid @> now()
     LEFT JOIN iam.job_title mjt ON mjt.code = mp.job_title_code
  WHERE u.kind = 'internal'::text AND (u.status = ANY (ARRAY['active'::text, 'invited'::text]));

CREATE OR REPLACE VIEW org_unit_hierarchy WITH (security_invoker=true) AS
 WITH RECURSIVE tree AS (
         SELECT u.id,
            u.code,
            u.name,
            u.unit_type,
            u.parent_id,
            u.region_code,
            u.function_code,
            u.active,
            u.level,
            u.path::text AS path,
            ARRAY[u.name] AS path_names,
            ARRAY[u.id] AS path_ids,
            ARRAY[u.code] AS path_codes
           FROM core.org_unit u
          WHERE u.parent_id IS NULL
        UNION ALL
         SELECT u.id,
            u.code,
            u.name,
            u.unit_type,
            u.parent_id,
            u.region_code,
            u.function_code,
            u.active,
            u.level,
            u.path::text AS path,
            t_1.path_names || u.name,
            t_1.path_ids || u.id,
            t_1.path_codes || u.code
           FROM core.org_unit u
             JOIN tree t_1 ON u.parent_id = t_1.id
          WHERE NOT (u.id = ANY (t_1.path_ids))
        )
 SELECT id,
    code,
    name,
    unit_type,
    parent_id,
    region_code,
    function_code,
    active,
    level,
    path,
    array_to_string(path_names, ' > '::text) AS full_path,
    path_ids,
    path_codes,
    ( SELECT count(*) AS count
           FROM iam.staff_position p
             JOIN iam.app_user au ON au.id = p.user_id
          WHERE p.unit_id = t.id AND p.valid @> now() AND au.kind = 'internal'::text AND (au.status = ANY (ARRAY['active'::text, 'invited'::text]))) AS direct_staff_count
   FROM tree t;

REVOKE EXECUTE ON FUNCTION org_chart_for_user(p_user_id uuid) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION org_chart_management_chain(p_user_id uuid) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION org_chart_peers(p_user_id uuid) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION org_chart_reports(p_manager_id uuid, p_max_depth integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION org_chart_for_user(p_user_id uuid) TO int_auditor;

GRANT EXECUTE ON FUNCTION org_chart_for_user(p_user_id uuid) TO int_compliance;

GRANT EXECUTE ON FUNCTION org_chart_for_user(p_user_id uuid) TO int_coordinator;

GRANT EXECUTE ON FUNCTION org_chart_for_user(p_user_id uuid) TO int_finance;

GRANT EXECUTE ON FUNCTION org_chart_for_user(p_user_id uuid) TO int_hr;

GRANT EXECUTE ON FUNCTION org_chart_for_user(p_user_id uuid) TO int_manager;

GRANT EXECUTE ON FUNCTION org_chart_for_user(p_user_id uuid) TO int_surveyor;

GRANT EXECUTE ON FUNCTION org_chart_for_user(p_user_id uuid) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION org_chart_for_user(p_user_id uuid) TO int_viewer;

GRANT EXECUTE ON FUNCTION org_chart_management_chain(p_user_id uuid) TO int_auditor;

GRANT EXECUTE ON FUNCTION org_chart_management_chain(p_user_id uuid) TO int_compliance;

GRANT EXECUTE ON FUNCTION org_chart_management_chain(p_user_id uuid) TO int_coordinator;

GRANT EXECUTE ON FUNCTION org_chart_management_chain(p_user_id uuid) TO int_finance;

GRANT EXECUTE ON FUNCTION org_chart_management_chain(p_user_id uuid) TO int_hr;

GRANT EXECUTE ON FUNCTION org_chart_management_chain(p_user_id uuid) TO int_manager;

GRANT EXECUTE ON FUNCTION org_chart_management_chain(p_user_id uuid) TO int_surveyor;

GRANT EXECUTE ON FUNCTION org_chart_management_chain(p_user_id uuid) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION org_chart_management_chain(p_user_id uuid) TO int_viewer;

GRANT EXECUTE ON FUNCTION org_chart_peers(p_user_id uuid) TO int_auditor;

GRANT EXECUTE ON FUNCTION org_chart_peers(p_user_id uuid) TO int_compliance;

GRANT EXECUTE ON FUNCTION org_chart_peers(p_user_id uuid) TO int_coordinator;

GRANT EXECUTE ON FUNCTION org_chart_peers(p_user_id uuid) TO int_finance;

GRANT EXECUTE ON FUNCTION org_chart_peers(p_user_id uuid) TO int_hr;

GRANT EXECUTE ON FUNCTION org_chart_peers(p_user_id uuid) TO int_manager;

GRANT EXECUTE ON FUNCTION org_chart_peers(p_user_id uuid) TO int_surveyor;

GRANT EXECUTE ON FUNCTION org_chart_peers(p_user_id uuid) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION org_chart_peers(p_user_id uuid) TO int_viewer;

GRANT EXECUTE ON FUNCTION org_chart_reports(p_manager_id uuid, p_max_depth integer) TO int_auditor;

GRANT EXECUTE ON FUNCTION org_chart_reports(p_manager_id uuid, p_max_depth integer) TO int_compliance;

GRANT EXECUTE ON FUNCTION org_chart_reports(p_manager_id uuid, p_max_depth integer) TO int_coordinator;

GRANT EXECUTE ON FUNCTION org_chart_reports(p_manager_id uuid, p_max_depth integer) TO int_finance;

GRANT EXECUTE ON FUNCTION org_chart_reports(p_manager_id uuid, p_max_depth integer) TO int_hr;

GRANT EXECUTE ON FUNCTION org_chart_reports(p_manager_id uuid, p_max_depth integer) TO int_manager;

GRANT EXECUTE ON FUNCTION org_chart_reports(p_manager_id uuid, p_max_depth integer) TO int_surveyor;

GRANT EXECUTE ON FUNCTION org_chart_reports(p_manager_id uuid, p_max_depth integer) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION org_chart_reports(p_manager_id uuid, p_max_depth integer) TO int_viewer;

GRANT SELECT ON TABLE org_chart_nodes TO int_auditor;

GRANT SELECT ON TABLE org_chart_nodes TO int_compliance;

GRANT SELECT ON TABLE org_chart_nodes TO int_coordinator;

GRANT SELECT ON TABLE org_chart_nodes TO int_finance;

GRANT SELECT ON TABLE org_chart_nodes TO int_hr;

GRANT SELECT ON TABLE org_chart_nodes TO int_manager;

GRANT SELECT ON TABLE org_chart_nodes TO int_surveyor;

GRANT SELECT ON TABLE org_chart_nodes TO int_sysadmin;

GRANT SELECT ON TABLE org_chart_nodes TO int_viewer;

GRANT SELECT ON TABLE org_unit_hierarchy TO int_auditor;

GRANT SELECT ON TABLE org_unit_hierarchy TO int_compliance;

GRANT SELECT ON TABLE org_unit_hierarchy TO int_coordinator;

GRANT SELECT ON TABLE org_unit_hierarchy TO int_finance;

GRANT SELECT ON TABLE org_unit_hierarchy TO int_hr;

GRANT SELECT ON TABLE org_unit_hierarchy TO int_manager;

GRANT SELECT ON TABLE org_unit_hierarchy TO int_surveyor;

GRANT SELECT ON TABLE org_unit_hierarchy TO int_sysadmin;

GRANT SELECT ON TABLE org_unit_hierarchy TO int_viewer;
