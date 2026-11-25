-- ===== schema: core  (pgschema 1.14.1) =====

set local search_path = core;

DROP SEQUENCE IF EXISTS breakdown_template_id_seq CASCADE;

DROP SEQUENCE IF EXISTS breakdown_template_node_id_seq CASCADE;

DROP SEQUENCE IF EXISTS breakdown_template_node_particular_id_seq CASCADE;

DROP SEQUENCE IF EXISTS checklist_item_id_seq CASCADE;

DROP SEQUENCE IF EXISTS checklist_item_particular_id_seq CASCADE;

DROP SEQUENCE IF EXISTS checklist_section_id_seq CASCADE;

DROP SEQUENCE IF EXISTS class_notation_id_seq CASCADE;

DROP SEQUENCE IF EXISTS flag_cert_authorization_id_seq CASCADE;

DROP SEQUENCE IF EXISTS flag_survey_authorization_id_seq CASCADE;

DROP SEQUENCE IF EXISTS notation_compatibility_id_seq CASCADE;

DROP SEQUENCE IF EXISTS notation_group_id_seq CASCADE;

DROP SEQUENCE IF EXISTS society_group_rendering_id_seq CASCADE;

DROP SEQUENCE IF EXISTS survey_documentation_id_seq CASCADE;

DROP SEQUENCE IF EXISTS survey_pool_id_seq CASCADE;

DROP SEQUENCE IF EXISTS survey_preparation_id_seq CASCADE;

DROP SEQUENCE IF EXISTS survey_preparation_section_id_seq CASCADE;

ALTER TABLE core.breakdown_template ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;

SELECT setval(pg_get_serial_sequence('core.breakdown_template', 'id'), COALESCE(MAX(id), 0) + 1) FROM core.breakdown_template;

ALTER TABLE core.breakdown_template_node ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;

SELECT setval(pg_get_serial_sequence('core.breakdown_template_node', 'id'), COALESCE(MAX(id), 0) + 1) FROM core.breakdown_template_node;

ALTER TABLE core.breakdown_template_node_particular ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;

SELECT setval(pg_get_serial_sequence('core.breakdown_template_node_particular', 'id'), COALESCE(MAX(id), 0) + 1) FROM core.breakdown_template_node_particular;

ALTER TABLE core.checklist_item ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;

SELECT setval(pg_get_serial_sequence('core.checklist_item', 'id'), COALESCE(MAX(id), 0) + 1) FROM core.checklist_item;

ALTER TABLE core.checklist_item_particular ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;

SELECT setval(pg_get_serial_sequence('core.checklist_item_particular', 'id'), COALESCE(MAX(id), 0) + 1) FROM core.checklist_item_particular;

ALTER TABLE core.checklist_section ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;

SELECT setval(pg_get_serial_sequence('core.checklist_section', 'id'), COALESCE(MAX(id), 0) + 1) FROM core.checklist_section;

ALTER TABLE core.class_notation ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;

SELECT setval(pg_get_serial_sequence('core.class_notation', 'id'), COALESCE(MAX(id), 0) + 1) FROM core.class_notation;

ALTER TABLE core.flag_cert_authorization ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;

SELECT setval(pg_get_serial_sequence('core.flag_cert_authorization', 'id'), COALESCE(MAX(id), 0) + 1) FROM core.flag_cert_authorization;

ALTER TABLE core.flag_survey_authorization ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;

SELECT setval(pg_get_serial_sequence('core.flag_survey_authorization', 'id'), COALESCE(MAX(id), 0) + 1) FROM core.flag_survey_authorization;

ALTER TABLE core.notation_compatibility ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;

SELECT setval(pg_get_serial_sequence('core.notation_compatibility', 'id'), COALESCE(MAX(id), 0) + 1) FROM core.notation_compatibility;

ALTER TABLE core.notation_group ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;

SELECT setval(pg_get_serial_sequence('core.notation_group', 'id'), COALESCE(MAX(id), 0) + 1) FROM core.notation_group;

ALTER TABLE core.society_group_rendering ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;

SELECT setval(pg_get_serial_sequence('core.society_group_rendering', 'id'), COALESCE(MAX(id), 0) + 1) FROM core.society_group_rendering;

ALTER TABLE core.survey_documentation ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;

SELECT setval(pg_get_serial_sequence('core.survey_documentation', 'id'), COALESCE(MAX(id), 0) + 1) FROM core.survey_documentation;

ALTER TABLE core.survey_pool ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;

SELECT setval(pg_get_serial_sequence('core.survey_pool', 'id'), COALESCE(MAX(id), 0) + 1) FROM core.survey_pool;

ALTER TABLE core.survey_preparation ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;

SELECT setval(pg_get_serial_sequence('core.survey_preparation', 'id'), COALESCE(MAX(id), 0) + 1) FROM core.survey_preparation;

ALTER TABLE core.survey_preparation_section ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;

SELECT setval(pg_get_serial_sequence('core.survey_preparation_section', 'id'), COALESCE(MAX(id), 0) + 1) FROM core.survey_preparation_section;

-- ===== schema: fleet  (pgschema 1.14.1) =====

set local search_path = fleet;

DROP SEQUENCE IF EXISTS ship_breakdown_id_seq CASCADE;

DROP SEQUENCE IF EXISTS ship_breakdown_node_id_seq CASCADE;

ALTER TABLE fleet.ship_breakdown ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;

SELECT setval(pg_get_serial_sequence('fleet.ship_breakdown', 'id'), COALESCE(MAX(id), 0) + 1) FROM fleet.ship_breakdown;

ALTER TABLE fleet.ship_breakdown_node ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;

SELECT setval(pg_get_serial_sequence('fleet.ship_breakdown_node', 'id'), COALESCE(MAX(id), 0) + 1) FROM fleet.ship_breakdown_node;
