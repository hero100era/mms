-- Drop api.ships and replace legacy ship_status / ship_type / gross_tons / administration_types cleanly before FK validation
drop view if exists api.ships;

alter table if exists fleet.ship
  drop constraint if exists ship_status_ck,
  drop column if exists ship_status;

alter table core.ship_status
  alter column code type varchar(20);

insert into core.ship_status (code, name) values
  ('in_service', 'In Service'),
  ('laid_up', 'Laid Up'),
  ('under_construction', 'Under Construction'),
  ('decommissioned', 'Decommissioned')
on conflict (code) do update set name = excluded.name;

delete from core.ship_status where code in ('E', 'L', 'P');

-- Migrate existing fleet.ship rows if any exist in an already-seeded environment
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'fleet' and table_name = 'ship' and column_name = 'gross_tons') then
    update fleet.ship set gross_tonnage = coalesce(gross_tonnage, gross_tons::int);
  end if;
  if exists (select 1 from core.vessel_type_mms where code = 'OC') then
    update fleet.ship set type_mms = coalesce(type_mms, 'OC');
  end if;
end $$;
