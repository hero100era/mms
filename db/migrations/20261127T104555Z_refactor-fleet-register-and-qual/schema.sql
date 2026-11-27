-- ===== schema: private  (pgschema 1.14.1) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION assert_authority(
    p_action_code text,
    p_amount numeric DEFAULT NULL
)
RETURNS TABLE(rule_id uuid, title text, grade integer, unit_id uuid, unit_type text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_position record;
  v_rule record;
begin
  -- Enforce the explicit break-glass prohibition before any position lookup.
  perform private.assert_not_break_glass(p_action_code);

  select * into v_position from private.my_position();
  if not found then
    perform private.emit_event(
      'authz.denied.insufficient_authority', 'denied', 'authority_rule', null, null, null,
      jsonb_build_object('action', p_action_code, 'role', private.active_role(), 'reason', 'no_position'));
    raise exception 'insufficient_authority' using errcode = '42501';
  end if;

  select r.id, r.min_grade, r.max_amount, r.requires_qualification
    into v_rule
    from iam.authority_rule r
   where r.action_code = p_action_code
     and r.db_role = private.active_role()
     and (r.job_family is null or r.job_family = v_position.job_family)
     and (r.unit_type is null or r.unit_type = v_position.unit_type)
     and v_position.grade >= r.min_grade
     and r.valid @> now()
     and (r.max_amount is null or (p_amount is not null and p_amount <= r.max_amount))
   order by r.min_grade desc, r.max_amount nulls first
   limit 1;

  if not found then
    perform private.emit_event(
      'authz.denied.insufficient_authority', 'denied', 'authority_rule', null,
      v_position.unit_id, null,
      jsonb_build_object(
        'action', p_action_code,
        'role', private.active_role(),
        'title', v_position.job_title_code,
        'grade', v_position.grade,
        'unit_type', v_position.unit_type,
        'amount', p_amount));
    raise exception 'insufficient_authority' using errcode = '42501';
  end if;

  if v_rule.requires_qualification then
    if not exists (
      select 1
        from qual.staff_qualification sq
        left join qual.qualification_action qa on qa.qualification_code = sq.qualification_code
       where sq.user_id = private.uid()
         and sq.valid @> now()
         and sq.revoked_at is null
         and (
           sq.qualification_code = p_action_code
           or qa.action_code = p_action_code
         )
    ) then
      perform private.emit_event(
        'authz.denied.insufficient_authority', 'denied', 'authority_rule', v_rule.id,
        v_position.unit_id, null,
        jsonb_build_object(
          'action', p_action_code,
          'role', private.active_role(),
          'title', v_position.job_title_code,
          'grade', v_position.grade,
          'unit_type', v_position.unit_type,
          'reason', 'qualification_required'));
      raise exception 'insufficient_authority' using errcode = '42501';
    end if;
  end if;

  perform set_config('mms.authority_rule_id', v_rule.id::text, true);
  perform set_config('mms.authority_title', v_position.job_title_code, true);
  perform set_config('mms.authority_grade', v_position.grade::text, true);
  perform set_config('mms.authority_unit_id', v_position.unit_id::text, true);

  return query select v_rule.id, v_position.job_title_code, v_position.grade,
                      v_position.unit_id, v_position.unit_type;
end;
$$;

CREATE OR REPLACE FUNCTION explain_authority(
    p_action_code text,
    p_amount numeric DEFAULT NULL,
    p_unit_id uuid DEFAULT NULL,
    p_record_id uuid DEFAULT NULL
)
RETURNS TABLE(allowed boolean, reason_code text, action_code text, rule_id uuid, details jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_position record;
  v_rule record;
  v_role text := private.active_role();
  v_src text := private.audit_source();
  v_uid uuid := private.uid();
  v_req_creator uuid;
  v_proposal record;
  v_qual_user uuid;
begin
  -- 1. Break-glass prohibition check
  if v_src = 'break_glass' and exists (
    select 1 from iam.break_glass_forbidden_action bg where bg.action_code = p_action_code
  ) then
    return query select false, 'break_glass_forbidden'::text, p_action_code, null::uuid,
      jsonb_build_object('source', 'break_glass');
    return;
  end if;

  -- 2. Sysadmin cannot approve regulated business records
  if v_role = 'int_sysadmin' and p_action_code in (
    'survey.request.triage', 'survey.job.assign', 'survey.report.release',
    'survey.report.countersign', 'audit_trail.report.release', 'billing.credit_note.approve',
    'hr.position.set', 'qual.grant', 'qual.revoke', 'cert.issue', 'cert.cancel',
    'cert.revoke', 'compliance.record.hold'
  ) then
    return query select false, 'sysadmin_cannot_approve'::text, p_action_code, null::uuid,
      jsonb_build_object('role', v_role);
    return;
  end if;

  -- 3. Position check
  select * into v_position from private.my_position();
  if not found then
    return query select false, 'no_position'::text, p_action_code, null::uuid,
      jsonb_build_object('role', v_role);
    return;
  end if;

  -- 4. Scope check (if p_unit_id supplied)
  if p_unit_id is not null then
    if not (p_unit_id = any (private.my_units()) or p_unit_id = any (private.my_offices())) then
      return query select false, 'out_of_scope'::text, p_action_code, null::uuid,
        jsonb_build_object('unit_id', p_unit_id);
      return;
    end if;
  end if;

  -- 5. Segregation of duties checks (if p_record_id supplied)
  if p_record_id is not null then
    if p_action_code = 'survey.request.triage' then
      select created_by into v_req_creator from survey.survey_request where id = p_record_id;
      if found and v_req_creator is not null and v_req_creator = v_uid then
        return query select false, 'creator_cannot_approve'::text, p_action_code, null::uuid,
          jsonb_build_object('record_id', p_record_id);
        return;
      end if;
    elsif p_action_code = 'hr.position.set' then
      if p_record_id = v_uid then
        return query select false, 'cannot_approve_own'::text, p_action_code, null::uuid,
          jsonb_build_object('user_id', p_record_id);
        return;
      end if;
      select proposed_by, user_id into v_proposal from iam.position_proposal where id = p_record_id;
      if found and (v_proposal.proposed_by = v_uid or v_proposal.user_id = v_uid) then
        return query select false, 'cannot_confirm_own_proposal'::text, p_action_code, null::uuid,
          jsonb_build_object('proposal_id', p_record_id);
        return;
      end if;
    elsif p_action_code = 'qual.grant' then
      if p_record_id = v_uid then
        return query select false, 'cannot_grant_self'::text, p_action_code, null::uuid,
          jsonb_build_object('user_id', p_record_id);
        return;
      end if;
    elsif p_action_code = 'qual.revoke' then
      if p_record_id = v_uid then
        return query select false, 'cannot_revoke_self'::text, p_action_code, null::uuid,
          jsonb_build_object('user_id', p_record_id);
        return;
      end if;
      select user_id into v_qual_user from qual.staff_qualification where id = p_record_id;
      if found and v_qual_user = v_uid then
        return query select false, 'cannot_revoke_self'::text, p_action_code, null::uuid,
          jsonb_build_object('qualification_id', p_record_id, 'user_id', v_qual_user);
        return;
      end if;
    end if;
  end if;

  -- 6. Authority rule matching
  select r.id, r.min_grade, r.max_amount, r.requires_qualification
    into v_rule
    from iam.authority_rule r
   where r.action_code = p_action_code
     and r.db_role = v_role
     and (r.job_family is null or r.job_family = v_position.job_family)
     and (r.unit_type is null or r.unit_type = v_position.unit_type)
     and v_position.grade >= r.min_grade
     and r.valid @> now()
     and (r.max_amount is null or (p_amount is not null and p_amount <= r.max_amount))
   order by r.min_grade desc, r.max_amount nulls first
   limit 1;

  if not found then
    if not exists (select 1 from iam.authority_rule ar where ar.action_code = p_action_code and ar.db_role = v_role and ar.valid @> now()) then
      return query select false, 'rule_not_found'::text, p_action_code, null::uuid,
        jsonb_build_object('action', p_action_code, 'role', v_role);
    elsif p_amount is not null and exists (
      select 1 from iam.authority_rule ar
       where ar.action_code = p_action_code and ar.db_role = v_role and ar.valid @> now()
         and (ar.job_family is null or ar.job_family = v_position.job_family)
         and (ar.unit_type is null or ar.unit_type = v_position.unit_type)
         and v_position.grade >= ar.min_grade
         and ar.max_amount is not null and p_amount > ar.max_amount
    ) then
      return query select false, 'amount_exceeded'::text, p_action_code, null::uuid,
        jsonb_build_object('amount', p_amount);
    elsif not exists (
      select 1 from iam.authority_rule ar
       where ar.action_code = p_action_code and ar.db_role = v_role and ar.valid @> now()
         and (ar.job_family is null or ar.job_family = v_position.job_family)
         and (ar.unit_type is null or ar.unit_type = v_position.unit_type)
         and v_position.grade >= ar.min_grade
    ) then
      return query select false, 'min_grade_insufficient'::text, p_action_code, null::uuid,
        jsonb_build_object('grade', v_position.grade);
    else
      return query select false, 'position_ineligible'::text, p_action_code, null::uuid,
        jsonb_build_object('job_family', v_position.job_family, 'unit_type', v_position.unit_type);
    end if;
    return;
  end if;

  -- 7. Qualification check
  if v_rule.requires_qualification then
    if not exists (
      select 1
        from qual.staff_qualification sq
        left join qual.qualification_action qa on qa.qualification_code = sq.qualification_code
       where sq.user_id = v_uid
         and sq.valid @> now()
         and sq.revoked_at is null
         and (
           sq.qualification_code = p_action_code
           or qa.action_code = p_action_code
         )
    ) then
      return query select false, 'qualification_required'::text, p_action_code, v_rule.id,
        jsonb_build_object('action', p_action_code);
      return;
    end if;
  end if;

  -- 8. Allowed
  return query select true, 'ok'::text, p_action_code, v_rule.id,
    jsonb_build_object('title', v_position.job_title_code, 'grade', v_position.grade);
end;
$$;

-- ===== schema: core  (pgschema 1.14.1) =====

set local search_path = core;

REVOKE SELECT ON TABLE comment_status FROM ext_user;

REVOKE SELECT ON TABLE comment_status FROM int_auditor;

REVOKE SELECT ON TABLE comment_status FROM int_compliance;

REVOKE SELECT ON TABLE comment_status FROM int_coordinator;

REVOKE SELECT ON TABLE comment_status FROM int_finance;

REVOKE SELECT ON TABLE comment_status FROM int_hr;

REVOKE SELECT ON TABLE comment_status FROM int_manager;

REVOKE SELECT ON TABLE comment_status FROM int_surveyor;

REVOKE SELECT ON TABLE comment_status FROM int_sysadmin;

REVOKE SELECT ON TABLE comment_status FROM int_viewer;

REVOKE SELECT ON TABLE comment_type FROM ext_user;

REVOKE SELECT ON TABLE comment_type FROM int_auditor;

REVOKE SELECT ON TABLE comment_type FROM int_compliance;

REVOKE SELECT ON TABLE comment_type FROM int_coordinator;

REVOKE SELECT ON TABLE comment_type FROM int_finance;

REVOKE SELECT ON TABLE comment_type FROM int_hr;

REVOKE SELECT ON TABLE comment_type FROM int_manager;

REVOKE SELECT ON TABLE comment_type FROM int_surveyor;

REVOKE SELECT ON TABLE comment_type FROM int_sysadmin;

REVOKE SELECT ON TABLE comment_type FROM int_viewer;

DROP TABLE IF EXISTS comment_type CASCADE;

DROP TABLE IF EXISTS comment_status CASCADE;

CREATE TABLE IF NOT EXISTS finding_status (
    code varchar(1),
    name varchar(30) NOT NULL,
    CONSTRAINT finding_status_pkey PRIMARY KEY (code)
);

ALTER TABLE finding_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY finding_status_read ON finding_status FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

CREATE TABLE IF NOT EXISTS finding_type (
    code varchar(2),
    name varchar(100) NOT NULL,
    CONSTRAINT finding_type_pkey PRIMARY KEY (code)
);

ALTER TABLE finding_type ENABLE ROW LEVEL SECURITY;

CREATE POLICY finding_type_read ON finding_type FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

GRANT SELECT ON TABLE finding_status TO ext_user;

GRANT SELECT ON TABLE finding_status TO int_auditor;

GRANT SELECT ON TABLE finding_status TO int_compliance;

GRANT SELECT ON TABLE finding_status TO int_coordinator;

GRANT SELECT ON TABLE finding_status TO int_finance;

GRANT SELECT ON TABLE finding_status TO int_hr;

GRANT SELECT ON TABLE finding_status TO int_manager;

GRANT SELECT ON TABLE finding_status TO int_surveyor;

GRANT SELECT ON TABLE finding_status TO int_sysadmin;

GRANT SELECT ON TABLE finding_status TO int_viewer;

GRANT SELECT ON TABLE finding_type TO ext_user;

GRANT SELECT ON TABLE finding_type TO int_auditor;

GRANT SELECT ON TABLE finding_type TO int_compliance;

GRANT SELECT ON TABLE finding_type TO int_coordinator;

GRANT SELECT ON TABLE finding_type TO int_finance;

GRANT SELECT ON TABLE finding_type TO int_hr;

GRANT SELECT ON TABLE finding_type TO int_manager;

GRANT SELECT ON TABLE finding_type TO int_surveyor;

GRANT SELECT ON TABLE finding_type TO int_sysadmin;

GRANT SELECT ON TABLE finding_type TO int_viewer;

-- ===== schema: fleet  (pgschema 1.14.1) =====

set local search_path = fleet;

ALTER TABLE certificate DROP COLUMN company_id;

ALTER TABLE certificate DROP COLUMN remark;

ALTER TABLE certificate DROP COLUMN issued_by;

ALTER TABLE certificate
ADD COLUMN org_id uuid CONSTRAINT certificate_org_fk REFERENCES party.organization (id) ON DELETE SET NULL;

ALTER TABLE certificate ADD COLUMN remarks text;

ALTER TABLE certificate
ADD COLUMN issuing_society_code varchar(20) NOT NULL CONSTRAINT certificate_issuing_society_fk REFERENCES core.classification_society (code);

ALTER TABLE fleet.certificate
ADD CONSTRAINT certificate_target_ck CHECK (ship_id IS NOT NULL OR org_id IS NOT NULL) NOT VALID;

ALTER TABLE fleet.certificate VALIDATE CONSTRAINT certificate_target_ck;

CREATE POLICY certificate_ext_read ON certificate FOR SELECT TO ext_user USING ((org_id = ANY (private.my_org_ids())) OR (EXISTS ( SELECT 1 FROM ship_party sp WHERE ((sp.ship_id = certificate.ship_id) AND (sp.org_id = ANY (private.my_org_ids())) AND (sp.valid @> now())))));

DROP INDEX IF EXISTS certificate_company_ix;



ALTER TABLE finding_comment DROP COLUMN company_id;

ALTER TABLE finding_comment DROP COLUMN comment_type;

ALTER TABLE finding_comment
ADD COLUMN org_id uuid CONSTRAINT finding_comment_org_fk REFERENCES party.organization (id) ON DELETE CASCADE;

ALTER TABLE finding_comment
ADD COLUMN finding_type varchar(2) NOT NULL CONSTRAINT finding_comment_type_fk REFERENCES core.finding_type (code);

ALTER TABLE fleet.finding_comment
ADD CONSTRAINT finding_comment_status_fk FOREIGN KEY (status) REFERENCES core.finding_status (code) NOT VALID;

ALTER TABLE fleet.finding_comment VALIDATE CONSTRAINT finding_comment_status_fk;

ALTER TABLE fleet.finding_comment
ADD CONSTRAINT finding_comment_target_ck CHECK (ship_id IS NOT NULL OR org_id IS NOT NULL) NOT VALID;

ALTER TABLE fleet.finding_comment VALIDATE CONSTRAINT finding_comment_target_ck;

CREATE POLICY finding_comment_ext_read ON finding_comment FOR SELECT TO ext_user USING ((is_private IS FALSE) AND ((org_id = ANY (private.my_org_ids())) OR (EXISTS ( SELECT 1 FROM ship_party sp WHERE ((sp.ship_id = finding_comment.ship_id) AND (sp.org_id = ANY (private.my_org_ids())) AND (sp.valid @> now()))))));

DROP INDEX IF EXISTS finding_comment_company_ix;



ALTER TABLE finding_comment_survey_audit DROP CONSTRAINT finding_comment_survey_audit_pk;

ALTER TABLE finding_comment_survey_audit
ADD CONSTRAINT finding_comment_survey_audit_pk PRIMARY KEY (finding_comment_id, survey_audit_id);

ALTER TABLE survey_audit DROP COLUMN company_id;

ALTER TABLE survey_audit
ADD COLUMN org_id uuid CONSTRAINT survey_audit_org_fk REFERENCES party.organization (id) ON DELETE CASCADE;

ALTER TABLE fleet.survey_audit
ADD CONSTRAINT survey_audit_target_ck CHECK (ship_id IS NOT NULL OR org_id IS NOT NULL OR certificate_id IS NOT NULL) NOT VALID;

ALTER TABLE fleet.survey_audit VALIDATE CONSTRAINT survey_audit_target_ck;

CREATE POLICY survey_audit_ext_read ON survey_audit FOR SELECT TO ext_user USING ((org_id = ANY (private.my_org_ids())) OR (EXISTS ( SELECT 1 FROM ship_party sp WHERE ((sp.ship_id = survey_audit.ship_id) AND (sp.org_id = ANY (private.my_org_ids())) AND (sp.valid @> now())))));

DROP INDEX IF EXISTS survey_audit_company_ix;

-- ===== schema: survey  (pgschema 1.14.1) =====

set local search_path = survey;

CREATE TABLE IF NOT EXISTS finding_line (
    id uuid DEFAULT uuidv7(),
    job_id uuid NOT NULL,
    finding_comment_id uuid,
    finding_type varchar(2),
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
    CONSTRAINT finding_line_pk PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS finding_line_fc_ix ON finding_line (finding_comment_id);

CREATE INDEX IF NOT EXISTS finding_line_job_ix ON finding_line (job_id);

ALTER TABLE finding_line ENABLE ROW LEVEL SECURITY;

CREATE POLICY finding_line_ext_read ON finding_line FOR SELECT TO ext_user USING ((is_private IS FALSE) AND (EXISTS ( SELECT 1 FROM job j WHERE (j.id = finding_line.job_id))));

CREATE POLICY finding_line_staff_read ON finding_line FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (EXISTS ( SELECT 1 FROM job j WHERE ((j.id = finding_line.job_id) AND (j.office_unit_id = ANY (private.my_offices())))));

ALTER TABLE finding_line
ADD CONSTRAINT finding_line_fc_fk FOREIGN KEY (finding_comment_id) REFERENCES fleet.finding_comment (id) ON DELETE SET NULL;

ALTER TABLE finding_line
ADD CONSTRAINT finding_line_job_fk FOREIGN KEY (job_id) REFERENCES job (id) ON DELETE CASCADE;

ALTER TABLE finding_line
ADD CONSTRAINT finding_line_status_fk FOREIGN KEY (status) REFERENCES core.finding_status (code);

ALTER TABLE finding_line
ADD CONSTRAINT finding_line_type_fk FOREIGN KEY (finding_type) REFERENCES core.finding_type (code);

CREATE OR REPLACE TRIGGER finding_line_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON finding_line
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER finding_line_stamp
    BEFORE INSERT OR UPDATE ON finding_line
    FOR EACH ROW
    EXECUTE FUNCTION private.stamp();

GRANT SELECT ON TABLE finding_line TO ext_user;

GRANT SELECT ON TABLE finding_line TO int_auditor;

GRANT SELECT ON TABLE finding_line TO int_compliance;

GRANT SELECT ON TABLE finding_line TO int_coordinator;

GRANT SELECT ON TABLE finding_line TO int_finance;

GRANT SELECT ON TABLE finding_line TO int_hr;

GRANT SELECT ON TABLE finding_line TO int_manager;

GRANT SELECT ON TABLE finding_line TO int_surveyor;

GRANT SELECT ON TABLE finding_line TO int_sysadmin;

GRANT SELECT ON TABLE finding_line TO int_viewer;

-- ===== schema: qual  (pgschema 1.14.1) =====

set local search_path = qual;

ALTER TABLE qualification DROP COLUMN action_code;

DROP INDEX IF EXISTS qualification_action_ix;

-- ===== schema: api  (pgschema 1.14.1) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION my_qualifications()
RETURNS TABLE(qualification_code text, name text, action_codes text[], valid_from timestamptz, valid_until timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select q.code,
         q.name,
         coalesce(
           array_agg(qa.action_code order by qa.action_code) filter (where qa.action_code is not null),
           '{}'::text[]
         ),
         lower(sq.valid),
         upper(sq.valid)
    from qual.staff_qualification sq
    join qual.qualification q on q.code = sq.qualification_code
    left join qual.qualification_action qa on qa.qualification_code = q.code
   where sq.user_id = private.uid()
     and sq.valid @> now()
     and sq.revoked_at is null
   group by q.code, q.name, sq.valid
   order by q.code;
$$;

CREATE OR REPLACE VIEW qualifications WITH (security_invoker=true) AS
 SELECT q.code,
    q.name,
    COALESCE(array_agg(qa.action_code ORDER BY qa.action_code) FILTER (WHERE qa.action_code IS NOT NULL), '{}'::text[]) AS action_codes,
    q.job_family,
    q.description,
    q.created_at,
    q.updated_at
   FROM qual.qualification q
     LEFT JOIN qual.qualification_action qa ON qa.qualification_code = q.code
  GROUP BY q.code, q.name, q.job_family, q.description, q.created_at, q.updated_at;

CREATE OR REPLACE VIEW ship_certificates WITH (security_invoker=true) AS
 SELECT c.id,
    c.certificate_no,
    c.version,
    c.ship_id,
    c.org_id,
    c.certificate_template_code,
    c.status,
    cs.name AS status_name,
    c.remarks,
    c.issuing_society_code,
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

CREATE OR REPLACE VIEW ship_finding_comments WITH (security_invoker=true) AS
 SELECT fc.id,
    fc.ship_id,
    fc.org_id,
    fc.finding_type,
    ft.name AS finding_type_name,
    fc.is_private,
    fc.date_issued,
    fc.place_issued,
    fc.due_date,
    fc.status,
    fs.name AS status_name,
    fc.postponed_due_date,
    fc.mms_reference,
    fc.subject,
    fc.body,
    fc.is_active,
    fc.created_at,
    fc.updated_at
   FROM fleet.finding_comment fc
     LEFT JOIN core.finding_type ft ON ft.code::text = fc.finding_type::text
     LEFT JOIN core.finding_status fs ON fs.code::text = fc.status::text;

CREATE OR REPLACE VIEW ship_survey_audits WITH (security_invoker=true) AS
 SELECT sa.id,
    sa.ship_id,
    sa.org_id,
    sa.certificate_type_code,
    sa.certificate_id,
    sa.survey_catalog_id,
    sac.code AS survey_catalog_code,
    sac.name AS survey_catalog_name,
    sac.item_kind,
    sa.description,
    sa.last_held_date,
    sa.place_held,
    sa.next_due_date,
    sa.postponement_date,
    sa.schedule_status,
    sas.name AS schedule_status_name,
    sa.range_from_date,
    sa.range_to_date,
    sa.fee,
    sa.is_ordered,
    sa.is_active,
    sa.created_at,
    sa.updated_at
   FROM fleet.survey_audit sa
     LEFT JOIN core.survey_audit_catalog sac ON sac.id = sa.survey_catalog_id
     LEFT JOIN core.survey_audit_status sas ON sas.code::text = sa.schedule_status::text;

REVOKE EXECUTE ON FUNCTION my_qualifications() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION my_qualifications() TO int_auditor;

GRANT EXECUTE ON FUNCTION my_qualifications() TO int_compliance;

GRANT EXECUTE ON FUNCTION my_qualifications() TO int_coordinator;

GRANT EXECUTE ON FUNCTION my_qualifications() TO int_finance;

GRANT EXECUTE ON FUNCTION my_qualifications() TO int_hr;

GRANT EXECUTE ON FUNCTION my_qualifications() TO int_manager;

GRANT EXECUTE ON FUNCTION my_qualifications() TO int_surveyor;

GRANT EXECUTE ON FUNCTION my_qualifications() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION my_qualifications() TO int_viewer;

GRANT SELECT ON TABLE qualifications TO int_auditor;

GRANT SELECT ON TABLE qualifications TO int_compliance;

GRANT SELECT ON TABLE qualifications TO int_coordinator;

GRANT SELECT ON TABLE qualifications TO int_finance;

GRANT SELECT ON TABLE qualifications TO int_hr;

GRANT SELECT ON TABLE qualifications TO int_manager;

GRANT SELECT ON TABLE qualifications TO int_surveyor;

GRANT SELECT ON TABLE qualifications TO int_sysadmin;

GRANT SELECT ON TABLE qualifications TO int_viewer;

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
