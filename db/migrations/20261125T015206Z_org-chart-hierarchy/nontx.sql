CREATE INDEX CONCURRENTLY IF NOT EXISTS org_unit_path_ix ON core.org_unit USING gist (path);

CREATE INDEX CONCURRENTLY IF NOT EXISTS staff_position_line_manager_ix ON iam.staff_position (line_manager_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS staff_position_unit_ix ON iam.staff_position (unit_id);
