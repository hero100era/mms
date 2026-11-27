-- ===== schema: private  (pgschema 1.14.1) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION next_certificate_no()
RETURNS bigint
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  select nextval('fleet.certificate_no_seq');
$$;

REVOKE EXECUTE ON FUNCTION next_certificate_no() FROM PUBLIC;

-- ===== schema: fleet  (pgschema 1.14.1) =====

set local search_path = fleet;

CREATE SEQUENCE IF NOT EXISTS certificate_no_seq START WITH 100000;

CREATE TABLE IF NOT EXISTS certificate (
    id uuid DEFAULT uuidv7(),
    certificate_no bigint DEFAULT nextval('certificate_no_seq'::regclass) NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    ship_id uuid,
    company_id uuid,
    certificate_template_code varchar(10),
    status varchar(2) NOT NULL,
    remark varchar(2) DEFAULT '' NOT NULL,
    issued_by varchar(20) NOT NULL,
    cert_code varchar(10) NOT NULL,
    validity_type varchar(2) NOT NULL,
    category varchar(3) NOT NULL,
    internal_category varchar(3) NOT NULL,
    description varchar(120),
    issue_date date NOT NULL,
    expiry_date date,
    extended_date date,
    mlc_declaration_date date,
    mlc_declaration_place varchar(50),
    doc_administration character(3),
    cert_document_id uuid,
    draft_document_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamptz DEFAULT now() NOT NULL,
    updated_by uuid,
    row_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT certificate_pk PRIMARY KEY (id),
    CONSTRAINT certificate_no_version_uk UNIQUE (certificate_no, version),
    CONSTRAINT certificate_target_ck CHECK (ship_id IS NOT NULL OR company_id IS NOT NULL),
    CONSTRAINT certificate_version_ck CHECK (version >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS certificate_active_no_uk ON certificate (certificate_no) WHERE (is_active IS TRUE);

CREATE INDEX IF NOT EXISTS certificate_cert_code_ix ON certificate (cert_code);

CREATE INDEX IF NOT EXISTS certificate_company_ix ON certificate (company_id);

CREATE INDEX IF NOT EXISTS certificate_ship_ix ON certificate (ship_id);

ALTER TABLE certificate ENABLE ROW LEVEL SECURITY;

CREATE POLICY certificate_ext_read ON certificate FOR SELECT TO ext_user USING ((company_id = ANY (private.my_org_ids())) OR (EXISTS ( SELECT 1 FROM ship_party sp WHERE ((sp.ship_id = certificate.ship_id) AND (sp.org_id = ANY (private.my_org_ids())) AND (sp.valid @> now())))));

CREATE POLICY certificate_staff_read ON certificate FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

CREATE TABLE IF NOT EXISTS finding_comment (
    id uuid DEFAULT uuidv7(),
    ship_id uuid,
    company_id uuid,
    comment_type varchar(2) NOT NULL,
    is_private boolean DEFAULT false NOT NULL,
    date_issued date NOT NULL,
    place_issued varchar(50),
    due_date date,
    status varchar(1) NOT NULL,
    postponed_due_date date,
    mms_reference varchar(20),
    subject varchar(500) NOT NULL,
    body text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamptz DEFAULT now() NOT NULL,
    updated_by uuid,
    row_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT finding_comment_pk PRIMARY KEY (id),
    CONSTRAINT finding_comment_target_ck CHECK (ship_id IS NOT NULL OR company_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS finding_comment_company_ix ON finding_comment (company_id);

CREATE INDEX IF NOT EXISTS finding_comment_ship_ix ON finding_comment (ship_id);

CREATE INDEX IF NOT EXISTS finding_comment_status_ix ON finding_comment (status) WHERE (is_active IS TRUE);

ALTER TABLE finding_comment ENABLE ROW LEVEL SECURITY;

CREATE POLICY finding_comment_ext_read ON finding_comment FOR SELECT TO ext_user USING ((is_private IS FALSE) AND ((company_id = ANY (private.my_org_ids())) OR (EXISTS ( SELECT 1 FROM ship_party sp WHERE ((sp.ship_id = finding_comment.ship_id) AND (sp.org_id = ANY (private.my_org_ids())) AND (sp.valid @> now()))))));

CREATE POLICY finding_comment_staff_read ON finding_comment FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

CREATE TABLE IF NOT EXISTS finding_comment_certificate (
    finding_comment_id uuid,
    certificate_id uuid,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT finding_comment_certificate_pk PRIMARY KEY (finding_comment_id, certificate_id),
    CONSTRAINT finding_comment_certificate_certificate_id_fkey FOREIGN KEY (certificate_id) REFERENCES certificate (id) ON DELETE CASCADE,
    CONSTRAINT finding_comment_certificate_finding_comment_id_fkey FOREIGN KEY (finding_comment_id) REFERENCES finding_comment (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS finding_comment_cert_cert_ix ON finding_comment_certificate (certificate_id);

ALTER TABLE finding_comment_certificate ENABLE ROW LEVEL SECURITY;

CREATE POLICY finding_comment_certificate_staff_read ON finding_comment_certificate FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

CREATE TABLE IF NOT EXISTS ship_class_notation (
    id uuid DEFAULT uuidv7(),
    ship_id uuid NOT NULL,
    notation_id integer NOT NULL,
    society_code varchar(20) NOT NULL,
    group_id integer NOT NULL,
    status core.notation_status_enum DEFAULT 'pending'::core.notation_status_enum NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    assigned_date date NOT NULL,
    effective_date date,
    expiry_date date,
    suspended_date date,
    withdrawn_date date,
    reinstated_date date,
    parameter_values jsonb,
    resolved_notation varchar(200),
    last_survey_date date,
    next_survey_due date,
    survey_cycle_months integer,
    approved_by uuid,
    approval_reference varchar(200),
    remarks text,
    is_current boolean DEFAULT true NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamptz DEFAULT now() NOT NULL,
    updated_by uuid,
    row_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT ship_class_notation_pk PRIMARY KEY (id),
    CONSTRAINT ship_class_notation_cycle_ck CHECK (survey_cycle_months IS NULL OR survey_cycle_months > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ship_class_notation_current_uk ON ship_class_notation (ship_id, notation_id, society_code) WHERE (is_current IS TRUE);

CREATE INDEX IF NOT EXISTS ship_class_notation_notation_ix ON ship_class_notation (notation_id);

CREATE INDEX IF NOT EXISTS ship_class_notation_ship_ix ON ship_class_notation (ship_id);

ALTER TABLE ship_class_notation ENABLE ROW LEVEL SECURITY;

CREATE POLICY ship_class_notation_ext_read ON ship_class_notation FOR SELECT TO ext_user USING (EXISTS ( SELECT 1 FROM ship_party sp WHERE ((sp.ship_id = ship_class_notation.ship_id) AND (sp.org_id = ANY (private.my_org_ids())) AND (sp.valid @> now()))));

CREATE POLICY ship_class_notation_staff_read ON ship_class_notation FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

CREATE TABLE IF NOT EXISTS survey_audit (
    id uuid DEFAULT uuidv7(),
    ship_id uuid,
    company_id uuid,
    cert_code varchar(10),
    certificate_id uuid,
    pool_id integer,
    description varchar(120) NOT NULL,
    last_held_date date NOT NULL,
    place_held varchar(50) NOT NULL,
    next_due_date date,
    postponement_date date,
    survey_status core.survey_status_enum,
    range_from_date date,
    range_to_date date,
    fee numeric(9,2),
    is_ordered boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamptz DEFAULT now() NOT NULL,
    updated_by uuid,
    row_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT survey_audit_pk PRIMARY KEY (id),
    CONSTRAINT survey_audit_certificate_fk FOREIGN KEY (certificate_id) REFERENCES certificate (id) ON DELETE CASCADE,
    CONSTRAINT survey_audit_range_ck CHECK (range_from_date IS NULL OR range_to_date IS NULL OR range_to_date >= range_from_date),
    CONSTRAINT survey_audit_target_ck CHECK (ship_id IS NOT NULL OR company_id IS NOT NULL OR certificate_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS survey_audit_certificate_ix ON survey_audit (certificate_id);

CREATE INDEX IF NOT EXISTS survey_audit_company_ix ON survey_audit (company_id);

CREATE INDEX IF NOT EXISTS survey_audit_due_ix ON survey_audit (next_due_date) WHERE (is_active IS TRUE);

CREATE INDEX IF NOT EXISTS survey_audit_pool_ix ON survey_audit (pool_id);

CREATE INDEX IF NOT EXISTS survey_audit_ship_ix ON survey_audit (ship_id);

ALTER TABLE survey_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY survey_audit_ext_read ON survey_audit FOR SELECT TO ext_user USING ((company_id = ANY (private.my_org_ids())) OR (EXISTS ( SELECT 1 FROM ship_party sp WHERE ((sp.ship_id = survey_audit.ship_id) AND (sp.org_id = ANY (private.my_org_ids())) AND (sp.valid @> now())))));

CREATE POLICY survey_audit_staff_read ON survey_audit FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

CREATE TABLE IF NOT EXISTS finding_comment_survey_audit (
    finding_comment_id uuid,
    survey_audit_id uuid,
    is_postponed boolean DEFAULT false,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT finding_comment_survey_audit_pk PRIMARY KEY (finding_comment_id, survey_audit_id, is_postponed),
    CONSTRAINT finding_comment_survey_audit_finding_comment_id_fkey FOREIGN KEY (finding_comment_id) REFERENCES finding_comment (id) ON DELETE CASCADE,
    CONSTRAINT finding_comment_survey_audit_survey_audit_id_fkey FOREIGN KEY (survey_audit_id) REFERENCES survey_audit (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS finding_comment_sa_audit_ix ON finding_comment_survey_audit (survey_audit_id);

ALTER TABLE finding_comment_survey_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY finding_comment_survey_audit_staff_read ON finding_comment_survey_audit FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE certificate
ADD CONSTRAINT certificate_category_fk FOREIGN KEY (category) REFERENCES core.certificate_category (code);

ALTER TABLE certificate
ADD CONSTRAINT certificate_cert_code_fk FOREIGN KEY (cert_code) REFERENCES core.certificate_survey_pool (code);

ALTER TABLE certificate
ADD CONSTRAINT certificate_cert_doc_fk FOREIGN KEY (cert_document_id) REFERENCES core.document (id) ON DELETE SET NULL;

ALTER TABLE certificate
ADD CONSTRAINT certificate_company_fk FOREIGN KEY (company_id) REFERENCES party.organization (id) ON DELETE SET NULL;

ALTER TABLE certificate
ADD CONSTRAINT certificate_draft_doc_fk FOREIGN KEY (draft_document_id) REFERENCES core.document (id) ON DELETE SET NULL;

ALTER TABLE certificate
ADD CONSTRAINT certificate_internal_category_fk FOREIGN KEY (internal_category) REFERENCES core.certificate_internal_category (code);

ALTER TABLE certificate
ADD CONSTRAINT certificate_issued_by_fk FOREIGN KEY (issued_by) REFERENCES core.classification_society (code);

ALTER TABLE certificate
ADD CONSTRAINT certificate_ship_fk FOREIGN KEY (ship_id) REFERENCES ship (id) ON DELETE SET NULL;

ALTER TABLE certificate
ADD CONSTRAINT certificate_status_fk FOREIGN KEY (status) REFERENCES core.certificate_status (code);

ALTER TABLE certificate
ADD CONSTRAINT certificate_template_fk FOREIGN KEY (certificate_template_code) REFERENCES core.certificate_template (code) ON DELETE SET NULL;

ALTER TABLE certificate
ADD CONSTRAINT certificate_validity_type_fk FOREIGN KEY (validity_type) REFERENCES core.certificate_validity_type (code);

ALTER TABLE finding_comment
ADD CONSTRAINT finding_comment_company_fk FOREIGN KEY (company_id) REFERENCES party.organization (id) ON DELETE CASCADE;

ALTER TABLE finding_comment
ADD CONSTRAINT finding_comment_ship_fk FOREIGN KEY (ship_id) REFERENCES ship (id) ON DELETE CASCADE;

ALTER TABLE finding_comment
ADD CONSTRAINT finding_comment_status_fk FOREIGN KEY (status) REFERENCES core.comment_status (code);

ALTER TABLE finding_comment
ADD CONSTRAINT finding_comment_type_fk FOREIGN KEY (comment_type) REFERENCES core.comment_type (code);

ALTER TABLE ship_class_notation
ADD CONSTRAINT ship_class_notation_approved_by_fk FOREIGN KEY (approved_by) REFERENCES iam.app_user (id);

ALTER TABLE ship_class_notation
ADD CONSTRAINT ship_class_notation_group_fk FOREIGN KEY (group_id) REFERENCES core.notation_group (id);

ALTER TABLE ship_class_notation
ADD CONSTRAINT ship_class_notation_notation_fk FOREIGN KEY (notation_id) REFERENCES core.class_notation (id);

ALTER TABLE ship_class_notation
ADD CONSTRAINT ship_class_notation_ship_fk FOREIGN KEY (ship_id) REFERENCES ship (id) ON DELETE CASCADE;

ALTER TABLE ship_class_notation
ADD CONSTRAINT ship_class_notation_society_fk FOREIGN KEY (society_code) REFERENCES core.classification_society (code);

ALTER TABLE survey_audit
ADD CONSTRAINT survey_audit_cert_code_fk FOREIGN KEY (cert_code) REFERENCES core.certificate_survey_pool (code) ON DELETE SET NULL;

ALTER TABLE survey_audit
ADD CONSTRAINT survey_audit_company_fk FOREIGN KEY (company_id) REFERENCES party.organization (id) ON DELETE CASCADE;

ALTER TABLE survey_audit
ADD CONSTRAINT survey_audit_pool_fk FOREIGN KEY (pool_id) REFERENCES core.survey_pool (id) ON DELETE SET NULL;

ALTER TABLE survey_audit
ADD CONSTRAINT survey_audit_ship_fk FOREIGN KEY (ship_id) REFERENCES ship (id) ON DELETE CASCADE;

CREATE POLICY finding_comment_certificate_ext_read ON finding_comment_certificate FOR SELECT TO ext_user USING (EXISTS ( SELECT 1 FROM finding_comment fc WHERE (fc.id = finding_comment_certificate.finding_comment_id)));

CREATE POLICY finding_comment_survey_audit_ext_read ON finding_comment_survey_audit FOR SELECT TO ext_user USING (EXISTS ( SELECT 1 FROM finding_comment fc WHERE (fc.id = finding_comment_survey_audit.finding_comment_id)));

CREATE OR REPLACE TRIGGER certificate_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON certificate
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER certificate_stamp
    BEFORE INSERT OR UPDATE ON certificate
    FOR EACH ROW
    EXECUTE FUNCTION private.stamp();

CREATE OR REPLACE TRIGGER finding_comment_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON finding_comment
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER finding_comment_certificate_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON finding_comment_certificate
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER finding_comment_stamp
    BEFORE INSERT OR UPDATE ON finding_comment
    FOR EACH ROW
    EXECUTE FUNCTION private.stamp();

CREATE OR REPLACE TRIGGER finding_comment_survey_audit_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON finding_comment_survey_audit
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER ship_class_notation_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON ship_class_notation
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER ship_class_notation_stamp
    BEFORE INSERT OR UPDATE ON ship_class_notation
    FOR EACH ROW
    EXECUTE FUNCTION private.stamp();

CREATE OR REPLACE TRIGGER survey_audit_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON survey_audit
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER survey_audit_stamp
    BEFORE INSERT OR UPDATE ON survey_audit
    FOR EACH ROW
    EXECUTE FUNCTION private.stamp();

GRANT SELECT ON TABLE certificate TO ext_user;

GRANT SELECT ON TABLE certificate TO int_auditor;

GRANT SELECT ON TABLE certificate TO int_compliance;

GRANT SELECT ON TABLE certificate TO int_coordinator;

GRANT SELECT ON TABLE certificate TO int_finance;

GRANT SELECT ON TABLE certificate TO int_hr;

GRANT SELECT ON TABLE certificate TO int_manager;

GRANT SELECT ON TABLE certificate TO int_surveyor;

GRANT SELECT ON TABLE certificate TO int_sysadmin;

GRANT SELECT ON TABLE certificate TO int_viewer;

GRANT SELECT ON TABLE finding_comment TO ext_user;

GRANT SELECT ON TABLE finding_comment TO int_auditor;

GRANT SELECT ON TABLE finding_comment TO int_compliance;

GRANT SELECT ON TABLE finding_comment TO int_coordinator;

GRANT SELECT ON TABLE finding_comment TO int_finance;

GRANT SELECT ON TABLE finding_comment TO int_hr;

GRANT SELECT ON TABLE finding_comment TO int_manager;

GRANT SELECT ON TABLE finding_comment TO int_surveyor;

GRANT SELECT ON TABLE finding_comment TO int_sysadmin;

GRANT SELECT ON TABLE finding_comment TO int_viewer;

GRANT SELECT ON TABLE finding_comment_certificate TO ext_user;

GRANT SELECT ON TABLE finding_comment_certificate TO int_auditor;

GRANT SELECT ON TABLE finding_comment_certificate TO int_compliance;

GRANT SELECT ON TABLE finding_comment_certificate TO int_coordinator;

GRANT SELECT ON TABLE finding_comment_certificate TO int_finance;

GRANT SELECT ON TABLE finding_comment_certificate TO int_hr;

GRANT SELECT ON TABLE finding_comment_certificate TO int_manager;

GRANT SELECT ON TABLE finding_comment_certificate TO int_surveyor;

GRANT SELECT ON TABLE finding_comment_certificate TO int_sysadmin;

GRANT SELECT ON TABLE finding_comment_certificate TO int_viewer;

GRANT SELECT ON TABLE finding_comment_survey_audit TO ext_user;

GRANT SELECT ON TABLE finding_comment_survey_audit TO int_auditor;

GRANT SELECT ON TABLE finding_comment_survey_audit TO int_compliance;

GRANT SELECT ON TABLE finding_comment_survey_audit TO int_coordinator;

GRANT SELECT ON TABLE finding_comment_survey_audit TO int_finance;

GRANT SELECT ON TABLE finding_comment_survey_audit TO int_hr;

GRANT SELECT ON TABLE finding_comment_survey_audit TO int_manager;

GRANT SELECT ON TABLE finding_comment_survey_audit TO int_surveyor;

GRANT SELECT ON TABLE finding_comment_survey_audit TO int_sysadmin;

GRANT SELECT ON TABLE finding_comment_survey_audit TO int_viewer;

GRANT SELECT ON TABLE ship_class_notation TO ext_user;

GRANT SELECT ON TABLE ship_class_notation TO int_auditor;

GRANT SELECT ON TABLE ship_class_notation TO int_compliance;

GRANT SELECT ON TABLE ship_class_notation TO int_coordinator;

GRANT SELECT ON TABLE ship_class_notation TO int_finance;

GRANT SELECT ON TABLE ship_class_notation TO int_hr;

GRANT SELECT ON TABLE ship_class_notation TO int_manager;

GRANT SELECT ON TABLE ship_class_notation TO int_surveyor;

GRANT SELECT ON TABLE ship_class_notation TO int_sysadmin;

GRANT SELECT ON TABLE ship_class_notation TO int_viewer;

GRANT SELECT ON TABLE survey_audit TO ext_user;

GRANT SELECT ON TABLE survey_audit TO int_auditor;

GRANT SELECT ON TABLE survey_audit TO int_compliance;

GRANT SELECT ON TABLE survey_audit TO int_coordinator;

GRANT SELECT ON TABLE survey_audit TO int_finance;

GRANT SELECT ON TABLE survey_audit TO int_hr;

GRANT SELECT ON TABLE survey_audit TO int_manager;

GRANT SELECT ON TABLE survey_audit TO int_surveyor;

GRANT SELECT ON TABLE survey_audit TO int_sysadmin;

GRANT SELECT ON TABLE survey_audit TO int_viewer;

-- ===== schema: survey  (pgschema 1.14.1) =====

set local search_path = survey;

CREATE TABLE IF NOT EXISTS job (
    id uuid DEFAULT uuidv7(),
    job_type text DEFAULT 'survey' NOT NULL,
    parent_job_id uuid,
    survey_request_id uuid,
    ship_id uuid,
    org_id uuid,
    office_unit_id uuid NOT NULL,
    lead_user_id uuid,
    reviewer_user_id uuid,
    job_status core.task_status_enum DEFAULT 'draft'::core.task_status_enum NOT NULL,
    description varchar(200),
    location varchar(100),
    fee numeric(9,2),
    comments text,
    additional text,
    report_document_id uuid,
    draft_document_id uuid,
    initialized boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamptz DEFAULT now() NOT NULL,
    updated_by uuid,
    row_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT job_pk PRIMARY KEY (id),
    CONSTRAINT job_parent_fk FOREIGN KEY (parent_job_id) REFERENCES job (id) ON DELETE CASCADE,
    CONSTRAINT job_no_self_parent_ck CHECK (parent_job_id IS NULL OR parent_job_id <> id),
    CONSTRAINT job_sod_ck CHECK (lead_user_id IS NULL OR reviewer_user_id IS NULL OR lead_user_id <> reviewer_user_id),
    CONSTRAINT job_target_ck CHECK (ship_id IS NOT NULL OR org_id IS NOT NULL),
    CONSTRAINT job_type_ck CHECK (job_type IN ('survey'::text, 'audit'::text, 'ms'::text))
);

CREATE INDEX IF NOT EXISTS job_office_ix ON job (office_unit_id);

CREATE INDEX IF NOT EXISTS job_org_ix ON job (org_id);

CREATE INDEX IF NOT EXISTS job_parent_ix ON job (parent_job_id);

CREATE INDEX IF NOT EXISTS job_request_ix ON job (survey_request_id);

CREATE INDEX IF NOT EXISTS job_ship_ix ON job (ship_id);

CREATE INDEX IF NOT EXISTS job_status_ix ON job (job_status);

ALTER TABLE job ENABLE ROW LEVEL SECURITY;

CREATE POLICY job_ext_read ON job FOR SELECT TO ext_user USING ((org_id = ANY (private.my_org_ids())) OR (EXISTS ( SELECT 1 FROM fleet.ship_party sp WHERE ((sp.ship_id = job.ship_id) AND (sp.org_id = ANY (private.my_org_ids())) AND (sp.valid @> now())))));

CREATE POLICY job_staff_read ON job FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (office_unit_id = ANY (private.my_offices()));

CREATE TABLE IF NOT EXISTS certificate_line (
    id uuid DEFAULT uuidv7(),
    job_id uuid NOT NULL,
    certificate_no bigint DEFAULT private.next_certificate_no() NOT NULL,
    ref_certificate_id uuid,
    action_code varchar(3) NOT NULL,
    certificate_template_code varchar(10),
    cert_code varchar(10) NOT NULL,
    validity_type varchar(2) NOT NULL,
    category varchar(3) NOT NULL,
    internal_category varchar(3) NOT NULL,
    issued_by_user_id uuid,
    description varchar(120),
    expiry_date date,
    extended_date date,
    mlc_declaration_date date,
    mlc_declaration_place varchar(50),
    doc_administration character(3),
    version integer DEFAULT 1 NOT NULL,
    draft_document_id uuid,
    cert_document_id uuid,
    created_at timestamptz DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamptz DEFAULT now() NOT NULL,
    updated_by uuid,
    row_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT certificate_line_pk PRIMARY KEY (id),
    CONSTRAINT certificate_line_job_fk FOREIGN KEY (job_id) REFERENCES job (id) ON DELETE CASCADE,
    CONSTRAINT certificate_line_version_ck CHECK (version >= 1)
);

CREATE INDEX IF NOT EXISTS certificate_line_job_ix ON certificate_line (job_id);

CREATE INDEX IF NOT EXISTS certificate_line_ref_cert_ix ON certificate_line (ref_certificate_id);

ALTER TABLE certificate_line ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS comment_line (
    id uuid DEFAULT uuidv7(),
    job_id uuid NOT NULL,
    finding_comment_id uuid,
    comment_type varchar(2),
    is_private boolean DEFAULT false NOT NULL,
    due_date date,
    status varchar(1),
    postponed_due_date date,
    mms_reference varchar(20),
    subject varchar(500),
    body text,
    created_at timestamptz DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamptz DEFAULT now() NOT NULL,
    updated_by uuid,
    row_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT comment_line_pk PRIMARY KEY (id),
    CONSTRAINT comment_line_job_fk FOREIGN KEY (job_id) REFERENCES job (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS comment_line_fc_ix ON comment_line (finding_comment_id);

CREATE INDEX IF NOT EXISTS comment_line_job_ix ON comment_line (job_id);

ALTER TABLE comment_line ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS job_participant (
    id uuid DEFAULT uuidv7(),
    job_id uuid NOT NULL,
    user_id uuid NOT NULL,
    is_monitor boolean DEFAULT false NOT NULL,
    is_trainee boolean DEFAULT false NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamptz DEFAULT now() NOT NULL,
    updated_by uuid,
    row_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT job_participant_pk PRIMARY KEY (id),
    CONSTRAINT job_participant_uk UNIQUE (job_id, user_id),
    CONSTRAINT job_participant_job_fk FOREIGN KEY (job_id) REFERENCES job (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS job_participant_job_ix ON job_participant (job_id);

CREATE INDEX IF NOT EXISTS job_participant_user_ix ON job_participant (user_id);

ALTER TABLE job_participant ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS survey_line (
    id uuid DEFAULT uuidv7(),
    job_id uuid NOT NULL,
    survey_audit_id uuid,
    pool_id integer,
    description varchar(120),
    next_due_date date,
    postponement_date date,
    survey_status core.survey_status_enum,
    range_from_date date,
    range_to_date date,
    initialized boolean DEFAULT false NOT NULL,
    credit_periodical boolean DEFAULT true NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamptz DEFAULT now() NOT NULL,
    updated_by uuid,
    row_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT survey_line_pk PRIMARY KEY (id),
    CONSTRAINT survey_line_job_fk FOREIGN KEY (job_id) REFERENCES job (id) ON DELETE CASCADE,
    CONSTRAINT survey_line_range_ck CHECK (range_from_date IS NULL OR range_to_date IS NULL OR range_to_date >= range_from_date)
);

CREATE INDEX IF NOT EXISTS survey_line_job_ix ON survey_line (job_id);

CREATE INDEX IF NOT EXISTS survey_line_pool_ix ON survey_line (pool_id);

CREATE INDEX IF NOT EXISTS survey_line_sa_ix ON survey_line (survey_audit_id);

ALTER TABLE survey_line ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS checklist_entry (
    id bigint GENERATED ALWAYS AS IDENTITY,
    job_id uuid NOT NULL,
    survey_line_id uuid NOT NULL,
    survey_audit_id uuid,
    item_id integer,
    ship_breakdown_node_id integer,
    result varchar(2),
    metadata jsonb DEFAULT '{}' NOT NULL,
    report_by uuid,
    report_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT checklist_entry_pkey PRIMARY KEY (id),
    CONSTRAINT checklist_entry_job_fk FOREIGN KEY (job_id) REFERENCES job (id) ON DELETE CASCADE,
    CONSTRAINT checklist_entry_line_fk FOREIGN KEY (survey_line_id) REFERENCES survey_line (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS checklist_entry_job_ix ON checklist_entry (job_id);

CREATE INDEX IF NOT EXISTS checklist_entry_line_ix ON checklist_entry (survey_line_id);

CREATE INDEX IF NOT EXISTS checklist_entry_node_ix ON checklist_entry (ship_breakdown_node_id);

ALTER TABLE checklist_entry ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS checklist_entry_particular (
    id bigint GENERATED ALWAYS AS IDENTITY,
    checklist_entry_id bigint NOT NULL,
    source_particular_id integer,
    ship_breakdown_node_id integer,
    attr_key varchar(100) NOT NULL,
    attr_title varchar(300) NOT NULL,
    data_type core.data_type_enum DEFAULT 'text'::core.data_type_enum NOT NULL,
    unit varchar(50),
    selection_options jsonb,
    is_required boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    attr_result text,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT checklist_entry_particular_pkey PRIMARY KEY (id),
    CONSTRAINT checklist_entry_particular_uk UNIQUE NULLS NOT DISTINCT (checklist_entry_id, attr_key, ship_breakdown_node_id),
    CONSTRAINT checklist_entry_particular_entry_fk FOREIGN KEY (checklist_entry_id) REFERENCES checklist_entry (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS checklist_entry_particular_entry_ix ON checklist_entry_particular (checklist_entry_id);

CREATE INDEX IF NOT EXISTS checklist_entry_particular_node_ix ON checklist_entry_particular (ship_breakdown_node_id);

ALTER TABLE checklist_entry_particular ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS survey_request_item (
    id uuid DEFAULT uuidv7(),
    survey_request_id uuid NOT NULL,
    survey_audit_id uuid,
    finding_comment_id uuid,
    occ_survey_code varchar(20),
    created_at timestamptz DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamptz DEFAULT now() NOT NULL,
    updated_by uuid,
    row_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT survey_request_item_pk PRIMARY KEY (id),
    CONSTRAINT survey_request_item_target_ck CHECK (num_nonnulls(survey_audit_id, finding_comment_id, occ_survey_code) = 1)
);

CREATE INDEX IF NOT EXISTS survey_request_item_fc_ix ON survey_request_item (finding_comment_id);

CREATE UNIQUE INDEX IF NOT EXISTS survey_request_item_req_fc_uk ON survey_request_item (survey_request_id, finding_comment_id) WHERE (finding_comment_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS survey_request_item_req_ix ON survey_request_item (survey_request_id);

CREATE UNIQUE INDEX IF NOT EXISTS survey_request_item_req_sa_uk ON survey_request_item (survey_request_id, survey_audit_id) WHERE (survey_audit_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS survey_request_item_sa_ix ON survey_request_item (survey_audit_id);

ALTER TABLE survey_request_item ENABLE ROW LEVEL SECURITY;

CREATE POLICY survey_request_item_ext_read ON survey_request_item FOR SELECT TO ext_user USING (EXISTS ( SELECT 1 FROM survey_request sr WHERE ((sr.id = survey_request_item.survey_request_id) AND (sr.org_id = ANY (private.my_org_ids())))));

CREATE POLICY survey_request_item_staff_read ON survey_request_item FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (EXISTS ( SELECT 1 FROM survey_request sr WHERE ((sr.id = survey_request_item.survey_request_id) AND (sr.office_unit_id = ANY (private.my_offices())))));

ALTER TABLE certificate_line
ADD CONSTRAINT certificate_line_action_fk FOREIGN KEY (action_code) REFERENCES core.certificate_action (code);

ALTER TABLE certificate_line
ADD CONSTRAINT certificate_line_category_fk FOREIGN KEY (category) REFERENCES core.certificate_category (code);

ALTER TABLE certificate_line
ADD CONSTRAINT certificate_line_cert_code_fk FOREIGN KEY (cert_code) REFERENCES core.certificate_survey_pool (code);

ALTER TABLE certificate_line
ADD CONSTRAINT certificate_line_cert_doc_fk FOREIGN KEY (cert_document_id) REFERENCES core.document (id) ON DELETE SET NULL;

ALTER TABLE certificate_line
ADD CONSTRAINT certificate_line_draft_doc_fk FOREIGN KEY (draft_document_id) REFERENCES core.document (id) ON DELETE SET NULL;

ALTER TABLE certificate_line
ADD CONSTRAINT certificate_line_int_cat_fk FOREIGN KEY (internal_category) REFERENCES core.certificate_internal_category (code);

ALTER TABLE certificate_line
ADD CONSTRAINT certificate_line_issued_by_fk FOREIGN KEY (issued_by_user_id) REFERENCES iam.app_user (id);

ALTER TABLE certificate_line
ADD CONSTRAINT certificate_line_ref_cert_fk FOREIGN KEY (ref_certificate_id) REFERENCES fleet.certificate (id) ON DELETE SET NULL;

ALTER TABLE certificate_line
ADD CONSTRAINT certificate_line_template_fk FOREIGN KEY (certificate_template_code) REFERENCES core.certificate_template (code) ON DELETE SET NULL;

ALTER TABLE certificate_line
ADD CONSTRAINT certificate_line_validity_fk FOREIGN KEY (validity_type) REFERENCES core.certificate_validity_type (code);

ALTER TABLE checklist_entry
ADD CONSTRAINT checklist_entry_item_fk FOREIGN KEY (item_id) REFERENCES core.checklist_item (id) ON DELETE SET NULL;

ALTER TABLE checklist_entry
ADD CONSTRAINT checklist_entry_node_fk FOREIGN KEY (ship_breakdown_node_id) REFERENCES fleet.ship_breakdown_node (id) ON DELETE CASCADE;

ALTER TABLE checklist_entry
ADD CONSTRAINT checklist_entry_report_by_fk FOREIGN KEY (report_by) REFERENCES iam.app_user (id);

ALTER TABLE checklist_entry
ADD CONSTRAINT checklist_entry_result_fk FOREIGN KEY (result) REFERENCES core.checklist_result (code);

ALTER TABLE checklist_entry
ADD CONSTRAINT checklist_entry_sa_fk FOREIGN KEY (survey_audit_id) REFERENCES fleet.survey_audit (id) ON DELETE SET NULL;

ALTER TABLE checklist_entry_particular
ADD CONSTRAINT checklist_entry_particular_node_fk FOREIGN KEY (ship_breakdown_node_id) REFERENCES fleet.ship_breakdown_node (id) ON DELETE CASCADE;

ALTER TABLE checklist_entry_particular
ADD CONSTRAINT checklist_entry_particular_src_fk FOREIGN KEY (source_particular_id) REFERENCES core.checklist_item_particular (id) ON DELETE SET NULL;

ALTER TABLE comment_line
ADD CONSTRAINT comment_line_fc_fk FOREIGN KEY (finding_comment_id) REFERENCES fleet.finding_comment (id) ON DELETE SET NULL;

ALTER TABLE comment_line
ADD CONSTRAINT comment_line_status_fk FOREIGN KEY (status) REFERENCES core.comment_status (code);

ALTER TABLE comment_line
ADD CONSTRAINT comment_line_type_fk FOREIGN KEY (comment_type) REFERENCES core.comment_type (code);

ALTER TABLE job
ADD CONSTRAINT job_draft_doc_fk FOREIGN KEY (draft_document_id) REFERENCES core.document (id) ON DELETE SET NULL;

ALTER TABLE job
ADD CONSTRAINT job_lead_fk FOREIGN KEY (lead_user_id) REFERENCES iam.app_user (id);

ALTER TABLE job
ADD CONSTRAINT job_office_fk FOREIGN KEY (office_unit_id) REFERENCES core.org_unit (id);

ALTER TABLE job
ADD CONSTRAINT job_org_fk FOREIGN KEY (org_id) REFERENCES party.organization (id) ON DELETE SET NULL;

ALTER TABLE job
ADD CONSTRAINT job_report_doc_fk FOREIGN KEY (report_document_id) REFERENCES core.document (id) ON DELETE SET NULL;

ALTER TABLE job
ADD CONSTRAINT job_request_fk FOREIGN KEY (survey_request_id) REFERENCES survey_request (id) ON DELETE SET NULL;

ALTER TABLE job
ADD CONSTRAINT job_reviewer_fk FOREIGN KEY (reviewer_user_id) REFERENCES iam.app_user (id);

ALTER TABLE job
ADD CONSTRAINT job_ship_fk FOREIGN KEY (ship_id) REFERENCES fleet.ship (id) ON DELETE SET NULL;

ALTER TABLE job_participant
ADD CONSTRAINT job_participant_user_fk FOREIGN KEY (user_id) REFERENCES iam.app_user (id) ON DELETE CASCADE;

ALTER TABLE survey_line
ADD CONSTRAINT survey_line_pool_fk FOREIGN KEY (pool_id) REFERENCES core.survey_pool (id) ON DELETE SET NULL;

ALTER TABLE survey_line
ADD CONSTRAINT survey_line_sa_fk FOREIGN KEY (survey_audit_id) REFERENCES fleet.survey_audit (id) ON DELETE SET NULL;

ALTER TABLE survey_request_item
ADD CONSTRAINT survey_request_item_fc_fk FOREIGN KEY (finding_comment_id) REFERENCES fleet.finding_comment (id) ON DELETE SET NULL;

ALTER TABLE survey_request_item
ADD CONSTRAINT survey_request_item_occ_fk FOREIGN KEY (occ_survey_code) REFERENCES core.survey_pool (code) ON DELETE SET NULL;

ALTER TABLE survey_request_item
ADD CONSTRAINT survey_request_item_req_fk FOREIGN KEY (survey_request_id) REFERENCES survey_request (id) ON DELETE CASCADE;

ALTER TABLE survey_request_item
ADD CONSTRAINT survey_request_item_sa_fk FOREIGN KEY (survey_audit_id) REFERENCES fleet.survey_audit (id) ON DELETE SET NULL;

CREATE POLICY certificate_line_staff_read ON certificate_line FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (EXISTS ( SELECT 1 FROM job j WHERE ((j.id = certificate_line.job_id) AND (j.office_unit_id = ANY (private.my_offices())))));

CREATE POLICY checklist_entry_staff_read ON checklist_entry FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (EXISTS ( SELECT 1 FROM job j WHERE ((j.id = checklist_entry.job_id) AND (j.office_unit_id = ANY (private.my_offices())))));

CREATE POLICY checklist_entry_particular_staff_read ON checklist_entry_particular FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (EXISTS ( SELECT 1 FROM (checklist_entry ce JOIN job j ON ((j.id = ce.job_id))) WHERE ((ce.id = checklist_entry_particular.checklist_entry_id) AND (j.office_unit_id = ANY (private.my_offices())))));

CREATE POLICY comment_line_ext_read ON comment_line FOR SELECT TO ext_user USING ((is_private IS FALSE) AND (EXISTS ( SELECT 1 FROM job j WHERE (j.id = comment_line.job_id))));

CREATE POLICY comment_line_staff_read ON comment_line FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (EXISTS ( SELECT 1 FROM job j WHERE ((j.id = comment_line.job_id) AND (j.office_unit_id = ANY (private.my_offices())))));

CREATE POLICY job_participant_staff_read ON job_participant FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (EXISTS ( SELECT 1 FROM job j WHERE ((j.id = job_participant.job_id) AND (j.office_unit_id = ANY (private.my_offices())))));

CREATE POLICY survey_line_staff_read ON survey_line FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (EXISTS ( SELECT 1 FROM job j WHERE ((j.id = survey_line.job_id) AND (j.office_unit_id = ANY (private.my_offices())))));

CREATE OR REPLACE TRIGGER certificate_line_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON certificate_line
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER certificate_line_stamp
    BEFORE INSERT OR UPDATE ON certificate_line
    FOR EACH ROW
    EXECUTE FUNCTION private.stamp();

CREATE OR REPLACE TRIGGER checklist_entry_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON checklist_entry
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER checklist_entry_particular_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON checklist_entry_particular
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER comment_line_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON comment_line
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER comment_line_stamp
    BEFORE INSERT OR UPDATE ON comment_line
    FOR EACH ROW
    EXECUTE FUNCTION private.stamp();

CREATE OR REPLACE TRIGGER job_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON job
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER job_participant_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON job_participant
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER job_participant_stamp
    BEFORE INSERT OR UPDATE ON job_participant
    FOR EACH ROW
    EXECUTE FUNCTION private.stamp();

CREATE OR REPLACE TRIGGER job_stamp
    BEFORE INSERT OR UPDATE ON job
    FOR EACH ROW
    EXECUTE FUNCTION private.stamp();

CREATE OR REPLACE TRIGGER survey_line_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON survey_line
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER survey_line_stamp
    BEFORE INSERT OR UPDATE ON survey_line
    FOR EACH ROW
    EXECUTE FUNCTION private.stamp();

CREATE OR REPLACE TRIGGER survey_request_item_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON survey_request_item
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER survey_request_item_stamp
    BEFORE INSERT OR UPDATE ON survey_request_item
    FOR EACH ROW
    EXECUTE FUNCTION private.stamp();

GRANT SELECT ON TABLE certificate_line TO int_auditor;

GRANT SELECT ON TABLE certificate_line TO int_compliance;

GRANT SELECT ON TABLE certificate_line TO int_coordinator;

GRANT SELECT ON TABLE certificate_line TO int_finance;

GRANT SELECT ON TABLE certificate_line TO int_hr;

GRANT SELECT ON TABLE certificate_line TO int_manager;

GRANT SELECT ON TABLE certificate_line TO int_surveyor;

GRANT SELECT ON TABLE certificate_line TO int_sysadmin;

GRANT SELECT ON TABLE certificate_line TO int_viewer;

GRANT SELECT ON TABLE checklist_entry TO int_auditor;

GRANT SELECT ON TABLE checklist_entry TO int_compliance;

GRANT SELECT ON TABLE checklist_entry TO int_coordinator;

GRANT SELECT ON TABLE checklist_entry TO int_finance;

GRANT SELECT ON TABLE checklist_entry TO int_hr;

GRANT SELECT ON TABLE checklist_entry TO int_manager;

GRANT SELECT ON TABLE checklist_entry TO int_surveyor;

GRANT SELECT ON TABLE checklist_entry TO int_sysadmin;

GRANT SELECT ON TABLE checklist_entry TO int_viewer;

GRANT SELECT ON TABLE checklist_entry_particular TO int_auditor;

GRANT SELECT ON TABLE checklist_entry_particular TO int_compliance;

GRANT SELECT ON TABLE checklist_entry_particular TO int_coordinator;

GRANT SELECT ON TABLE checklist_entry_particular TO int_finance;

GRANT SELECT ON TABLE checklist_entry_particular TO int_hr;

GRANT SELECT ON TABLE checklist_entry_particular TO int_manager;

GRANT SELECT ON TABLE checklist_entry_particular TO int_surveyor;

GRANT SELECT ON TABLE checklist_entry_particular TO int_sysadmin;

GRANT SELECT ON TABLE checklist_entry_particular TO int_viewer;

GRANT SELECT ON TABLE comment_line TO ext_user;

GRANT SELECT ON TABLE comment_line TO int_auditor;

GRANT SELECT ON TABLE comment_line TO int_compliance;

GRANT SELECT ON TABLE comment_line TO int_coordinator;

GRANT SELECT ON TABLE comment_line TO int_finance;

GRANT SELECT ON TABLE comment_line TO int_hr;

GRANT SELECT ON TABLE comment_line TO int_manager;

GRANT SELECT ON TABLE comment_line TO int_surveyor;

GRANT SELECT ON TABLE comment_line TO int_sysadmin;

GRANT SELECT ON TABLE comment_line TO int_viewer;

GRANT SELECT ON TABLE job TO ext_user;

GRANT SELECT ON TABLE job TO int_auditor;

GRANT SELECT ON TABLE job TO int_compliance;

GRANT SELECT ON TABLE job TO int_coordinator;

GRANT SELECT ON TABLE job TO int_finance;

GRANT SELECT ON TABLE job TO int_hr;

GRANT SELECT ON TABLE job TO int_manager;

GRANT SELECT ON TABLE job TO int_surveyor;

GRANT SELECT ON TABLE job TO int_sysadmin;

GRANT SELECT ON TABLE job TO int_viewer;

GRANT SELECT ON TABLE job_participant TO int_auditor;

GRANT SELECT ON TABLE job_participant TO int_compliance;

GRANT SELECT ON TABLE job_participant TO int_coordinator;

GRANT SELECT ON TABLE job_participant TO int_finance;

GRANT SELECT ON TABLE job_participant TO int_hr;

GRANT SELECT ON TABLE job_participant TO int_manager;

GRANT SELECT ON TABLE job_participant TO int_surveyor;

GRANT SELECT ON TABLE job_participant TO int_sysadmin;

GRANT SELECT ON TABLE job_participant TO int_viewer;

GRANT SELECT ON TABLE survey_line TO int_auditor;

GRANT SELECT ON TABLE survey_line TO int_compliance;

GRANT SELECT ON TABLE survey_line TO int_coordinator;

GRANT SELECT ON TABLE survey_line TO int_finance;

GRANT SELECT ON TABLE survey_line TO int_hr;

GRANT SELECT ON TABLE survey_line TO int_manager;

GRANT SELECT ON TABLE survey_line TO int_surveyor;

GRANT SELECT ON TABLE survey_line TO int_sysadmin;

GRANT SELECT ON TABLE survey_line TO int_viewer;

GRANT SELECT ON TABLE survey_request_item TO ext_user;

GRANT SELECT ON TABLE survey_request_item TO int_auditor;

GRANT SELECT ON TABLE survey_request_item TO int_compliance;

GRANT SELECT ON TABLE survey_request_item TO int_coordinator;

GRANT SELECT ON TABLE survey_request_item TO int_finance;

GRANT SELECT ON TABLE survey_request_item TO int_hr;

GRANT SELECT ON TABLE survey_request_item TO int_manager;

GRANT SELECT ON TABLE survey_request_item TO int_surveyor;

GRANT SELECT ON TABLE survey_request_item TO int_sysadmin;

GRANT SELECT ON TABLE survey_request_item TO int_viewer;
