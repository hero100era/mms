-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION my_offices()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  with s as (select * from private.my_scope()),
  roots as (
    select unnest(s.unit_ids) as id from s
    union
    select c.covered_unit_id
      from s
      join core.org_unit_coverage c on c.unit_id = any (s.unit_ids)
     where c.valid @> now()
  )
  select case when (select is_global from s) then
           (select coalesce(array_agg(id), '{}') from core.org_unit where unit_type = 'station' and active)
         else
           (select coalesce(array_agg(distinct d.id), '{}')
              from core.org_unit_descendants(array(select id from roots)) d
              join core.org_unit u on u.id = d.id
             where u.unit_type = 'station')
         end;
$$;
