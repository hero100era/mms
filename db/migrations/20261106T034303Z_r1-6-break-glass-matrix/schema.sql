-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION assert_not_break_glass(
    p_action_code text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if private.audit_source() = 'break_glass'
     and exists (
       select 1 from iam.break_glass_forbidden_action f
        where f.action_code = p_action_code
     ) then
    perform private.emit_event(
      'authz.denied.break_glass_forbidden', 'denied', 'authority_rule', null, null, null,
      jsonb_build_object('action', p_action_code, 'role', private.active_role()));
    raise exception 'break_glass_forbidden_operation' using errcode = '42501';
  end if;
end;
$$;

REVOKE EXECUTE ON FUNCTION assert_not_break_glass(p_action_code text) FROM PUBLIC;

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

-- ===== schema: iam  (pgschema 1.13.4) =====

set local search_path = iam;

CREATE TABLE IF NOT EXISTS break_glass_forbidden_action (
    action_code text,
    description text NOT NULL,
    CONSTRAINT break_glass_forbidden_action_pkey PRIMARY KEY (action_code),
    CONSTRAINT break_glass_forbidden_action_code_ck CHECK (btrim(action_code) <> ''::text),
    CONSTRAINT break_glass_forbidden_action_description_ck CHECK (btrim(description) <> ''::text)
);

ALTER TABLE break_glass_forbidden_action ENABLE ROW LEVEL SECURITY;

-- ===== schema: auth  (pgschema 1.13.4) =====

set local search_path = auth;

CREATE OR REPLACE FUNCTION break_glass_drill_record(
    p_user_id uuid,
    p_operator text,
    p_outcome text,
    p_evidence jsonb DEFAULT '{}'
)
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_at timestamptz := clock_timestamp();
  v_label text;
begin
  if p_operator is null or btrim(p_operator) = '' then
    raise exception 'operator_required' using errcode = '22023';
  end if;
  if p_outcome not in ('passed', 'failed') then
    raise exception 'invalid_drill_outcome' using errcode = '22023';
  end if;

  update iam.break_glass_account
     set last_drill_at = v_at
   where user_id = p_user_id
     and enabled
  returning label into v_label;

  if not found then
    raise exception 'break_glass_account_not_found' using errcode = '22023';
  end if;

  perform private.emit_event(
    'auth.breakglass.drill_recorded', 'success', 'break_glass_account', p_user_id, null, null,
    jsonb_build_object(
      'operator', btrim(p_operator),
      'outcome', p_outcome,
      'label', v_label,
      'performed_at', v_at,
      'evidence', coalesce(p_evidence, '{}'::jsonb)
    )
  );

  return v_at;
end;
$$;

REVOKE EXECUTE ON FUNCTION break_glass_drill_record(p_user_id uuid, p_operator text, p_outcome text, p_evidence jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION break_glass_drill_record(p_user_id uuid, p_operator text, p_outcome text, p_evidence jsonb) TO auth_gateway;
