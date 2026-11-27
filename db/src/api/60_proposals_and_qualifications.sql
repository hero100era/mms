
-- H-13: HR review of position proposals. The proposal supplies the person and the
-- directory attributes; HR supplies (or accepts) the job title and organisation unit.
-- Confirmation goes through api.staff_position_set, so a confirmed proposal is
-- indistinguishable in the database from a position HR typed by hand.
create view api.position_proposals with (security_invoker = true) as
select p.id,
       p.user_id,
       u.display_name,
       u.email,
       p.status,
       p.job_title_code,
       t.label_en as job_title_label,
       p.unit_id,
       o.code as unit_code,
       o.name as unit_name,
       p.entra_job_title,
       p.entra_department,
       p.entra_office,
       p.source,
       p.proposed_at,
       p.decided_at,
       p.decided_by,
       p.decision_reason,
       p.staff_position_id
  from iam.position_proposal p
  join iam.app_user u on u.id = p.user_id
  left join iam.job_title t on t.code = p.job_title_code
  left join core.org_unit o on o.id = p.unit_id;

create function api.position_proposal_confirm(
  p_id uuid,
  p_job_title_code text,
  p_unit_id uuid,
  p_line_manager_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal iam.position_proposal;
  v_title text;
  v_unit uuid;
  v_position_id uuid;
begin
  if coalesce(private.active_role(), '') <> 'int_hr' then
    raise exception 'insufficient_authority' using errcode = '42501';
  end if;
  perform private.assert_not_break_glass('hr.position.set');

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

  -- R6.3: Segregation of Duties - Creator/proposer cannot confirm own proposal, nor can user confirm their own position
  if (v_proposal.proposed_by is not null and v_proposal.proposed_by = private.uid())
     or v_proposal.user_id = private.uid() then
    raise exception 'cannot_confirm_own_proposal' using errcode = '42501';
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

create function api.position_proposal_reject(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal iam.position_proposal;
begin
  if coalesce(private.active_role(), '') <> 'int_hr' then
    raise exception 'insufficient_authority' using errcode = '42501';
  end if;
  perform private.assert_not_break_glass('hr.position.set');

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

revoke all on function api.position_proposal_confirm(uuid, text, uuid, uuid, text) from public;

-- Card H-13: the page needs the two pickers next to the queue, and the HR login role has
-- no grant on iam directly, so both are exposed as read-only views here.
create view api.position_job_titles
with (security_invoker = true)
as
select t.code, t.label_en, t.label_zh, t.job_family, t.grade
  from iam.job_title t
 where t.active
 order by t.grade desc, t.code;

create view api.position_units
with (security_invoker = true)
as
select u.id, u.code, u.name, u.unit_type
  from core.org_unit u
 where u.active and upper(u.valid) is null
 order by u.code;

revoke all on function api.position_proposal_reject(uuid, text) from public;

grant execute on function api.position_proposal_confirm(uuid, text, uuid, uuid, text) to int_hr;
grant execute on function api.position_proposal_reject(uuid, text) to int_hr;
grant select on api.position_proposals to int_hr, int_sysadmin;
revoke all on api.position_job_titles from public;
grant select on api.position_job_titles to int_hr;
revoke all on api.position_units from public;
grant select on api.position_units to int_hr, int_sysadmin;

-- Card H-14: qual integration (competence and qualification APIs)
create view api.qualifications
with (security_invoker = true)
as
select
  q.code,
  q.name,
  coalesce(
    array_agg(qa.action_code order by qa.action_code) filter (where qa.action_code is not null),
    '{}'::text[]
  ) as action_codes,
  q.job_family,
  q.description,
  q.created_at,
  q.updated_at
from qual.qualification q
left join qual.qualification_action qa on qa.qualification_code = q.code
group by q.code, q.name, q.job_family, q.description, q.created_at, q.updated_at;

revoke all on api.qualifications from public;
grant select on api.qualifications to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

create function api.my_qualifications()
returns table(
  qualification_code text,
  name text,
  action_codes text[],
  valid_from timestamptz,
  valid_until timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
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

revoke all on function api.my_qualifications() from public;
grant execute on function api.my_qualifications() to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

create function api.staff_qualification_grant(
  p_user_id uuid,
  p_qualification_code text,
  p_valid_from timestamptz default now(),
  p_valid_until timestamptz default null,
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_valid_from timestamptz := coalesce(p_valid_from, now());
  v_valid tstzrange;
  v_role text := private.active_role();
begin
  perform private.assert_not_break_glass('qual.grant');

  if v_role not in ('int_hr', 'int_compliance') then
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

  perform private.set_change_context(trim(p_reason));

  v_valid := tstzrange(v_valid_from, p_valid_until);

  insert into qual.staff_qualification (
    user_id, qualification_code, valid, granted_by, grant_reason
  ) values (
    p_user_id, p_qualification_code, v_valid, private.uid(), trim(p_reason)
  ) returning id into v_id;

  perform private.emit_event(
    'qual.qualification.granted', 'success', 'staff_qualification', v_id, null, trim(p_reason),
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

revoke all on function api.staff_qualification_grant(uuid, text, timestamptz, timestamptz, text) from public;
grant execute on function api.staff_qualification_grant(uuid, text, timestamptz, timestamptz, text) to
  int_hr, int_compliance;

create function api.staff_qualification_revoke(
  p_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sq record;
  v_role text := private.active_role();
begin
  perform private.assert_not_break_glass('qual.revoke');

  if v_role not in ('int_hr', 'int_compliance') then
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

  perform private.set_change_context(trim(p_reason));

  update qual.staff_qualification
     set revoked_at = now(),
         revoked_by = private.uid(),
         revoke_reason = trim(p_reason),
         valid = case
           when lower(valid) > now() then 'empty'::tstzrange
           else tstzrange(lower(valid), now(), '[)')
         end
   where id = p_id;

  perform private.emit_event(
    'qual.qualification.revoked', 'success', 'staff_qualification', p_id, null, trim(p_reason),
    jsonb_build_object(
      'user_id', v_sq.user_id,
      'qualification_code', v_sq.qualification_code,
      'revoked_at', now()
    )
  );
end;
$$;

revoke all on function api.staff_qualification_revoke(uuid, text) from public;
grant execute on function api.staff_qualification_revoke(uuid, text) to
  int_hr, int_compliance;

-- R6.2: Authority decision explanation for diagnostic and support tooling
create function api.explain_authority(
  p_action_code text,
  p_amount numeric default null,
  p_unit_id uuid default null,
  p_record_id uuid default null
)
returns table(
  allowed boolean,
  reason_code text,
  action_code text,
  rule_id uuid,
  details jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := private.active_role();
begin
  if v_role not in (
    'int_compliance', 'int_manager', 'int_sysadmin', 'int_hr',
    'int_coordinator', 'int_surveyor', 'int_auditor', 'int_finance'
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query select * from private.explain_authority(p_action_code, p_amount, p_unit_id, p_record_id);
end;
$$;

revoke all on function api.explain_authority(text, numeric, uuid, uuid) from public;
grant execute on function api.explain_authority(text, numeric, uuid, uuid) to
  int_compliance, int_manager, int_sysadmin, int_hr, int_coordinator, int_surveyor, int_auditor, int_finance;


