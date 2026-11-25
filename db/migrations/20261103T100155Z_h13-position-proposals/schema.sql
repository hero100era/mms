-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION position_proposal_record(
    p_user_id uuid,
    p_entra_job_title text,
    p_entra_department text,
    p_entra_office text,
    p_payload jsonb DEFAULT '{}'
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user iam.app_user;
  v_title text;
  v_unit uuid;
  v_id uuid;
begin
  if not (private.is_worker() or private.active_role() = 'int_sysadmin' or private.active_role() = 'int_hr') then
    raise exception 'worker_or_admin_role_required' using errcode = '42501';
  end if;

  select * into v_user from iam.app_user
   where id = p_user_id and kind = 'internal' and status = 'active';
  if not found then
    raise exception 'internal_user_not_found';
  end if;

  select t.code into v_title from iam.job_title t
   where t.active and lower(t.code) = lower(btrim(coalesce(p_entra_job_title, '')));
  select u.id into v_unit from core.org_unit u
   where u.active and lower(u.code) = lower(btrim(coalesce(p_entra_office, ''))) limit 1;

  insert into iam.position_proposal (
    user_id, job_title_code, unit_id, entra_job_title, entra_department, entra_office,
    source, source_payload
  )
  values (
    v_user.id, v_title, v_unit,
    nullif(btrim(p_entra_job_title), ''),
    nullif(btrim(p_entra_department), ''),
    nullif(btrim(p_entra_office), ''),
    'entra', coalesce(p_payload, '{}'::jsonb)
  )
  on conflict (user_id) where status = 'pending'
  do update set job_title_code = excluded.job_title_code,
                unit_id = excluded.unit_id,
                entra_job_title = excluded.entra_job_title,
                entra_department = excluded.entra_department,
                entra_office = excluded.entra_office,
                source_payload = excluded.source_payload,
                proposed_at = now()
  returning id into v_id;

  perform private.emit_event(
    'iam.position.proposed', 'success', 'staff_user', v_user.id, v_unit,
    'position proposed from directory attributes',
    jsonb_build_object('proposal_id', v_id, 'job_title_guess', v_title, 'unit_guess', v_unit)
  );
  return v_id;
end;
$$;

REVOKE EXECUTE ON FUNCTION position_proposal_record(p_user_id uuid, p_entra_job_title text, p_entra_department text, p_entra_office text, p_payload jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION position_proposal_record(p_user_id uuid, p_entra_job_title text, p_entra_department text, p_entra_office text, p_payload jsonb) TO int_hr;

GRANT EXECUTE ON FUNCTION position_proposal_record(p_user_id uuid, p_entra_job_title text, p_entra_department text, p_entra_office text, p_payload jsonb) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION position_proposal_record(p_user_id uuid, p_entra_job_title text, p_entra_department text, p_entra_office text, p_payload jsonb) TO worker;

-- ===== schema: iam  (pgschema 1.13.4) =====

set local search_path = iam;

CREATE TABLE IF NOT EXISTS position_proposal (
    id uuid DEFAULT uuidv7(),
    user_id uuid NOT NULL,
    user_kind text DEFAULT 'internal' NOT NULL,
    job_title_code text,
    unit_id uuid,
    entra_job_title text,
    entra_department text,
    entra_office text,
    source text DEFAULT 'entra' NOT NULL,
    source_payload jsonb DEFAULT '{}' NOT NULL,
    status text DEFAULT 'pending' NOT NULL,
    proposed_at timestamptz DEFAULT now() NOT NULL,
    decided_at timestamptz,
    decided_by uuid,
    decision_reason text,
    staff_position_id uuid,
    CONSTRAINT position_proposal_pkey PRIMARY KEY (id),
    CONSTRAINT position_proposal_decision_ck CHECK ((status = 'pending'::text) = (decided_at IS NULL) AND (status <> 'rejected'::text OR staff_position_id IS NULL)),
    CONSTRAINT position_proposal_source_ck CHECK (source IN ('entra'::text, 'hr'::text)),
    CONSTRAINT position_proposal_status_ck CHECK (status IN ('pending'::text, 'confirmed'::text, 'rejected'::text)),
    CONSTRAINT position_proposal_user_kind_ck CHECK (user_kind = 'internal'::text)
);

CREATE UNIQUE INDEX IF NOT EXISTS position_proposal_pending_ix ON position_proposal (user_id) WHERE (status = 'pending'::text);

CREATE INDEX IF NOT EXISTS position_proposal_status_ix ON position_proposal (status, proposed_at);

ALTER TABLE position_proposal ENABLE ROW LEVEL SECURITY;

CREATE POLICY position_proposal_hr_read ON position_proposal FOR SELECT TO int_hr, int_sysadmin USING (true);

ALTER TABLE position_proposal
ADD CONSTRAINT position_proposal_decided_by_fk FOREIGN KEY (decided_by) REFERENCES app_user (id);

ALTER TABLE position_proposal
ADD CONSTRAINT position_proposal_position_fk FOREIGN KEY (staff_position_id) REFERENCES staff_position (id);

ALTER TABLE position_proposal
ADD CONSTRAINT position_proposal_title_fk FOREIGN KEY (job_title_code) REFERENCES job_title (code);

ALTER TABLE position_proposal
ADD CONSTRAINT position_proposal_unit_fk FOREIGN KEY (unit_id) REFERENCES core.org_unit (id);

ALTER TABLE position_proposal
ADD CONSTRAINT position_proposal_user_fk FOREIGN KEY (user_id, user_kind) REFERENCES app_user (id, kind);

CREATE OR REPLACE TRIGGER position_proposal_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON position_proposal
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

GRANT SELECT ON TABLE position_proposal TO int_hr;

GRANT SELECT ON TABLE position_proposal TO int_sysadmin;

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION position_proposal_confirm(
    p_id uuid,
    p_job_title_code text,
    p_unit_id uuid,
    p_line_manager_id uuid,
    p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_proposal iam.position_proposal;
  v_title text;
  v_unit uuid;
  v_position_id uuid;
begin
  if coalesce(private.active_role(), '') not in ('int_hr', 'int_sysadmin') then
    raise exception 'insufficient_authority' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_proposal from iam.position_proposal where id = p_id for update;
  if not found then
    raise exception 'position_proposal_not_found';
  end if;
  if v_proposal.status <> 'pending' then
    raise exception 'position_proposal_already_decided' using errcode = '22023';
  end if;

  v_title := coalesce(nullif(btrim(p_job_title_code), ''), v_proposal.job_title_code);
  v_unit := coalesce(p_unit_id, v_proposal.unit_id);
  if v_title is null or v_unit is null then
    raise exception 'position_proposal_incomplete' using errcode = '22023';
  end if;

  perform private.set_change_context(p_reason);
  v_position_id := api.staff_position_set(
    v_proposal.user_id, v_title, v_unit, null, p_line_manager_id, now(), p_reason
  );

  update iam.position_proposal
     set status = 'confirmed',
         decided_at = now(),
         decided_by = private.uid(),
         decision_reason = p_reason,
         staff_position_id = v_position_id,
         job_title_code = v_title,
         unit_id = v_unit
   where id = p_id;

  perform private.emit_event(
    'iam.position.proposal_confirmed', 'success', 'staff_user', v_proposal.user_id, v_unit,
    p_reason, jsonb_build_object('proposal_id', p_id, 'position_id', v_position_id)
  );
  return v_position_id;
end;
$$;

CREATE OR REPLACE FUNCTION position_proposal_reject(
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
  v_proposal iam.position_proposal;
begin
  if coalesce(private.active_role(), '') not in ('int_hr', 'int_sysadmin') then
    raise exception 'insufficient_authority' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_proposal from iam.position_proposal where id = p_id for update;
  if not found then
    raise exception 'position_proposal_not_found';
  end if;
  if v_proposal.status <> 'pending' then
    raise exception 'position_proposal_already_decided' using errcode = '22023';
  end if;

  perform private.set_change_context(p_reason);
  update iam.position_proposal
     set status = 'rejected',
         decided_at = now(),
         decided_by = private.uid(),
         decision_reason = p_reason
   where id = p_id;

  perform private.emit_event(
    'iam.position.proposal_rejected', 'success', 'staff_user', v_proposal.user_id, v_proposal.unit_id,
    p_reason, jsonb_build_object('proposal_id', p_id)
  );
end;
$$;

CREATE OR REPLACE VIEW position_proposals WITH (security_invoker=true) AS
 SELECT p.id,
    p.user_id,
    u.display_name,
    u.email,
    p.status,
    p.job_title_code,
    t.label_en AS job_title_label,
    p.unit_id,
    o.code AS unit_code,
    o.name AS unit_name,
    p.entra_job_title,
    p.entra_department,
    p.entra_office,
    p.source,
    p.proposed_at,
    p.decided_at,
    p.decided_by,
    p.decision_reason,
    p.staff_position_id
   FROM iam.position_proposal p
     JOIN iam.app_user u ON u.id = p.user_id
     LEFT JOIN iam.job_title t ON t.code = p.job_title_code
     LEFT JOIN core.org_unit o ON o.id = p.unit_id;

REVOKE EXECUTE ON FUNCTION position_proposal_confirm(p_id uuid, p_job_title_code text, p_unit_id uuid, p_line_manager_id uuid, p_reason text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION position_proposal_reject(p_id uuid, p_reason text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION position_proposal_confirm(p_id uuid, p_job_title_code text, p_unit_id uuid, p_line_manager_id uuid, p_reason text) TO int_hr;

GRANT EXECUTE ON FUNCTION position_proposal_confirm(p_id uuid, p_job_title_code text, p_unit_id uuid, p_line_manager_id uuid, p_reason text) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION position_proposal_reject(p_id uuid, p_reason text) TO int_hr;

GRANT EXECUTE ON FUNCTION position_proposal_reject(p_id uuid, p_reason text) TO int_sysadmin;

GRANT SELECT ON TABLE position_proposals TO int_hr;

GRANT SELECT ON TABLE position_proposals TO int_sysadmin;
