-- ===== schema: core  (pgschema 1.14.1) =====

set local search_path = core;

ALTER TABLE breakdown_template_node_particular ALTER COLUMN attr_key TYPE varchar(100);

-- ===== schema: fleet  (pgschema 1.14.1) =====

set local search_path = fleet;

ALTER TABLE certificate ALTER COLUMN doc_administration TYPE varchar(3) USING doc_administration::varchar(3);

ALTER TABLE fleet.certificate
ADD CONSTRAINT certificate_doc_admin_fk FOREIGN KEY (doc_administration) REFERENCES core.flag (code) NOT VALID;

ALTER TABLE fleet.certificate VALIDATE CONSTRAINT certificate_doc_admin_fk;



ALTER TABLE ship_breakdown_node ALTER COLUMN category TYPE varchar(100);

ALTER TABLE fleet.ship_breakdown_node_particular ADD CONSTRAINT ship_breakdown_node_particular_data_type_not_null NOT NULL data_type NOT VALID;

ALTER TABLE fleet.ship_breakdown_node_particular VALIDATE CONSTRAINT ship_breakdown_node_particular_data_type_not_null;

-- ===== schema: survey  (pgschema 1.14.1) =====

set local search_path = survey;

ALTER TABLE certificate_line ALTER COLUMN doc_administration TYPE varchar(3) USING doc_administration::varchar(3);

ALTER TABLE survey.certificate_line
ADD CONSTRAINT certificate_line_doc_admin_fk FOREIGN KEY (doc_administration) REFERENCES core.flag (code) NOT VALID;

ALTER TABLE survey.certificate_line VALIDATE CONSTRAINT certificate_line_doc_admin_fk;
