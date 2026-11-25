# Migration review: 20261121T100410Z_core-general-catalogue

- [x] No renames outside `pre.sql`.
- [x] Destructive statements have an `allow-destructive` line with a ticket and reason.
- [x] Large-table index/constraint changes use `CONCURRENTLY` or `NOT VALID` then `VALIDATE`.
- [x] Backfills are in `post.sql` and are idempotent.
- [x] Regulated-data impact reviewed.
- [x] `nontx.sql` statements are independent of the transactional part.
- [x] Round-trip plan is empty (the generator checks this).

## Summary

Adds foundational maritime classification and survey catalogue tables to the `core` schema:
- Enumerations: `certificate_applicability_enum`, `task_status_enum`, `survey_status_enum`, `data_type_enum`, `notation_status_enum`, `compatibility_type_enum`.
- Classification reference tables: `administration_type`, `class_status`, `ship_status`, `certificate_status`, `certificate_validity_type`, `certificate_category`, `certificate_internal_category`, `certificate_action`, `survey_audit_status`, `comment_type`, `comment_status`, `classification_society`, `vessel_type_iacs`, `vessel_type_mms`, `certificate_survey_pool`, `survey_audit_type`, `flag`.
- Templates and breakdown structures: `certificate_template`, `survey_pool`, `report_template`, `checklist_result`, `breakdown_template`, `breakdown_template_node`, `breakdown_template_node_particular`, `checklist_section`, `checklist_item`, `checklist_item_particular`.
- Survey authorization and preparation: `flag_cert_authorization`, `flag_survey_authorization`, `survey_preparation_section`, `survey_preparation`, `survey_documentation`.
- Class notation catalog and rules: `notation_group`, `society_group_rendering`, `class_notation`, `notation_compatibility`.

## Destructive changes

None (additive new tables and types only).

## Rollback / Forward-Fix Strategy

Purely additive new tables and enum types with no destructive alterations. In case of issues prior to dependent usage, forward-fix via subsequent migration or rollback by dropping the added tables and types in reverse dependency order.

