-- ===== schema: core  (pgschema 1.14.1) =====

set local search_path = core;

CREATE TYPE certificate_applicability_enum AS ENUM (
    'Vessel',
    'Company'
);

CREATE TYPE compatibility_type_enum AS ENUM (
    'requires',
    'incompatible',
    'supersedes',
    'recommended'
);

CREATE TYPE data_type_enum AS ENUM (
    'text',
    'integer',
    'decimal',
    'boolean',
    'date',
    'datetime',
    'selection',
    'multi_select'
);

CREATE TYPE notation_status_enum AS ENUM (
    'active',
    'suspended',
    'withdrawn',
    'reinstated',
    'expired',
    'pending',
    'conditional'
);

CREATE TYPE survey_status_enum AS ENUM (
    'partial',
    'scheduled',
    'executing',
    'completed',
    'postponed'
);

CREATE TYPE task_status_enum AS ENUM (
    'draft',
    'submitted',
    'accepted',
    'assigned',
    'scheduled',
    'planning',
    'executing',
    'pending_review',
    'approved',
    'completed',
    'cancelled',
    'rejected'
);

CREATE TABLE IF NOT EXISTS administration_type (
    code varchar(2),
    name varchar(100) NOT NULL,
    CONSTRAINT administration_type_pkey PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS breakdown_template (
    id SERIAL,
    code varchar(50) NOT NULL,
    name varchar(200) NOT NULL,
    description text,
    vessel_type varchar(100),
    version varchar(20) DEFAULT '1.0' NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    parent_template_id integer,
    created_by varchar(100),
    updated_by varchar(100),
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT breakdown_template_pkey PRIMARY KEY (id),
    CONSTRAINT breakdown_template_code_key UNIQUE (code),
    CONSTRAINT uq_template_code_version UNIQUE (code, version),
    CONSTRAINT breakdown_template_parent_template_id_fkey FOREIGN KEY (parent_template_id) REFERENCES breakdown_template (id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS breakdown_template_node (
    id SERIAL,
    template_id integer NOT NULL,
    parent_node_id integer,
    code varchar(50) NOT NULL,
    name varchar(200) NOT NULL,
    description text,
    category varchar(100),
    node_type varchar(50),
    level integer DEFAULT 0 NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_instantiable boolean DEFAULT true NOT NULL,
    default_quantity integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}',
    is_mandatory boolean DEFAULT true NOT NULL,
    is_leaf boolean DEFAULT false NOT NULL,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT breakdown_template_node_pkey PRIMARY KEY (id),
    CONSTRAINT uq_template_node_code UNIQUE (template_id, code),
    CONSTRAINT breakdown_template_node_parent_node_id_fkey FOREIGN KEY (parent_node_id) REFERENCES breakdown_template_node (id) ON DELETE CASCADE,
    CONSTRAINT breakdown_template_node_template_id_fkey FOREIGN KEY (template_id) REFERENCES breakdown_template (id) ON DELETE CASCADE,
    CONSTRAINT chk_no_self_parent CHECK (id <> parent_node_id)
);

CREATE TABLE IF NOT EXISTS breakdown_template_node_particular (
    id SERIAL,
    template_node_id integer NOT NULL,
    attr_key varchar(20) NOT NULL,
    attr_title varchar(200) NOT NULL,
    data_type data_type_enum NOT NULL,
    default_value text,
    selection_options jsonb,
    unit varchar(20),
    is_required boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT breakdown_template_node_particular_pkey PRIMARY KEY (id),
    CONSTRAINT uq_tnode_attr UNIQUE (template_node_id, attr_key),
    CONSTRAINT breakdown_template_node_particular_template_node_id_fkey FOREIGN KEY (template_node_id) REFERENCES breakdown_template_node (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS certificate_action (
    code varchar(3),
    name varchar(100) NOT NULL,
    CONSTRAINT certificate_action_pkey PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS certificate_category (
    code varchar(3),
    name varchar(100) NOT NULL,
    CONSTRAINT certificate_category_pkey PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS certificate_internal_category (
    code varchar(3),
    name varchar(100) NOT NULL,
    description text,
    CONSTRAINT certificate_internal_category_pkey PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS certificate_status (
    code varchar(2),
    name varchar(100) NOT NULL,
    CONSTRAINT certificate_status_pkey PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS certificate_survey_pool (
    code varchar(10),
    description varchar(100) NOT NULL,
    CONSTRAINT certificate_survey_pool_pkey PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS certificate_validity_type (
    code varchar(2),
    name varchar(100) NOT NULL,
    CONSTRAINT certificate_validity_type_pkey PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS certificate_template (
    code varchar(10),
    name varchar(100) NOT NULL,
    version varchar(20) NOT NULL,
    cert_code varchar(10),
    validity_type varchar(2),
    category varchar(3),
    internal_category varchar(3),
    file_path_xml varchar(255),
    file_path_html varchar(255),
    file_path_pdf varchar(255),
    description text,
    applicability certificate_applicability_enum,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    is_active boolean DEFAULT true,
    CONSTRAINT certificate_template_pkey PRIMARY KEY (code),
    CONSTRAINT certificate_template_category_fkey FOREIGN KEY (category) REFERENCES certificate_category (code),
    CONSTRAINT certificate_template_cert_code_fkey FOREIGN KEY (cert_code) REFERENCES certificate_survey_pool (code),
    CONSTRAINT certificate_template_internal_category_fkey FOREIGN KEY (internal_category) REFERENCES certificate_internal_category (code),
    CONSTRAINT certificate_template_validity_type_fkey FOREIGN KEY (validity_type) REFERENCES certificate_validity_type (code)
);

CREATE TABLE IF NOT EXISTS checklist_result (
    code varchar(2),
    description varchar(200) NOT NULL,
    CONSTRAINT checklist_result_pkey PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS class_status (
    code varchar(2),
    name varchar(100) NOT NULL,
    CONSTRAINT class_status_pkey PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS classification_society (
    code varchar(20),
    name varchar(100) NOT NULL,
    CONSTRAINT classification_society_pkey PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS comment_status (
    code varchar(1),
    name varchar(30) NOT NULL,
    CONSTRAINT comment_status_pkey PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS comment_type (
    code varchar(2),
    name varchar(100) NOT NULL,
    CONSTRAINT comment_type_pkey PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS flag (
    code varchar(3),
    name varchar(20) NOT NULL,
    fullname varchar(100) NOT NULL,
    email varchar(50),
    tel varchar(30),
    fax varchar(30),
    contact varchar(100),
    contract_file varchar(128),
    contract_start date,
    contract_end date,
    is_hssc boolean DEFAULT true,
    is_active boolean DEFAULT true,
    CONSTRAINT flag_pkey PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS flag_cert_authorization (
    id SERIAL,
    flag_code varchar(3) NOT NULL,
    cert_code varchar(10) NOT NULL,
    validity_type varchar(2),
    category varchar(3),
    internal_category varchar(3),
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    is_active boolean DEFAULT true,
    CONSTRAINT flag_cert_authorization_pkey PRIMARY KEY (id),
    CONSTRAINT flag_cert_authorization_category_fkey FOREIGN KEY (category) REFERENCES certificate_category (code),
    CONSTRAINT flag_cert_authorization_cert_code_fkey FOREIGN KEY (cert_code) REFERENCES certificate_survey_pool (code) ON DELETE CASCADE,
    CONSTRAINT flag_cert_authorization_flag_code_fkey FOREIGN KEY (flag_code) REFERENCES flag (code) ON DELETE CASCADE,
    CONSTRAINT flag_cert_authorization_internal_category_fkey FOREIGN KEY (internal_category) REFERENCES certificate_internal_category (code),
    CONSTRAINT flag_cert_authorization_validity_type_fkey FOREIGN KEY (validity_type) REFERENCES certificate_validity_type (code)
);

CREATE TABLE IF NOT EXISTS notation_group (
    id SERIAL,
    group_code varchar(50) NOT NULL,
    group_name varchar(200) NOT NULL,
    description text,
    display_order integer DEFAULT 1 NOT NULL,
    separator_before varchar(3) DEFAULT '.',
    separator_within varchar(3) DEFAULT ',',
    min_notations integer DEFAULT 0 NOT NULL,
    max_notations integer,
    is_mandatory boolean GENERATED ALWAYS AS ((min_notations >= 1)) STORED,
    allows_multiple boolean GENERATED ALWAYS AS (((max_notations IS NULL) OR (max_notations > 1))) STORED,
    is_prefix boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT notation_group_pkey PRIMARY KEY (id),
    CONSTRAINT notation_group_group_code_key UNIQUE (group_code)
);

CREATE TABLE IF NOT EXISTS class_notation (
    id SERIAL,
    society_code varchar(20) NOT NULL,
    group_id integer,
    notation_code varchar(100) NOT NULL,
    notation_symbol varchar(200),
    notation_name varchar(300) NOT NULL,
    description text,
    is_parameterized boolean DEFAULT false NOT NULL,
    parameter_template varchar(200),
    allowed_parameters jsonb,
    applicable_ship_types text[],
    applicable_rules varchar(500),
    incompatible_notations integer[],
    effective_from date,
    superseded_date date,
    superseded_by integer,
    is_active boolean DEFAULT true NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT class_notation_pkey PRIMARY KEY (id),
    CONSTRAINT uq_notation_per_society UNIQUE (society_code, notation_code),
    CONSTRAINT class_notation_group_id_fkey FOREIGN KEY (group_id) REFERENCES notation_group (id),
    CONSTRAINT class_notation_society_code_fkey FOREIGN KEY (society_code) REFERENCES classification_society (code),
    CONSTRAINT class_notation_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES class_notation (id)
);

CREATE TABLE IF NOT EXISTS notation_compatibility (
    id SERIAL,
    notation_id integer NOT NULL,
    related_notation_id integer NOT NULL,
    compatibility_type compatibility_type_enum NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT notation_compatibility_pkey PRIMARY KEY (id),
    CONSTRAINT uq_notation_compat UNIQUE (notation_id, related_notation_id, compatibility_type),
    CONSTRAINT notation_compatibility_notation_id_fkey FOREIGN KEY (notation_id) REFERENCES class_notation (id),
    CONSTRAINT notation_compatibility_related_notation_id_fkey FOREIGN KEY (related_notation_id) REFERENCES class_notation (id),
    CONSTRAINT chk_no_self_prereq CHECK (notation_id <> related_notation_id)
);

CREATE TABLE IF NOT EXISTS ship_status (
    code varchar(2),
    name varchar(100) NOT NULL,
    CONSTRAINT ship_status_pkey PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS society_group_rendering (
    id SERIAL,
    society_code varchar(20) NOT NULL,
    group_id integer NOT NULL,
    separator_before varchar(20),
    separator_within varchar(10),
    prefix varchar(20),
    suffix varchar(20),
    display_order integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT society_group_rendering_pkey PRIMARY KEY (id),
    CONSTRAINT uq_society_group_render UNIQUE (society_code, group_id),
    CONSTRAINT society_group_rendering_group_id_fkey FOREIGN KEY (group_id) REFERENCES notation_group (id),
    CONSTRAINT society_group_rendering_society_code_fkey FOREIGN KEY (society_code) REFERENCES classification_society (code)
);

CREATE TABLE IF NOT EXISTS survey_audit_status (
    code varchar(2),
    name varchar(100) NOT NULL,
    CONSTRAINT survey_audit_status_pkey PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS survey_audit_type (
    code varchar(2),
    name varchar(100) NOT NULL,
    is_scheduled boolean NOT NULL,
    CONSTRAINT survey_audit_type_pkey PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS flag_survey_authorization (
    id SERIAL,
    flag_code varchar(3) NOT NULL,
    cert_code varchar(10) NOT NULL,
    survey_type varchar(2),
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    is_active boolean DEFAULT true,
    CONSTRAINT flag_survey_authorization_pkey PRIMARY KEY (id),
    CONSTRAINT flag_survey_authorization_cert_code_fkey FOREIGN KEY (cert_code) REFERENCES certificate_survey_pool (code) ON DELETE CASCADE,
    CONSTRAINT flag_survey_authorization_flag_code_fkey FOREIGN KEY (flag_code) REFERENCES flag (code) ON DELETE CASCADE,
    CONSTRAINT flag_survey_authorization_survey_type_fkey FOREIGN KEY (survey_type) REFERENCES survey_audit_type (code)
);

CREATE TABLE IF NOT EXISTS survey_pool (
    id SERIAL,
    code varchar(20) NOT NULL,
    name varchar(120) NOT NULL,
    description text,
    fee numeric(9,2),
    cert_code varchar(10),
    type varchar(2),
    period interval,
    window_before interval,
    window_after interval,
    is_statutory boolean DEFAULT false,
    is_audit boolean DEFAULT false,
    is_doc boolean DEFAULT false,
    is_mandatory boolean DEFAULT false,
    is_periodical boolean DEFAULT true,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    is_active boolean DEFAULT true,
    CONSTRAINT survey_pool_pkey PRIMARY KEY (id),
    CONSTRAINT survey_pool_code_key UNIQUE (code),
    CONSTRAINT unique_mandatory_survey_audit UNIQUE (cert_code, type),
    CONSTRAINT survey_pool_cert_code_fkey FOREIGN KEY (cert_code) REFERENCES certificate_survey_pool (code) ON DELETE SET NULL,
    CONSTRAINT survey_pool_type_fkey FOREIGN KEY (type) REFERENCES survey_audit_type (code)
);

CREATE TABLE IF NOT EXISTS checklist_section (
    id SERIAL,
    survey_id integer,
    code varchar(50) NOT NULL,
    section_number varchar(20) NOT NULL,
    title text NOT NULL,
    description text,
    is_active boolean DEFAULT true,
    CONSTRAINT checklist_section_pkey PRIMARY KEY (id),
    CONSTRAINT checklist_section_survey_id_fkey FOREIGN KEY (survey_id) REFERENCES survey_pool (id)
);

CREATE TABLE IF NOT EXISTS checklist_item (
    id SERIAL,
    code varchar(100),
    item_number integer NOT NULL,
    section_id integer,
    content varchar(1000),
    description text,
    breakdown_template_node_id integer,
    reg_reference text,
    referenced_item_id integer,
    is_mandatory boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    is_active boolean DEFAULT true,
    CONSTRAINT checklist_item_pkey PRIMARY KEY (id),
    CONSTRAINT checklist_item_breakdown_template_node_id_fkey FOREIGN KEY (breakdown_template_node_id) REFERENCES breakdown_template_node (id) ON DELETE SET NULL,
    CONSTRAINT checklist_item_referenced_item_id_fkey FOREIGN KEY (referenced_item_id) REFERENCES checklist_item (id) ON DELETE CASCADE,
    CONSTRAINT checklist_item_section_id_fkey FOREIGN KEY (section_id) REFERENCES checklist_section (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS checklist_item_particular (
    id SERIAL,
    checklist_item_id bigint NOT NULL,
    attr_key varchar(100) NOT NULL,
    attr_title varchar(300) NOT NULL,
    data_type data_type_enum DEFAULT 'text'::data_type_enum NOT NULL,
    unit varchar(50),
    default_value text,
    selection_options jsonb,
    is_required boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    description text,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT checklist_item_particular_pkey PRIMARY KEY (id),
    CONSTRAINT checklist_item_particular_checklist_item_id_attr_key_key UNIQUE (checklist_item_id, attr_key),
    CONSTRAINT checklist_item_particular_checklist_item_id_fkey FOREIGN KEY (checklist_item_id) REFERENCES checklist_item (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS report_template (
    code varchar(10),
    survey_id integer NOT NULL,
    name varchar(100) NOT NULL,
    version varchar(20) NOT NULL,
    file_path_rml varchar(255),
    file_path_html varchar(255),
    file_path_pdf varchar(255),
    description text,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    is_active boolean DEFAULT true,
    CONSTRAINT report_template_pkey PRIMARY KEY (code),
    CONSTRAINT report_template_survey_id_fkey FOREIGN KEY (survey_id) REFERENCES survey_pool (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS survey_documentation (
    id SERIAL,
    survey_id integer NOT NULL,
    code varchar(100),
    description text,
    guidance text,
    remarks text,
    file_path varchar(255),
    is_mandatory boolean DEFAULT true,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    is_active boolean DEFAULT true,
    CONSTRAINT survey_documentation_pkey PRIMARY KEY (id),
    CONSTRAINT survey_documentation_survey_id_fkey FOREIGN KEY (survey_id) REFERENCES survey_pool (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS survey_preparation (
    id SERIAL,
    survey_id integer NOT NULL,
    code varchar(100),
    category varchar(2),
    description text,
    guidance text,
    remarks text,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    is_active boolean DEFAULT true,
    CONSTRAINT survey_preparation_pkey PRIMARY KEY (id),
    CONSTRAINT survey_preparation_survey_id_fkey FOREIGN KEY (survey_id) REFERENCES survey_pool (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS survey_preparation_section (
    id SERIAL,
    survey_id integer NOT NULL,
    code varchar(100),
    category varchar(20),
    content varchar(1000),
    description text,
    guidance text,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    is_active boolean DEFAULT true,
    CONSTRAINT survey_preparation_section_pkey PRIMARY KEY (id),
    CONSTRAINT survey_preparation_section_survey_id_fkey FOREIGN KEY (survey_id) REFERENCES survey_pool (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS vessel_type_iacs (
    code varchar(2),
    name varchar(100) NOT NULL,
    CONSTRAINT vessel_type_iacs_pkey PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS vessel_type_mms (
    code varchar(2),
    name varchar(100) NOT NULL,
    CONSTRAINT vessel_type_mms_pkey PRIMARY KEY (code)
);

GRANT SELECT ON TABLE administration_type TO ext_user;

GRANT SELECT ON TABLE administration_type TO int_auditor;

GRANT SELECT ON TABLE administration_type TO int_compliance;

GRANT SELECT ON TABLE administration_type TO int_coordinator;

GRANT SELECT ON TABLE administration_type TO int_finance;

GRANT SELECT ON TABLE administration_type TO int_hr;

GRANT SELECT ON TABLE administration_type TO int_manager;

GRANT SELECT ON TABLE administration_type TO int_surveyor;

GRANT SELECT ON TABLE administration_type TO int_sysadmin;

GRANT SELECT ON TABLE administration_type TO int_viewer;

GRANT SELECT ON TABLE breakdown_template TO ext_user;

GRANT SELECT ON TABLE breakdown_template TO int_auditor;

GRANT SELECT ON TABLE breakdown_template TO int_compliance;

GRANT SELECT ON TABLE breakdown_template TO int_coordinator;

GRANT SELECT ON TABLE breakdown_template TO int_finance;

GRANT SELECT ON TABLE breakdown_template TO int_hr;

GRANT SELECT ON TABLE breakdown_template TO int_manager;

GRANT SELECT ON TABLE breakdown_template TO int_surveyor;

GRANT SELECT ON TABLE breakdown_template TO int_sysadmin;

GRANT SELECT ON TABLE breakdown_template TO int_viewer;

GRANT SELECT ON TABLE breakdown_template_node TO ext_user;

GRANT SELECT ON TABLE breakdown_template_node TO int_auditor;

GRANT SELECT ON TABLE breakdown_template_node TO int_compliance;

GRANT SELECT ON TABLE breakdown_template_node TO int_coordinator;

GRANT SELECT ON TABLE breakdown_template_node TO int_finance;

GRANT SELECT ON TABLE breakdown_template_node TO int_hr;

GRANT SELECT ON TABLE breakdown_template_node TO int_manager;

GRANT SELECT ON TABLE breakdown_template_node TO int_surveyor;

GRANT SELECT ON TABLE breakdown_template_node TO int_sysadmin;

GRANT SELECT ON TABLE breakdown_template_node TO int_viewer;

GRANT SELECT ON TABLE breakdown_template_node_particular TO ext_user;

GRANT SELECT ON TABLE breakdown_template_node_particular TO int_auditor;

GRANT SELECT ON TABLE breakdown_template_node_particular TO int_compliance;

GRANT SELECT ON TABLE breakdown_template_node_particular TO int_coordinator;

GRANT SELECT ON TABLE breakdown_template_node_particular TO int_finance;

GRANT SELECT ON TABLE breakdown_template_node_particular TO int_hr;

GRANT SELECT ON TABLE breakdown_template_node_particular TO int_manager;

GRANT SELECT ON TABLE breakdown_template_node_particular TO int_surveyor;

GRANT SELECT ON TABLE breakdown_template_node_particular TO int_sysadmin;

GRANT SELECT ON TABLE breakdown_template_node_particular TO int_viewer;

GRANT SELECT ON TABLE certificate_action TO ext_user;

GRANT SELECT ON TABLE certificate_action TO int_auditor;

GRANT SELECT ON TABLE certificate_action TO int_compliance;

GRANT SELECT ON TABLE certificate_action TO int_coordinator;

GRANT SELECT ON TABLE certificate_action TO int_finance;

GRANT SELECT ON TABLE certificate_action TO int_hr;

GRANT SELECT ON TABLE certificate_action TO int_manager;

GRANT SELECT ON TABLE certificate_action TO int_surveyor;

GRANT SELECT ON TABLE certificate_action TO int_sysadmin;

GRANT SELECT ON TABLE certificate_action TO int_viewer;

GRANT SELECT ON TABLE certificate_category TO ext_user;

GRANT SELECT ON TABLE certificate_category TO int_auditor;

GRANT SELECT ON TABLE certificate_category TO int_compliance;

GRANT SELECT ON TABLE certificate_category TO int_coordinator;

GRANT SELECT ON TABLE certificate_category TO int_finance;

GRANT SELECT ON TABLE certificate_category TO int_hr;

GRANT SELECT ON TABLE certificate_category TO int_manager;

GRANT SELECT ON TABLE certificate_category TO int_surveyor;

GRANT SELECT ON TABLE certificate_category TO int_sysadmin;

GRANT SELECT ON TABLE certificate_category TO int_viewer;

GRANT SELECT ON TABLE certificate_internal_category TO ext_user;

GRANT SELECT ON TABLE certificate_internal_category TO int_auditor;

GRANT SELECT ON TABLE certificate_internal_category TO int_compliance;

GRANT SELECT ON TABLE certificate_internal_category TO int_coordinator;

GRANT SELECT ON TABLE certificate_internal_category TO int_finance;

GRANT SELECT ON TABLE certificate_internal_category TO int_hr;

GRANT SELECT ON TABLE certificate_internal_category TO int_manager;

GRANT SELECT ON TABLE certificate_internal_category TO int_surveyor;

GRANT SELECT ON TABLE certificate_internal_category TO int_sysadmin;

GRANT SELECT ON TABLE certificate_internal_category TO int_viewer;

GRANT SELECT ON TABLE certificate_status TO ext_user;

GRANT SELECT ON TABLE certificate_status TO int_auditor;

GRANT SELECT ON TABLE certificate_status TO int_compliance;

GRANT SELECT ON TABLE certificate_status TO int_coordinator;

GRANT SELECT ON TABLE certificate_status TO int_finance;

GRANT SELECT ON TABLE certificate_status TO int_hr;

GRANT SELECT ON TABLE certificate_status TO int_manager;

GRANT SELECT ON TABLE certificate_status TO int_surveyor;

GRANT SELECT ON TABLE certificate_status TO int_sysadmin;

GRANT SELECT ON TABLE certificate_status TO int_viewer;

GRANT SELECT ON TABLE certificate_survey_pool TO ext_user;

GRANT SELECT ON TABLE certificate_survey_pool TO int_auditor;

GRANT SELECT ON TABLE certificate_survey_pool TO int_compliance;

GRANT SELECT ON TABLE certificate_survey_pool TO int_coordinator;

GRANT SELECT ON TABLE certificate_survey_pool TO int_finance;

GRANT SELECT ON TABLE certificate_survey_pool TO int_hr;

GRANT SELECT ON TABLE certificate_survey_pool TO int_manager;

GRANT SELECT ON TABLE certificate_survey_pool TO int_surveyor;

GRANT SELECT ON TABLE certificate_survey_pool TO int_sysadmin;

GRANT SELECT ON TABLE certificate_survey_pool TO int_viewer;

GRANT SELECT ON TABLE certificate_template TO ext_user;

GRANT SELECT ON TABLE certificate_template TO int_auditor;

GRANT SELECT ON TABLE certificate_template TO int_compliance;

GRANT SELECT ON TABLE certificate_template TO int_coordinator;

GRANT SELECT ON TABLE certificate_template TO int_finance;

GRANT SELECT ON TABLE certificate_template TO int_hr;

GRANT SELECT ON TABLE certificate_template TO int_manager;

GRANT SELECT ON TABLE certificate_template TO int_surveyor;

GRANT SELECT ON TABLE certificate_template TO int_sysadmin;

GRANT SELECT ON TABLE certificate_template TO int_viewer;

GRANT SELECT ON TABLE certificate_validity_type TO ext_user;

GRANT SELECT ON TABLE certificate_validity_type TO int_auditor;

GRANT SELECT ON TABLE certificate_validity_type TO int_compliance;

GRANT SELECT ON TABLE certificate_validity_type TO int_coordinator;

GRANT SELECT ON TABLE certificate_validity_type TO int_finance;

GRANT SELECT ON TABLE certificate_validity_type TO int_hr;

GRANT SELECT ON TABLE certificate_validity_type TO int_manager;

GRANT SELECT ON TABLE certificate_validity_type TO int_surveyor;

GRANT SELECT ON TABLE certificate_validity_type TO int_sysadmin;

GRANT SELECT ON TABLE certificate_validity_type TO int_viewer;

GRANT SELECT ON TABLE checklist_item TO ext_user;

GRANT SELECT ON TABLE checklist_item TO int_auditor;

GRANT SELECT ON TABLE checklist_item TO int_compliance;

GRANT SELECT ON TABLE checklist_item TO int_coordinator;

GRANT SELECT ON TABLE checklist_item TO int_finance;

GRANT SELECT ON TABLE checklist_item TO int_hr;

GRANT SELECT ON TABLE checklist_item TO int_manager;

GRANT SELECT ON TABLE checklist_item TO int_surveyor;

GRANT SELECT ON TABLE checklist_item TO int_sysadmin;

GRANT SELECT ON TABLE checklist_item TO int_viewer;

GRANT SELECT ON TABLE checklist_item_particular TO ext_user;

GRANT SELECT ON TABLE checklist_item_particular TO int_auditor;

GRANT SELECT ON TABLE checklist_item_particular TO int_compliance;

GRANT SELECT ON TABLE checklist_item_particular TO int_coordinator;

GRANT SELECT ON TABLE checklist_item_particular TO int_finance;

GRANT SELECT ON TABLE checklist_item_particular TO int_hr;

GRANT SELECT ON TABLE checklist_item_particular TO int_manager;

GRANT SELECT ON TABLE checklist_item_particular TO int_surveyor;

GRANT SELECT ON TABLE checklist_item_particular TO int_sysadmin;

GRANT SELECT ON TABLE checklist_item_particular TO int_viewer;

GRANT SELECT ON TABLE checklist_result TO ext_user;

GRANT SELECT ON TABLE checklist_result TO int_auditor;

GRANT SELECT ON TABLE checklist_result TO int_compliance;

GRANT SELECT ON TABLE checklist_result TO int_coordinator;

GRANT SELECT ON TABLE checklist_result TO int_finance;

GRANT SELECT ON TABLE checklist_result TO int_hr;

GRANT SELECT ON TABLE checklist_result TO int_manager;

GRANT SELECT ON TABLE checklist_result TO int_surveyor;

GRANT SELECT ON TABLE checklist_result TO int_sysadmin;

GRANT SELECT ON TABLE checklist_result TO int_viewer;

GRANT SELECT ON TABLE checklist_section TO ext_user;

GRANT SELECT ON TABLE checklist_section TO int_auditor;

GRANT SELECT ON TABLE checklist_section TO int_compliance;

GRANT SELECT ON TABLE checklist_section TO int_coordinator;

GRANT SELECT ON TABLE checklist_section TO int_finance;

GRANT SELECT ON TABLE checklist_section TO int_hr;

GRANT SELECT ON TABLE checklist_section TO int_manager;

GRANT SELECT ON TABLE checklist_section TO int_surveyor;

GRANT SELECT ON TABLE checklist_section TO int_sysadmin;

GRANT SELECT ON TABLE checklist_section TO int_viewer;

GRANT SELECT ON TABLE class_notation TO ext_user;

GRANT SELECT ON TABLE class_notation TO int_auditor;

GRANT SELECT ON TABLE class_notation TO int_compliance;

GRANT SELECT ON TABLE class_notation TO int_coordinator;

GRANT SELECT ON TABLE class_notation TO int_finance;

GRANT SELECT ON TABLE class_notation TO int_hr;

GRANT SELECT ON TABLE class_notation TO int_manager;

GRANT SELECT ON TABLE class_notation TO int_surveyor;

GRANT SELECT ON TABLE class_notation TO int_sysadmin;

GRANT SELECT ON TABLE class_notation TO int_viewer;

GRANT SELECT ON TABLE class_status TO ext_user;

GRANT SELECT ON TABLE class_status TO int_auditor;

GRANT SELECT ON TABLE class_status TO int_compliance;

GRANT SELECT ON TABLE class_status TO int_coordinator;

GRANT SELECT ON TABLE class_status TO int_finance;

GRANT SELECT ON TABLE class_status TO int_hr;

GRANT SELECT ON TABLE class_status TO int_manager;

GRANT SELECT ON TABLE class_status TO int_surveyor;

GRANT SELECT ON TABLE class_status TO int_sysadmin;

GRANT SELECT ON TABLE class_status TO int_viewer;

GRANT SELECT ON TABLE classification_society TO ext_user;

GRANT SELECT ON TABLE classification_society TO int_auditor;

GRANT SELECT ON TABLE classification_society TO int_compliance;

GRANT SELECT ON TABLE classification_society TO int_coordinator;

GRANT SELECT ON TABLE classification_society TO int_finance;

GRANT SELECT ON TABLE classification_society TO int_hr;

GRANT SELECT ON TABLE classification_society TO int_manager;

GRANT SELECT ON TABLE classification_society TO int_surveyor;

GRANT SELECT ON TABLE classification_society TO int_sysadmin;

GRANT SELECT ON TABLE classification_society TO int_viewer;

GRANT SELECT ON TABLE comment_status TO ext_user;

GRANT SELECT ON TABLE comment_status TO int_auditor;

GRANT SELECT ON TABLE comment_status TO int_compliance;

GRANT SELECT ON TABLE comment_status TO int_coordinator;

GRANT SELECT ON TABLE comment_status TO int_finance;

GRANT SELECT ON TABLE comment_status TO int_hr;

GRANT SELECT ON TABLE comment_status TO int_manager;

GRANT SELECT ON TABLE comment_status TO int_surveyor;

GRANT SELECT ON TABLE comment_status TO int_sysadmin;

GRANT SELECT ON TABLE comment_status TO int_viewer;

GRANT SELECT ON TABLE comment_type TO ext_user;

GRANT SELECT ON TABLE comment_type TO int_auditor;

GRANT SELECT ON TABLE comment_type TO int_compliance;

GRANT SELECT ON TABLE comment_type TO int_coordinator;

GRANT SELECT ON TABLE comment_type TO int_finance;

GRANT SELECT ON TABLE comment_type TO int_hr;

GRANT SELECT ON TABLE comment_type TO int_manager;

GRANT SELECT ON TABLE comment_type TO int_surveyor;

GRANT SELECT ON TABLE comment_type TO int_sysadmin;

GRANT SELECT ON TABLE comment_type TO int_viewer;

GRANT SELECT ON TABLE flag TO ext_user;

GRANT SELECT ON TABLE flag TO int_auditor;

GRANT SELECT ON TABLE flag TO int_compliance;

GRANT SELECT ON TABLE flag TO int_coordinator;

GRANT SELECT ON TABLE flag TO int_finance;

GRANT SELECT ON TABLE flag TO int_hr;

GRANT SELECT ON TABLE flag TO int_manager;

GRANT SELECT ON TABLE flag TO int_surveyor;

GRANT SELECT ON TABLE flag TO int_sysadmin;

GRANT SELECT ON TABLE flag TO int_viewer;

GRANT SELECT ON TABLE flag_cert_authorization TO ext_user;

GRANT SELECT ON TABLE flag_cert_authorization TO int_auditor;

GRANT SELECT ON TABLE flag_cert_authorization TO int_compliance;

GRANT SELECT ON TABLE flag_cert_authorization TO int_coordinator;

GRANT SELECT ON TABLE flag_cert_authorization TO int_finance;

GRANT SELECT ON TABLE flag_cert_authorization TO int_hr;

GRANT SELECT ON TABLE flag_cert_authorization TO int_manager;

GRANT SELECT ON TABLE flag_cert_authorization TO int_surveyor;

GRANT SELECT ON TABLE flag_cert_authorization TO int_sysadmin;

GRANT SELECT ON TABLE flag_cert_authorization TO int_viewer;

GRANT SELECT ON TABLE flag_survey_authorization TO ext_user;

GRANT SELECT ON TABLE flag_survey_authorization TO int_auditor;

GRANT SELECT ON TABLE flag_survey_authorization TO int_compliance;

GRANT SELECT ON TABLE flag_survey_authorization TO int_coordinator;

GRANT SELECT ON TABLE flag_survey_authorization TO int_finance;

GRANT SELECT ON TABLE flag_survey_authorization TO int_hr;

GRANT SELECT ON TABLE flag_survey_authorization TO int_manager;

GRANT SELECT ON TABLE flag_survey_authorization TO int_surveyor;

GRANT SELECT ON TABLE flag_survey_authorization TO int_sysadmin;

GRANT SELECT ON TABLE flag_survey_authorization TO int_viewer;

GRANT SELECT ON TABLE notation_compatibility TO ext_user;

GRANT SELECT ON TABLE notation_compatibility TO int_auditor;

GRANT SELECT ON TABLE notation_compatibility TO int_compliance;

GRANT SELECT ON TABLE notation_compatibility TO int_coordinator;

GRANT SELECT ON TABLE notation_compatibility TO int_finance;

GRANT SELECT ON TABLE notation_compatibility TO int_hr;

GRANT SELECT ON TABLE notation_compatibility TO int_manager;

GRANT SELECT ON TABLE notation_compatibility TO int_surveyor;

GRANT SELECT ON TABLE notation_compatibility TO int_sysadmin;

GRANT SELECT ON TABLE notation_compatibility TO int_viewer;

GRANT SELECT ON TABLE notation_group TO ext_user;

GRANT SELECT ON TABLE notation_group TO int_auditor;

GRANT SELECT ON TABLE notation_group TO int_compliance;

GRANT SELECT ON TABLE notation_group TO int_coordinator;

GRANT SELECT ON TABLE notation_group TO int_finance;

GRANT SELECT ON TABLE notation_group TO int_hr;

GRANT SELECT ON TABLE notation_group TO int_manager;

GRANT SELECT ON TABLE notation_group TO int_surveyor;

GRANT SELECT ON TABLE notation_group TO int_sysadmin;

GRANT SELECT ON TABLE notation_group TO int_viewer;

GRANT SELECT ON TABLE report_template TO ext_user;

GRANT SELECT ON TABLE report_template TO int_auditor;

GRANT SELECT ON TABLE report_template TO int_compliance;

GRANT SELECT ON TABLE report_template TO int_coordinator;

GRANT SELECT ON TABLE report_template TO int_finance;

GRANT SELECT ON TABLE report_template TO int_hr;

GRANT SELECT ON TABLE report_template TO int_manager;

GRANT SELECT ON TABLE report_template TO int_surveyor;

GRANT SELECT ON TABLE report_template TO int_sysadmin;

GRANT SELECT ON TABLE report_template TO int_viewer;

GRANT SELECT ON TABLE ship_status TO ext_user;

GRANT SELECT ON TABLE ship_status TO int_auditor;

GRANT SELECT ON TABLE ship_status TO int_compliance;

GRANT SELECT ON TABLE ship_status TO int_coordinator;

GRANT SELECT ON TABLE ship_status TO int_finance;

GRANT SELECT ON TABLE ship_status TO int_hr;

GRANT SELECT ON TABLE ship_status TO int_manager;

GRANT SELECT ON TABLE ship_status TO int_surveyor;

GRANT SELECT ON TABLE ship_status TO int_sysadmin;

GRANT SELECT ON TABLE ship_status TO int_viewer;

GRANT SELECT ON TABLE society_group_rendering TO ext_user;

GRANT SELECT ON TABLE society_group_rendering TO int_auditor;

GRANT SELECT ON TABLE society_group_rendering TO int_compliance;

GRANT SELECT ON TABLE society_group_rendering TO int_coordinator;

GRANT SELECT ON TABLE society_group_rendering TO int_finance;

GRANT SELECT ON TABLE society_group_rendering TO int_hr;

GRANT SELECT ON TABLE society_group_rendering TO int_manager;

GRANT SELECT ON TABLE society_group_rendering TO int_surveyor;

GRANT SELECT ON TABLE society_group_rendering TO int_sysadmin;

GRANT SELECT ON TABLE society_group_rendering TO int_viewer;

GRANT SELECT ON TABLE survey_audit_status TO ext_user;

GRANT SELECT ON TABLE survey_audit_status TO int_auditor;

GRANT SELECT ON TABLE survey_audit_status TO int_compliance;

GRANT SELECT ON TABLE survey_audit_status TO int_coordinator;

GRANT SELECT ON TABLE survey_audit_status TO int_finance;

GRANT SELECT ON TABLE survey_audit_status TO int_hr;

GRANT SELECT ON TABLE survey_audit_status TO int_manager;

GRANT SELECT ON TABLE survey_audit_status TO int_surveyor;

GRANT SELECT ON TABLE survey_audit_status TO int_sysadmin;

GRANT SELECT ON TABLE survey_audit_status TO int_viewer;

GRANT SELECT ON TABLE survey_audit_type TO ext_user;

GRANT SELECT ON TABLE survey_audit_type TO int_auditor;

GRANT SELECT ON TABLE survey_audit_type TO int_compliance;

GRANT SELECT ON TABLE survey_audit_type TO int_coordinator;

GRANT SELECT ON TABLE survey_audit_type TO int_finance;

GRANT SELECT ON TABLE survey_audit_type TO int_hr;

GRANT SELECT ON TABLE survey_audit_type TO int_manager;

GRANT SELECT ON TABLE survey_audit_type TO int_surveyor;

GRANT SELECT ON TABLE survey_audit_type TO int_sysadmin;

GRANT SELECT ON TABLE survey_audit_type TO int_viewer;

GRANT SELECT ON TABLE survey_documentation TO ext_user;

GRANT SELECT ON TABLE survey_documentation TO int_auditor;

GRANT SELECT ON TABLE survey_documentation TO int_compliance;

GRANT SELECT ON TABLE survey_documentation TO int_coordinator;

GRANT SELECT ON TABLE survey_documentation TO int_finance;

GRANT SELECT ON TABLE survey_documentation TO int_hr;

GRANT SELECT ON TABLE survey_documentation TO int_manager;

GRANT SELECT ON TABLE survey_documentation TO int_surveyor;

GRANT SELECT ON TABLE survey_documentation TO int_sysadmin;

GRANT SELECT ON TABLE survey_documentation TO int_viewer;

GRANT SELECT ON TABLE survey_pool TO ext_user;

GRANT SELECT ON TABLE survey_pool TO int_auditor;

GRANT SELECT ON TABLE survey_pool TO int_compliance;

GRANT SELECT ON TABLE survey_pool TO int_coordinator;

GRANT SELECT ON TABLE survey_pool TO int_finance;

GRANT SELECT ON TABLE survey_pool TO int_hr;

GRANT SELECT ON TABLE survey_pool TO int_manager;

GRANT SELECT ON TABLE survey_pool TO int_surveyor;

GRANT SELECT ON TABLE survey_pool TO int_sysadmin;

GRANT SELECT ON TABLE survey_pool TO int_viewer;

GRANT SELECT ON TABLE survey_preparation TO ext_user;

GRANT SELECT ON TABLE survey_preparation TO int_auditor;

GRANT SELECT ON TABLE survey_preparation TO int_compliance;

GRANT SELECT ON TABLE survey_preparation TO int_coordinator;

GRANT SELECT ON TABLE survey_preparation TO int_finance;

GRANT SELECT ON TABLE survey_preparation TO int_hr;

GRANT SELECT ON TABLE survey_preparation TO int_manager;

GRANT SELECT ON TABLE survey_preparation TO int_surveyor;

GRANT SELECT ON TABLE survey_preparation TO int_sysadmin;

GRANT SELECT ON TABLE survey_preparation TO int_viewer;

GRANT SELECT ON TABLE survey_preparation_section TO ext_user;

GRANT SELECT ON TABLE survey_preparation_section TO int_auditor;

GRANT SELECT ON TABLE survey_preparation_section TO int_compliance;

GRANT SELECT ON TABLE survey_preparation_section TO int_coordinator;

GRANT SELECT ON TABLE survey_preparation_section TO int_finance;

GRANT SELECT ON TABLE survey_preparation_section TO int_hr;

GRANT SELECT ON TABLE survey_preparation_section TO int_manager;

GRANT SELECT ON TABLE survey_preparation_section TO int_surveyor;

GRANT SELECT ON TABLE survey_preparation_section TO int_sysadmin;

GRANT SELECT ON TABLE survey_preparation_section TO int_viewer;

GRANT SELECT ON TABLE vessel_type_iacs TO ext_user;

GRANT SELECT ON TABLE vessel_type_iacs TO int_auditor;

GRANT SELECT ON TABLE vessel_type_iacs TO int_compliance;

GRANT SELECT ON TABLE vessel_type_iacs TO int_coordinator;

GRANT SELECT ON TABLE vessel_type_iacs TO int_finance;

GRANT SELECT ON TABLE vessel_type_iacs TO int_hr;

GRANT SELECT ON TABLE vessel_type_iacs TO int_manager;

GRANT SELECT ON TABLE vessel_type_iacs TO int_surveyor;

GRANT SELECT ON TABLE vessel_type_iacs TO int_sysadmin;

GRANT SELECT ON TABLE vessel_type_iacs TO int_viewer;

GRANT SELECT ON TABLE vessel_type_mms TO ext_user;

GRANT SELECT ON TABLE vessel_type_mms TO int_auditor;

GRANT SELECT ON TABLE vessel_type_mms TO int_compliance;

GRANT SELECT ON TABLE vessel_type_mms TO int_coordinator;

GRANT SELECT ON TABLE vessel_type_mms TO int_finance;

GRANT SELECT ON TABLE vessel_type_mms TO int_hr;

GRANT SELECT ON TABLE vessel_type_mms TO int_manager;

GRANT SELECT ON TABLE vessel_type_mms TO int_surveyor;

GRANT SELECT ON TABLE vessel_type_mms TO int_sysadmin;

GRANT SELECT ON TABLE vessel_type_mms TO int_viewer;
