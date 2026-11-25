CREATE INDEX CONCURRENTLY IF NOT EXISTS breakdown_template_parent_ix ON core.breakdown_template (parent_template_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS breakdown_template_node_parent_ix ON core.breakdown_template_node (template_id, parent_node_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS breakdown_template_node_template_ix ON core.breakdown_template_node (template_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS breakdown_template_node_part_node_ix ON core.breakdown_template_node_particular (template_node_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS certificate_template_category_ix ON core.certificate_template (category);

CREATE INDEX CONCURRENTLY IF NOT EXISTS certificate_template_cert_code_ix ON core.certificate_template (cert_code);

CREATE INDEX CONCURRENTLY IF NOT EXISTS certificate_template_internal_cat_ix ON core.certificate_template (internal_category);

CREATE INDEX CONCURRENTLY IF NOT EXISTS certificate_template_validity_type_ix ON core.certificate_template (validity_type);

CREATE INDEX CONCURRENTLY IF NOT EXISTS checklist_item_ref_item_id_ix ON core.checklist_item (referenced_item_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS checklist_item_section_id_ix ON core.checklist_item (section_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS checklist_item_tnode_id_ix ON core.checklist_item (breakdown_template_node_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS checklist_item_part_item_id_ix ON core.checklist_item_particular (checklist_item_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS checklist_section_survey_id_ix ON core.checklist_section (survey_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS class_notation_group_ix ON core.class_notation (group_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS class_notation_society_ix ON core.class_notation (society_code);

CREATE INDEX CONCURRENTLY IF NOT EXISTS class_notation_superseded_ix ON core.class_notation (superseded_by);

CREATE INDEX CONCURRENTLY IF NOT EXISTS flag_cert_auth_cert_code_ix ON core.flag_cert_authorization (cert_code);

CREATE INDEX CONCURRENTLY IF NOT EXISTS flag_cert_auth_flag_code_ix ON core.flag_cert_authorization (flag_code);

CREATE INDEX CONCURRENTLY IF NOT EXISTS flag_survey_auth_cert_code_ix ON core.flag_survey_authorization (cert_code);

CREATE INDEX CONCURRENTLY IF NOT EXISTS flag_survey_auth_flag_code_ix ON core.flag_survey_authorization (flag_code);

CREATE INDEX CONCURRENTLY IF NOT EXISTS notation_compat_notation_ix ON core.notation_compatibility (notation_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS notation_compat_related_ix ON core.notation_compatibility (related_notation_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS report_template_survey_id_ix ON core.report_template (survey_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS society_group_rendering_group_ix ON core.society_group_rendering (group_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS society_group_rendering_society_ix ON core.society_group_rendering (society_code);

CREATE INDEX CONCURRENTLY IF NOT EXISTS survey_doc_survey_id_ix ON core.survey_documentation (survey_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS survey_pool_cert_code_ix ON core.survey_pool (cert_code);

CREATE INDEX CONCURRENTLY IF NOT EXISTS survey_pool_type_ix ON core.survey_pool (type);

CREATE INDEX CONCURRENTLY IF NOT EXISTS survey_prep_survey_id_ix ON core.survey_preparation (survey_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS survey_prep_section_survey_id_ix ON core.survey_preparation_section (survey_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS change_log_row_key_ix ON audit_trail.change_log (schema_name, table_name, row_key);
