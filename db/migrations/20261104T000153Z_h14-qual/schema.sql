-- ===== schema: private  (pgschema 1.13.4) =====

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
        join qual.qualification q on q.code = sq.qualification_code
        left join qual.qualification_action qa on qa.qualification_code = q.code
       where sq.user_id = private.uid()
         and sq.valid @> now()
         and sq.revoked_at is null
         and (
           sq.qualification_code = p_action_code
           or q.action_code = p_action_code
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

-- ===== schema: qual  (pgschema 1.13.4) =====

set local search_path = qual;

CREATE TABLE IF NOT EXISTS qualification (
    code text,
    name text NOT NULL,
    action_code text,
    job_family text,
    description text,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    row_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT qualification_pk PRIMARY KEY (code)
);

CREATE INDEX IF NOT EXISTS qualification_action_ix ON qualification (action_code);

CREATE INDEX IF NOT EXISTS qualification_family_ix ON qualification (job_family);

ALTER TABLE qualification ENABLE ROW LEVEL SECURITY;

CREATE POLICY qualification_read ON qualification FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

CREATE TABLE IF NOT EXISTS qualification_action (
    qualification_code text,
    action_code text,
    CONSTRAINT qualification_action_pk PRIMARY KEY (qualification_code, action_code),
    CONSTRAINT qualification_action_code_fk FOREIGN KEY (qualification_code) REFERENCES qualification (code) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS qualification_action_action_ix ON qualification_action (action_code);

ALTER TABLE qualification_action ENABLE ROW LEVEL SECURITY;

CREATE POLICY qualification_action_read ON qualification_action FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

CREATE TABLE IF NOT EXISTS staff_qualification (
    id uuid DEFAULT uuidv7(),
    user_id uuid NOT NULL,
    qualification_code text NOT NULL,
    valid tstzrange DEFAULT tstzrange(now(), NULL) NOT NULL,
    granted_by uuid NOT NULL,
    grant_reason text NOT NULL,
    revoked_at timestamptz,
    revoked_by uuid,
    revoke_reason text,
    created_at timestamptz DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamptz DEFAULT now() NOT NULL,
    updated_by uuid,
    row_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT staff_qualification_pk PRIMARY KEY (id),
    CONSTRAINT staff_qualification_code_fk FOREIGN KEY (qualification_code) REFERENCES qualification (code),
    CONSTRAINT staff_qualification_grant_reason_ck CHECK (length(TRIM(BOTH FROM grant_reason)) >= 3),
    CONSTRAINT staff_qualification_granted_by_ck CHECK (granted_by <> user_id),
    CONSTRAINT staff_qualification_revocation_ck CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL)),
    CONSTRAINT staff_qualification_ex EXCLUDE USING gist (user_id WITH =, qualification_code WITH =, valid WITH &&)
);

CREATE INDEX IF NOT EXISTS staff_qualification_code_ix ON staff_qualification (qualification_code);

CREATE INDEX IF NOT EXISTS staff_qualification_user_ix ON staff_qualification (user_id);

ALTER TABLE staff_qualification ENABLE ROW LEVEL SECURITY;

CREATE POLICY staff_qualification_admin_read ON staff_qualification FOR SELECT TO int_compliance, int_hr, int_sysadmin USING (true);

CREATE POLICY staff_qualification_report_read ON staff_qualification FOR SELECT TO int_manager USING (user_id IN ( SELECT private.my_reports() AS my_reports));

CREATE POLICY staff_qualification_self_read ON staff_qualification FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (user_id = private.uid());

ALTER TABLE qualification
ADD CONSTRAINT qualification_created_by_fk FOREIGN KEY (created_by) REFERENCES iam.app_user (id);

ALTER TABLE qualification
ADD CONSTRAINT qualification_job_family_fk FOREIGN KEY (job_family) REFERENCES iam.job_family (code);

ALTER TABLE qualification
ADD CONSTRAINT qualification_updated_by_fk FOREIGN KEY (updated_by) REFERENCES iam.app_user (id);

ALTER TABLE staff_qualification
ADD CONSTRAINT staff_qualification_granted_by_fk FOREIGN KEY (granted_by) REFERENCES iam.app_user (id);

ALTER TABLE staff_qualification
ADD CONSTRAINT staff_qualification_revoked_by_fk FOREIGN KEY (revoked_by) REFERENCES iam.app_user (id);

ALTER TABLE staff_qualification
ADD CONSTRAINT staff_qualification_user_fk FOREIGN KEY (user_id) REFERENCES iam.app_user (id);

CREATE OR REPLACE TRIGGER qualification_stamp
    BEFORE INSERT OR UPDATE ON qualification
    FOR EACH ROW
    EXECUTE FUNCTION private.stamp();

CREATE OR REPLACE TRIGGER staff_qualification_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON staff_qualification
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER staff_qualification_stamp
    BEFORE INSERT OR UPDATE ON staff_qualification
    FOR EACH ROW
    EXECUTE FUNCTION private.stamp();

GRANT SELECT ON TABLE qualification TO int_auditor;

GRANT SELECT ON TABLE qualification TO int_compliance;

GRANT SELECT ON TABLE qualification TO int_coordinator;

GRANT SELECT ON TABLE qualification TO int_finance;

GRANT SELECT ON TABLE qualification TO int_hr;

GRANT SELECT ON TABLE qualification TO int_manager;

GRANT SELECT ON TABLE qualification TO int_surveyor;

GRANT SELECT ON TABLE qualification TO int_sysadmin;

GRANT SELECT ON TABLE qualification TO int_viewer;

GRANT SELECT ON TABLE qualification_action TO int_auditor;

GRANT SELECT ON TABLE qualification_action TO int_compliance;

GRANT SELECT ON TABLE qualification_action TO int_coordinator;

GRANT SELECT ON TABLE qualification_action TO int_finance;

GRANT SELECT ON TABLE qualification_action TO int_hr;

GRANT SELECT ON TABLE qualification_action TO int_manager;

GRANT SELECT ON TABLE qualification_action TO int_surveyor;

GRANT SELECT ON TABLE qualification_action TO int_sysadmin;

GRANT SELECT ON TABLE qualification_action TO int_viewer;

GRANT SELECT ON TABLE staff_qualification TO int_auditor;

GRANT SELECT ON TABLE staff_qualification TO int_compliance;

GRANT SELECT ON TABLE staff_qualification TO int_coordinator;

GRANT SELECT ON TABLE staff_qualification TO int_finance;

GRANT SELECT ON TABLE staff_qualification TO int_hr;

GRANT SELECT ON TABLE staff_qualification TO int_manager;

GRANT SELECT ON TABLE staff_qualification TO int_surveyor;

GRANT SELECT ON TABLE staff_qualification TO int_sysadmin;

GRANT SELECT ON TABLE staff_qualification TO int_viewer;

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION my_qualifications()
RETURNS TABLE(qualification_code text, name text, action_code text, valid_from timestamptz, valid_until timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select q.code, q.name, q.action_code, lower(sq.valid), upper(sq.valid)
    from qual.staff_qualification sq
    join qual.qualification q on q.code = sq.qualification_code
   where sq.user_id = private.uid()
     and sq.valid @> now()
     and sq.revoked_at is null
   order by q.code;
$$;

CREATE OR REPLACE FUNCTION staff_qualification_grant(
    p_user_id uuid,
    p_qualification_code text,
    p_valid_from timestamptz DEFAULT now(),
    p_valid_until timestamptz DEFAULT NULL,
    p_reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_id uuid;
  v_valid_from timestamptz := coalesce(p_valid_from, now());
  v_valid tstzrange;
  v_role text := private.active_role();
begin
  if v_role not in ('int_hr', 'int_sysadmin', 'int_compliance') then
    raise exception 'insufficient_authority' using errcode = '42501';
  end if;

  if p_user_id = private.uid() then
    raise exception 'cannot_grant_self' using errcode = '42501';
  end if;

  if not exists (select 1 from iam.app_user where id = p_user_id and status <> 'deactivated') then
    raise exception 'user_not_found' using errcode = '22023';
  end if;

  if not exists (select 1 from qual.qualification where code = p_qualification_code) then
    raise exception 'qualification_not_found' using errcode = '22023';
  end if;

  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  if p_valid_until is not null and p_valid_until <= v_valid_from then
    raise exception 'invalid_valid_range' using errcode = '22023';
  end if;

  v_valid := tstzrange(v_valid_from, p_valid_until);

  insert into qual.staff_qualification (
    user_id, qualification_code, valid, granted_by, grant_reason
  ) values (
    p_user_id, p_qualification_code, v_valid, private.uid(), trim(p_reason)
  ) returning id into v_id;

  perform private.emit_event(
    'qual.qualification.granted', 'granted', 'staff_qualification', v_id, null, trim(p_reason),
    jsonb_build_object(
      'user_id', p_user_id,
      'qualification_code', p_qualification_code,
      'valid_from', v_valid_from,
      'valid_until', p_valid_until
    )
  );

  return v_id;
end;
$$;

CREATE OR REPLACE FUNCTION staff_qualification_revoke(
    p_id uuid,
    p_reason text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_sq record;
  v_role text := private.active_role();
begin
  if v_role not in ('int_hr', 'int_sysadmin', 'int_compliance') then
    raise exception 'insufficient_authority' using errcode = '42501';
  end if;

  select * into v_sq
    from qual.staff_qualification
   where id = p_id
     for update;

  if not found then
    raise exception 'qualification_not_found' using errcode = '22023';
  end if;

  if v_sq.revoked_at is not null then
    raise exception 'already_revoked' using errcode = '22023';
  end if;

  if v_sq.user_id = private.uid() then
    raise exception 'cannot_revoke_self' using errcode = '42501';
  end if;

  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  update qual.staff_qualification
     set revoked_at = now(),
         revoked_by = private.uid(),
         revoke_reason = trim(p_reason),
         valid = tstzrange(lower(valid), now())
   where id = p_id;

  perform private.emit_event(
    'qual.qualification.revoked', 'revoked', 'staff_qualification', p_id, null, trim(p_reason),
    jsonb_build_object(
      'user_id', v_sq.user_id,
      'qualification_code', v_sq.qualification_code,
      'revoked_at', now()
    )
  );
end;
$$;

CREATE OR REPLACE VIEW qualifications WITH (security_invoker=true) AS
 SELECT code,
    name,
    action_code,
    job_family,
    description,
    created_at,
    updated_at
   FROM qual.qualification q;

REVOKE EXECUTE ON FUNCTION my_qualifications() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION staff_qualification_grant(p_user_id uuid, p_qualification_code text, p_valid_from timestamp with time zone, p_valid_until timestamp with time zone, p_reason text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION staff_qualification_revoke(p_id uuid, p_reason text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION my_qualifications() TO int_auditor;

GRANT EXECUTE ON FUNCTION my_qualifications() TO int_compliance;

GRANT EXECUTE ON FUNCTION my_qualifications() TO int_coordinator;

GRANT EXECUTE ON FUNCTION my_qualifications() TO int_finance;

GRANT EXECUTE ON FUNCTION my_qualifications() TO int_hr;

GRANT EXECUTE ON FUNCTION my_qualifications() TO int_manager;

GRANT EXECUTE ON FUNCTION my_qualifications() TO int_surveyor;

GRANT EXECUTE ON FUNCTION my_qualifications() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION my_qualifications() TO int_viewer;

GRANT EXECUTE ON FUNCTION staff_qualification_grant(p_user_id uuid, p_qualification_code text, p_valid_from timestamp with time zone, p_valid_until timestamp with time zone, p_reason text) TO int_compliance;

GRANT EXECUTE ON FUNCTION staff_qualification_grant(p_user_id uuid, p_qualification_code text, p_valid_from timestamp with time zone, p_valid_until timestamp with time zone, p_reason text) TO int_hr;

GRANT EXECUTE ON FUNCTION staff_qualification_grant(p_user_id uuid, p_qualification_code text, p_valid_from timestamp with time zone, p_valid_until timestamp with time zone, p_reason text) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION staff_qualification_revoke(p_id uuid, p_reason text) TO int_compliance;

GRANT EXECUTE ON FUNCTION staff_qualification_revoke(p_id uuid, p_reason text) TO int_hr;

GRANT EXECUTE ON FUNCTION staff_qualification_revoke(p_id uuid, p_reason text) TO int_sysadmin;

GRANT SELECT ON TABLE qualifications TO int_auditor;

GRANT SELECT ON TABLE qualifications TO int_compliance;

GRANT SELECT ON TABLE qualifications TO int_coordinator;

GRANT SELECT ON TABLE qualifications TO int_finance;

GRANT SELECT ON TABLE qualifications TO int_hr;

GRANT SELECT ON TABLE qualifications TO int_manager;

GRANT SELECT ON TABLE qualifications TO int_surveyor;

GRANT SELECT ON TABLE qualifications TO int_sysadmin;

GRANT SELECT ON TABLE qualifications TO int_viewer;
