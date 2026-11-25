-- ===== schema: core  (pgschema 1.13.4) =====

set local search_path = core;

ALTER TABLE org_unit_coverage DROP CONSTRAINT org_unit_coverage_valid_bounds_ck;

ALTER TABLE core.org_unit_coverage
ADD CONSTRAINT org_unit_coverage_valid_bounds_ck CHECK (isempty(valid) OR lower_inc(valid) AND NOT upper_inc(valid)) NOT VALID;

ALTER TABLE core.org_unit_coverage VALIDATE CONSTRAINT org_unit_coverage_valid_bounds_ck;

-- ===== schema: iam  (pgschema 1.13.4) =====

set local search_path = iam;

ALTER TABLE org_membership DROP CONSTRAINT org_membership_valid_bounds_ck;

ALTER TABLE iam.org_membership
ADD CONSTRAINT org_membership_valid_bounds_ck CHECK (isempty(valid) OR lower_inc(valid) AND NOT upper_inc(valid)) NOT VALID;

ALTER TABLE iam.org_membership VALIDATE CONSTRAINT org_membership_valid_bounds_ck;

ALTER TABLE role_assignment DROP CONSTRAINT role_assignment_valid_bounds_ck;

ALTER TABLE iam.role_assignment
ADD CONSTRAINT role_assignment_valid_bounds_ck CHECK (isempty(valid) OR lower_inc(valid) AND NOT upper_inc(valid)) NOT VALID;

ALTER TABLE iam.role_assignment VALIDATE CONSTRAINT role_assignment_valid_bounds_ck;

ALTER TABLE staff_position DROP CONSTRAINT staff_position_valid_bounds_ck;

ALTER TABLE iam.staff_position
ADD CONSTRAINT staff_position_valid_bounds_ck CHECK (isempty(valid) OR lower_inc(valid) AND NOT upper_inc(valid)) NOT VALID;

ALTER TABLE iam.staff_position VALIDATE CONSTRAINT staff_position_valid_bounds_ck;
