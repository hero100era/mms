-- Idempotent backfill for materialized org_unit level and ltree path.
with recursive tree as (
  select u.id,
         0 as level,
         coalesce(
           nullif(regexp_replace(u.code, '[^A-Za-z0-9_]', '_', 'g'), ''),
           replace(u.id::text, '-', '_')
         )::extensions.ltree as path
    from core.org_unit u
   where u.parent_id is null
  union all
  select c.id,
         t.level + 1 as level,
         t.path operator(extensions.||) coalesce(
           nullif(regexp_replace(c.code, '[^A-Za-z0-9_]', '_', 'g'), ''),
           replace(c.id::text, '-', '_')
         )::extensions.ltree as path
    from core.org_unit c
    join tree t on c.parent_id = t.id
)
update core.org_unit u
   set level = t.level,
       path = t.path
  from tree t
 where u.id = t.id
   and (u.level is distinct from t.level or u.path::text is distinct from t.path::text);
