-- Drop view depending on fleet.ship_breakdown.applied_by before altering column type to uuid
drop view if exists api.ship_breakdowns;
