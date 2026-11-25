create function private.uid()
returns uuid
language sql
stable
as $$
  select nullif(private.claim('sub'), '')::uuid;
$$;

-- The role that called the current function, recovered despite SECURITY DEFINER.
--
-- Naive guards such as `if session_user <> worker then raise ...` do nothing:
-- both `session_user` and `current_user` are rewritten to the definer for the
-- duration of a SECURITY DEFINER call, so the comparison inspects mms_owner.
-- See ADR-0017 for the incident that motivated this helper and the lint rule in
-- db/scripts/lint-schema.ts that now forbids those comparisons outright.
create function private.caller_role()
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_role text := nullif(current_setting('role', true), '');
  v_current text := current_user::text;
begin
  -- Inside a SECURITY DEFINER function PostgreSQL switches the execution
  -- context to the definer, so `current_user` alone only ever names mms_owner.
  -- The caller survives in two other places, and each covers a different path:
  --   * the `role` GUC is set by SET ROLE / SET LOCAL ROLE, which is how
  --     PostgREST switches from authenticator to a capability role;
  --   * `session_user` still names the original login role when the connection
  --     itself was opened with SET SESSION AUTHORIZATION (the outbox worker),
  --     because the definer switch only replaces the current user.
  -- Order matters: the GUC wins because an in-function role switch is the more
  -- specific statement of intent. `current_user` is the last resort for the owner.
  if v_role is not null and v_role <> 'none' then
    return v_role;
  end if;
  if session_user::text <> v_current then
    return session_user::text;
  end if;
  return v_current;
end;
$$;

-- True when the caller is the `worker` login process (outbox poller, Entra sync,
-- malware scanner). A PostgREST request can never satisfy this: PostgREST always
-- authenticates as `authenticator` and then switches to a capability role, so the
-- `role` GUC reads `authenticator` or the capability role, never `worker`. A
-- `worker`-role JWT is refused independently by private.pre_request().
create function private.is_worker()
returns boolean
language sql
stable
as $$
  select private.caller_role() = 'worker';
$$;

-- True only for the break-glass runbook login. It is a NOLOGIN role with no
-- capability-role membership (ADR-0020), so a PostgREST request can never
-- satisfy this even if a JWT claims the name. Keep the role literal in this one
-- reviewed location instead of repeating it in every runbook function (R1.1).
create function private.is_emergency()
returns boolean
language sql
stable
as $$
  select private.caller_role() = 'mms_emergency';
$$;

revoke all on function private.caller_role() from public;
revoke all on function private.is_worker() from public;
revoke all on function private.is_emergency() from public;

grant execute on function private.caller_role() to web_anon, worker, ext_user,
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;
grant execute on function private.is_worker() to web_anon, worker, ext_user,
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;
grant execute on function private.is_emergency() to mms_emergency, int_sysadmin;

-- Privileged maintenance RPCs are restricted to the worker login or an
-- explicitly authorised sysadmin. `private.active_role()` reads a JWT claim and
-- is NULL for a direct call made without claims; `not (x or NULL)` is NULL, so a
-- guard written inline SKIPS its deny branch and fails open. Keeping the null
-- handling in this one reviewed helper closes that path for every caller (R1.1).
-- The worker login is not a capability role and holds no EXECUTE on
-- claims()/active_role(), so the second branch must not run for it. PL/pgSQL
-- evaluates it lazily; the exception handler also denies a caller that cannot
-- execute active_role() at all (it is, by definition, not the sysadmin role).
create function private.is_worker_or_admin()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.is_worker() then
    return true;
  end if;
  return coalesce(private.active_role(), '') = 'int_sysadmin';
exception
  when insufficient_privilege then
    return false;
end;
$$;

revoke all on function private.is_worker_or_admin() from public;
grant execute on function private.is_worker_or_admin() to worker, int_hr, int_sysadmin;

create function private.active_role()
returns text
language sql
stable
as $$
  select private.claim('role');
$$;
grant execute on function private.active_role() to worker;

create function private.stamp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := coalesce(new.created_at, now());
    new.created_by := coalesce(new.created_by, private.uid());
    new.updated_at := now();
    new.updated_by := coalesce(new.updated_by, private.uid());
    new.row_version := 1;
  elsif tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.updated_at := now();
    new.updated_by := coalesce(private.uid(), old.updated_by);
    new.row_version := old.row_version + 1;
  end if;
  return new;
end;
$$;

create function private.my_scope()
returns table(is_global boolean, unit_ids uuid[])
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(bool_or(a.scope_type = 'global'), false),
         coalesce(array_agg(a.scope_unit_id) filter (where a.scope_type = 'unit'), '{}')
  from iam.role_assignment a
  where a.user_id = private.uid()
    and a.db_role = private.active_role()
    and a.revoked_at is null
    and a.valid @> now();
$$;

create function private.my_units()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select case when s.is_global then
           (select coalesce(array_agg(u.id), '{}') from core.org_unit u where u.active)
         else
           (select coalesce(array_agg(distinct d.id), '{}') from core.org_unit_descendants(s.unit_ids) d)
         end
  from private.my_scope() s;
$$;

create function private.my_offices()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  with s as (select * from private.my_scope()),
  roots as (
    select unnest(s.unit_ids) as id from s
    union
    select c.covered_unit_id
      from s
      join core.org_unit_coverage c on c.unit_id = any (s.unit_ids)
     where c.valid @> now()
  )
  select case when (select is_global from s) then
           (select coalesce(array_agg(id), '{}') from core.org_unit where unit_type = 'station' and active)
         else
           (select coalesce(array_agg(distinct d.id), '{}')
              from core.org_unit_descendants(array(select id from roots)) d
              join core.org_unit u on u.id = d.id
             where u.unit_type = 'station')
         end;
$$;

create function private.my_org_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.org_id), '{}')
  from iam.org_membership m
  where m.user_id = private.uid()
    and m.revoked_at is null
    and m.valid @> now();
$$;

create function private.my_position()
returns table(job_title_code text, job_family text, grade int, unit_id uuid, unit_type text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.job_title_code, p.job_family, t.grade, p.unit_id, u.unit_type
  from iam.staff_position p
  join iam.job_title t on t.code = p.job_title_code
  join core.org_unit u on u.id = p.unit_id
  where p.user_id = private.uid()
    and p.valid @> now();
$$;

create function private.my_reports()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  with recursive r(user_id) as (
    select p.user_id
      from iam.staff_position p
     where p.line_manager_id = private.uid()
       and p.valid @> now()
    union
    select p.user_id
      from iam.staff_position p
      join r on p.line_manager_id = r.user_id
     where p.valid @> now()
  )
  select user_id from r;
$$;

revoke all on function private.uid() from public;
revoke all on function private.active_role() from public;
revoke all on function private.stamp() from public;
revoke all on function private.my_scope() from public;
revoke all on function private.my_units() from public;
revoke all on function private.my_offices() from public;
revoke all on function private.my_org_ids() from public;
revoke all on function private.my_position() from public;
revoke all on function private.my_reports() from public;
revoke all on function private.claims() from public;
revoke all on function private.claim(text) from public;

grant execute on function private.claims() to
  web_anon, ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
  int_manager, int_compliance, int_hr, int_finance, int_sysadmin;
grant execute on function private.claim(text) to
  web_anon, ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
  int_manager, int_compliance, int_hr, int_finance, int_sysadmin;
grant execute on function private.uid() to
  web_anon, ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
  int_manager, int_compliance, int_hr, int_finance, int_sysadmin;
grant execute on function private.active_role() to
  web_anon, ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
  int_manager, int_compliance, int_hr, int_finance, int_sysadmin;
grant execute on function private.my_scope() to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
  int_manager, int_compliance, int_hr, int_finance, int_sysadmin;
grant execute on function private.my_units() to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
  int_manager, int_compliance, int_hr, int_finance, int_sysadmin;
grant execute on function private.my_offices() to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
  int_manager, int_compliance, int_hr, int_finance, int_sysadmin;
grant execute on function private.my_org_ids() to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator,
  int_manager, int_compliance, int_hr, int_finance, int_sysadmin;
grant execute on function private.my_position() to
  int_viewer, int_surveyor, int_auditor, int_coordinator,
  int_manager, int_compliance, int_hr, int_finance, int_sysadmin;
grant execute on function private.my_reports() to
  int_manager, int_compliance, int_hr, int_sysadmin;

create function private.app_user_revoke_sessions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('suspended', 'deactivated')
     and new.status is distinct from old.status then
    update iam.session
       set revoked_at = now(),
           revoke_reason = 'user_' || new.status
     where user_id = new.id
       and revoked_at is null;
  end if;
  return new;
end;
$$;

create function private.role_assignment_sod()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.revoked_at is null then
    if new.db_role = 'int_sysadmin' then
      if exists (
        select 1 from iam.role_assignment a
         where a.user_id = new.user_id
           and a.id is distinct from new.id
           and a.revoked_at is null
           and a.db_role <> 'int_sysadmin'
      ) then
        raise exception 'int_sysadmin_cannot_combine_with_business_role' using errcode = '23514';
      end if;
    elsif exists (
      select 1 from iam.role_assignment a
       where a.user_id = new.user_id
         and a.id is distinct from new.id
         and a.revoked_at is null
         and a.db_role = 'int_sysadmin'
    ) then
      raise exception 'int_sysadmin_cannot_combine_with_business_role' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.app_user_revoke_sessions() from public;
revoke all on function private.role_assignment_sod() from public;

-- PostgREST pre-request gate (I-03). The JWT signature/audience/expiry are
-- verified by PostgREST; this function re-validates the session and assignment
-- on every request so revocation and expiry are immediate.
create function private.pre_request()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c jsonb := private.claims();
  r text := c ->> 'role';
  k text;
  v_bg bigint := nullif(c ->> 'bg', '')::bigint;
begin
  select kind into k from iam.db_role where role_name = r;
  if k is null then
    raise exception using errcode = 'PT403', message = 'role_not_allowed';
  end if;
  if k = 'anon' then
    if c ? 'sub' then
      raise exception using errcode = 'PT401', message = 'anon_with_subject';
    end if;
    return;
  end if;
  -- Only the capability roles the plan exposes through PostgREST may pass this
  -- gate. The owner, migrator, sealer, worker and other login roles can hold a
  -- valid session too, but they must never reach the PostgREST execution path.
  if k not in ('internal', 'external') then
    raise exception using errcode = 'PT403', message = 'role_not_allowed';
  end if;
  -- H-10 / R8.5: Synchronous denial. A break-glass session must satisfy at request time:
  -- session active AND break-glass activation active AND current timestamp < activation expiry.
  -- Even if physical session revocation has not yet run asynchronously, this gate immediately
  -- denies the request the exact moment the activation window closes.
  if v_bg is not null and v_bg <= extract(epoch from now())::bigint then
    raise exception using errcode = 'PT401', message = 'break_glass_expired';
  end if;
  if exists (
    select 1 from iam.break_glass_account b
     where b.user_id = (c ->> 'sub')::uuid
       and (
         (b.valid_until is not null and now() >= b.valid_until)
         or (c ->> 'src' = 'break_glass' and (b.valid_until is null or now() >= b.valid_until))
       )
  ) then
    raise exception using errcode = 'PT401', message = 'break_glass_expired';
  end if;
  if not exists (
    select 1
      from iam.session s
      join iam.app_user u on u.id = s.user_id
     where s.id = (c ->> 'sid')::uuid
       and s.user_id = (c ->> 'sub')::uuid
       and s.active_role = r
       and s.revoked_at is null
       and now() < s.idle_expires_at
       and now() < s.expires_at
       and u.status = 'active'
       and ((k = 'external' and u.kind = 'external')
         or (k = 'internal' and u.kind = 'internal' and exists (
               select 1 from iam.role_assignment a
                where a.user_id = u.id
                  and a.db_role = r
                  and a.revoked_at is null
                  and a.valid @> now())))
  ) then
    raise exception using errcode = 'PT401', message = 'session_invalid';
  end if;
end;
$$;

revoke all on function private.pre_request() from public;
grant execute on function private.pre_request() to web_anon, ext_user, int_viewer, int_surveyor,
  int_auditor, int_coordinator, int_manager, int_compliance, int_hr, int_finance, int_sysadmin;

-- I-06: scope and authority checks. Callers are definer API functions, so
-- these helpers are not exposed to PostgREST directly.
create function private.assert_in_scope(p_unit_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_unit_id is null then
    raise exception 'unit_required' using errcode = '22023';
  end if;
  if p_unit_id = any (private.my_units())
     or p_unit_id = any (private.my_offices()) then
    return;
  end if;
  perform private.emit_event(
    'authz.denied.out_of_scope', 'denied', 'org_unit', p_unit_id, p_unit_id, null,
    jsonb_build_object('role', private.active_role()));
  raise exception 'out_of_scope' using errcode = '42501';
end;
$$;

-- R1.6 / ADR-0022: break-glass exists to restore platform administration, not
-- to exercise business authority. The matrix is data, checked here at the one
-- point every regulated operation passes through. A forged `src=break_glass`
-- claim can only cause additional denials, so the check is fail-closed.
create function private.assert_not_break_glass(p_action_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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

revoke all on function private.assert_not_break_glass(text) from public;

create function private.assert_authority(p_action_code text, p_amount numeric default null)
returns table(rule_id uuid, title text, grade int, unit_id uuid, unit_type text)
language plpgsql
security definer
set search_path = ''
as $$
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

revoke all on function private.assert_in_scope(uuid) from public;
revoke all on function private.assert_authority(text, numeric) from public;
grant execute on function private.assert_in_scope(uuid) to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;
grant execute on function private.assert_authority(text, numeric) to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

create function private.explain_authority(
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
        join qual.qualification q on q.code = sq.qualification_code
        left join qual.qualification_action qa on qa.qualification_code = q.code
       where sq.user_id = v_uid
         and sq.valid @> now()
         and sq.revoked_at is null
         and (
           sq.qualification_code = p_action_code
           or q.action_code = p_action_code
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

revoke all on function private.explain_authority(text, numeric, uuid, uuid) from public;
grant execute on function private.explain_authority(text, numeric, uuid, uuid) to
  int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

create function private.assert_role_eligible(p_user_id uuid, p_db_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_db_role = 'int_sysadmin' then
    return;
  end if;
  if exists (
    select 1
      from iam.staff_position p
      join iam.job_title t on t.code = p.job_title_code
      join core.org_unit u on u.id = p.unit_id
      join iam.default_role_rule r on r.db_role = p_db_role
     where p.user_id = p_user_id
       and p.valid @> now()
       and (r.unit_type is null or r.unit_type = u.unit_type)
       and (r.unit_function is null or r.unit_function = u.function_code)
       and (r.job_family is null or r.job_family = p.job_family)
       and t.grade between r.min_grade and r.max_grade
  ) then
    return;
  end if;
  perform private.emit_event(
    'authz.denied.insufficient_authority', 'denied', 'app_user', p_user_id, null, null,
    jsonb_build_object('role', p_db_role, 'reason', 'role_not_eligible'));
  raise exception 'role_not_eligible' using errcode = '42501';
end;
$$;

revoke all on function private.assert_role_eligible(uuid, text) from public;
