-- ===== schema: audit_trail  (pgschema 1.13.4) =====

set local search_path = audit_trail;

ALTER TABLE controlled_column DROP CONSTRAINT controlled_column_event_fk;
