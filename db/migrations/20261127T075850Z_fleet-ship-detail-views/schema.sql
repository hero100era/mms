-- ===== schema: fleet  (pgschema 1.14.1) =====

set local search_path = fleet;

ALTER SEQUENCE class_number_seq START WITH 10000 RESTART WITH 10000;

-- ===== schema: api  (pgschema 1.14.1) =====

set local search_path = api;

CREATE OR REPLACE VIEW ship_breakdown_node_particulars WITH (security_invoker=true) AS
 SELECT sbnp.id,
    sbnp.ship_breakdown_node_id,
    sbn.ship_breakdown_id,
    sb.ship_id,
    sbnp.template_particular_id,
    sbnp.attr_key,
    sbnp.attr_title,
    sbnp.attr_value,
    sbnp.selection_options,
    sbnp.data_type,
    sbnp.unit,
    sbnp.is_modified,
    sbnp.sort_order,
    sbnp.created_at,
    sbnp.updated_at
   FROM fleet.ship_breakdown_node_particular sbnp
     JOIN fleet.ship_breakdown_node sbn ON sbn.id = sbnp.ship_breakdown_node_id
     JOIN fleet.ship_breakdown sb ON sb.id = sbn.ship_breakdown_id;

CREATE OR REPLACE VIEW ship_breakdown_nodes WITH (security_invoker=true) AS
 SELECT sbn.id,
    sbn.ship_breakdown_id,
    sb.ship_id,
    sbn.parent_node_id,
    sbn.template_node_id,
    sbn.code,
    sbn.name,
    sbn.description,
    sbn.category,
    sbn.node_type,
    sbn.level,
    sbn.sort_order,
    sbn.is_from_template,
    sbn.is_modified,
    sbn.is_active,
    sbn.metadata,
    sbn.created_at,
    sbn.updated_at
   FROM fleet.ship_breakdown_node sbn
     JOIN fleet.ship_breakdown sb ON sb.id = sbn.ship_breakdown_id;

CREATE OR REPLACE VIEW ship_breakdowns WITH (security_invoker=true) AS
 SELECT id,
    ship_id,
    template_id,
    name,
    description,
    revision,
    is_active,
    applied_at,
    applied_by,
    created_at,
    updated_at
   FROM fleet.ship_breakdown sb;

CREATE OR REPLACE VIEW ship_certificates WITH (security_invoker=true) AS
 SELECT c.id,
    c.certificate_no,
    c.version,
    c.ship_id,
    c.company_id,
    c.certificate_template_code,
    c.status,
    cs.name AS status_name,
    c.remark,
    c.issued_by,
    c.cert_code,
    c.validity_type,
    c.category,
    c.internal_category,
    c.description,
    c.issue_date,
    c.expiry_date,
    c.extended_date,
    c.doc_administration,
    c.is_active,
    c.created_at,
    c.updated_at
   FROM fleet.certificate c
     LEFT JOIN core.certificate_status cs ON cs.code::text = c.status::text;

CREATE OR REPLACE VIEW ship_class_notations WITH (security_invoker=true) AS
 SELECT scn.id,
    scn.ship_id,
    scn.notation_id,
    cn.notation_code,
    cn.notation_symbol,
    cn.notation_name,
    scn.society_code,
    scn.group_id,
    ng.group_code,
    ng.group_name,
    scn.status,
    scn.display_order,
    scn.assigned_date,
    scn.effective_date,
    scn.expiry_date,
    scn.resolved_notation,
    scn.last_survey_date,
    scn.next_survey_due,
    scn.survey_cycle_months,
    scn.remarks,
    scn.is_current,
    scn.created_at,
    scn.updated_at
   FROM fleet.ship_class_notation scn
     JOIN core.class_notation cn ON cn.id = scn.notation_id
     JOIN core.notation_group ng ON ng.id = scn.group_id;

CREATE OR REPLACE VIEW ship_finding_comments WITH (security_invoker=true) AS
 SELECT fc.id,
    fc.ship_id,
    fc.company_id,
    fc.comment_type,
    ct.name AS comment_type_name,
    fc.is_private,
    fc.date_issued,
    fc.place_issued,
    fc.due_date,
    fc.status,
    cs.name AS status_name,
    fc.postponed_due_date,
    fc.mms_reference,
    fc.subject,
    fc.body,
    fc.is_active,
    fc.created_at,
    fc.updated_at
   FROM fleet.finding_comment fc
     LEFT JOIN core.comment_type ct ON ct.code::text = fc.comment_type::text
     LEFT JOIN core.comment_status cs ON cs.code::text = fc.status::text;

CREATE OR REPLACE VIEW ship_parties WITH (security_invoker=true) AS
 SELECT sp.id,
    sp.ship_id,
    sp.org_id,
    o.name AS org_name,
    o.org_type,
    sp.party_role,
    sp.valid,
    sp.valid @> now() AS is_current,
    sp.created_at,
    sp.updated_at
   FROM fleet.ship_party sp
     JOIN party.organization o ON o.id = sp.org_id;

CREATE OR REPLACE VIEW ship_survey_audits WITH (security_invoker=true) AS
 SELECT id,
    ship_id,
    company_id,
    cert_code,
    certificate_id,
    pool_id,
    description,
    last_held_date,
    place_held,
    next_due_date,
    postponement_date,
    survey_status,
    range_from_date,
    range_to_date,
    fee,
    is_ordered,
    is_active,
    created_at,
    updated_at
   FROM fleet.survey_audit sa;

CREATE OR REPLACE VIEW ships WITH (security_invoker=true) AS
 SELECT s.id,
    s.imo_number,
    s.name,
    s.ship_type,
    s.flag_code,
    s.gross_tonnage,
    s.build_year,
    s.status,
    s.responsible_mts_unit_id,
    s.created_at,
    s.updated_at,
    s.class_number,
    s.previous_names,
    s.build_date,
    s.commissioning_date,
    s.keel_laid_date,
    s.contract_date,
    s.class_entry_date,
    s.administration_types,
    s.classed_by,
    s.port_of_registry,
    s.date_of_registry,
    s.registry_number,
    s.call_sign,
    s.official_number,
    s.signal_letter,
    s.mmsi_number,
    s.type_iacs,
    s.type_other,
    s.type_mms,
    s.class_status,
    s.ship_status,
    s.main_class,
    s.dual_class,
    s.gross_tons,
    s.net_tons,
    s.national_tons,
    s.deadweight,
    s.light_ship,
    s.ballast_capacity,
    s.equipment_number,
    s.length,
    s.length_oa,
    s.length_bp,
    s.moulded_depth,
    s.moulded_breadth,
    s.moulded_draft,
    s.design_draft,
    s.breakdown_template_id,
    s.is_active,
    private.org_unit_name(s.responsible_mts_unit_id) AS responsible_mts_unit_name,
    f.fullname AS flag_name,
    vt.name AS type_iacs_name,
    cs.name AS class_status_name,
    ss.name AS ship_status_name
   FROM fleet.ship s
     LEFT JOIN core.flag f ON f.code::text = s.flag_code::text
     LEFT JOIN core.vessel_type_iacs vt ON vt.code::text = s.type_iacs::text
     LEFT JOIN core.class_status cs ON cs.code::text = s.class_status::text
     LEFT JOIN core.ship_status ss ON ss.code::text = s.ship_status::text;

GRANT SELECT ON TABLE ship_breakdown_node_particulars TO ext_user;

GRANT SELECT ON TABLE ship_breakdown_node_particulars TO int_auditor;

GRANT SELECT ON TABLE ship_breakdown_node_particulars TO int_compliance;

GRANT SELECT ON TABLE ship_breakdown_node_particulars TO int_coordinator;

GRANT SELECT ON TABLE ship_breakdown_node_particulars TO int_finance;

GRANT SELECT ON TABLE ship_breakdown_node_particulars TO int_hr;

GRANT SELECT ON TABLE ship_breakdown_node_particulars TO int_manager;

GRANT SELECT ON TABLE ship_breakdown_node_particulars TO int_surveyor;

GRANT SELECT ON TABLE ship_breakdown_node_particulars TO int_sysadmin;

GRANT SELECT ON TABLE ship_breakdown_node_particulars TO int_viewer;

GRANT SELECT ON TABLE ship_breakdown_nodes TO ext_user;

GRANT SELECT ON TABLE ship_breakdown_nodes TO int_auditor;

GRANT SELECT ON TABLE ship_breakdown_nodes TO int_compliance;

GRANT SELECT ON TABLE ship_breakdown_nodes TO int_coordinator;

GRANT SELECT ON TABLE ship_breakdown_nodes TO int_finance;

GRANT SELECT ON TABLE ship_breakdown_nodes TO int_hr;

GRANT SELECT ON TABLE ship_breakdown_nodes TO int_manager;

GRANT SELECT ON TABLE ship_breakdown_nodes TO int_surveyor;

GRANT SELECT ON TABLE ship_breakdown_nodes TO int_sysadmin;

GRANT SELECT ON TABLE ship_breakdown_nodes TO int_viewer;

GRANT SELECT ON TABLE ship_breakdowns TO ext_user;

GRANT SELECT ON TABLE ship_breakdowns TO int_auditor;

GRANT SELECT ON TABLE ship_breakdowns TO int_compliance;

GRANT SELECT ON TABLE ship_breakdowns TO int_coordinator;

GRANT SELECT ON TABLE ship_breakdowns TO int_finance;

GRANT SELECT ON TABLE ship_breakdowns TO int_hr;

GRANT SELECT ON TABLE ship_breakdowns TO int_manager;

GRANT SELECT ON TABLE ship_breakdowns TO int_surveyor;

GRANT SELECT ON TABLE ship_breakdowns TO int_sysadmin;

GRANT SELECT ON TABLE ship_breakdowns TO int_viewer;

GRANT SELECT ON TABLE ship_certificates TO ext_user;

GRANT SELECT ON TABLE ship_certificates TO int_auditor;

GRANT SELECT ON TABLE ship_certificates TO int_compliance;

GRANT SELECT ON TABLE ship_certificates TO int_coordinator;

GRANT SELECT ON TABLE ship_certificates TO int_finance;

GRANT SELECT ON TABLE ship_certificates TO int_hr;

GRANT SELECT ON TABLE ship_certificates TO int_manager;

GRANT SELECT ON TABLE ship_certificates TO int_surveyor;

GRANT SELECT ON TABLE ship_certificates TO int_sysadmin;

GRANT SELECT ON TABLE ship_certificates TO int_viewer;

GRANT SELECT ON TABLE ship_class_notations TO ext_user;

GRANT SELECT ON TABLE ship_class_notations TO int_auditor;

GRANT SELECT ON TABLE ship_class_notations TO int_compliance;

GRANT SELECT ON TABLE ship_class_notations TO int_coordinator;

GRANT SELECT ON TABLE ship_class_notations TO int_finance;

GRANT SELECT ON TABLE ship_class_notations TO int_hr;

GRANT SELECT ON TABLE ship_class_notations TO int_manager;

GRANT SELECT ON TABLE ship_class_notations TO int_surveyor;

GRANT SELECT ON TABLE ship_class_notations TO int_sysadmin;

GRANT SELECT ON TABLE ship_class_notations TO int_viewer;

GRANT SELECT ON TABLE ship_finding_comments TO ext_user;

GRANT SELECT ON TABLE ship_finding_comments TO int_auditor;

GRANT SELECT ON TABLE ship_finding_comments TO int_compliance;

GRANT SELECT ON TABLE ship_finding_comments TO int_coordinator;

GRANT SELECT ON TABLE ship_finding_comments TO int_finance;

GRANT SELECT ON TABLE ship_finding_comments TO int_hr;

GRANT SELECT ON TABLE ship_finding_comments TO int_manager;

GRANT SELECT ON TABLE ship_finding_comments TO int_surveyor;

GRANT SELECT ON TABLE ship_finding_comments TO int_sysadmin;

GRANT SELECT ON TABLE ship_finding_comments TO int_viewer;

GRANT SELECT ON TABLE ship_parties TO ext_user;

GRANT SELECT ON TABLE ship_parties TO int_auditor;

GRANT SELECT ON TABLE ship_parties TO int_compliance;

GRANT SELECT ON TABLE ship_parties TO int_coordinator;

GRANT SELECT ON TABLE ship_parties TO int_finance;

GRANT SELECT ON TABLE ship_parties TO int_hr;

GRANT SELECT ON TABLE ship_parties TO int_manager;

GRANT SELECT ON TABLE ship_parties TO int_surveyor;

GRANT SELECT ON TABLE ship_parties TO int_sysadmin;

GRANT SELECT ON TABLE ship_parties TO int_viewer;

GRANT SELECT ON TABLE ship_survey_audits TO ext_user;

GRANT SELECT ON TABLE ship_survey_audits TO int_auditor;

GRANT SELECT ON TABLE ship_survey_audits TO int_compliance;

GRANT SELECT ON TABLE ship_survey_audits TO int_coordinator;

GRANT SELECT ON TABLE ship_survey_audits TO int_finance;

GRANT SELECT ON TABLE ship_survey_audits TO int_hr;

GRANT SELECT ON TABLE ship_survey_audits TO int_manager;

GRANT SELECT ON TABLE ship_survey_audits TO int_surveyor;

GRANT SELECT ON TABLE ship_survey_audits TO int_sysadmin;

GRANT SELECT ON TABLE ship_survey_audits TO int_viewer;
