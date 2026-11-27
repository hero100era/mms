
create function private.survey_request_office_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
begin
  select unit_type into v_type from core.org_unit where id = new.office_unit_id and active;
  if v_type is distinct from 'station' then
    raise exception 'office_unit_id must reference an active station' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.survey_request_office_check() from public;

create function private.can_read_document(p_document_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from core.document d
    where d.id = p_document_id
      and (
        case
          when d.entity_type = 'survey_request' then
            case
              when private.active_role() = 'ext_user' then
                exists (
                  select 1 from survey.survey_request r
                  where r.id = d.entity_id
                    and r.org_id = any (private.my_org_ids())
                )
              else
                exists (
                  select 1 from survey.survey_request r
                  where r.id = d.entity_id
                    and r.office_unit_id = any (private.my_offices())
                )
            end
          else false
        end
      )
  );
$$;

revoke all on function private.can_read_document(uuid) from public;
grant execute on function private.can_read_document(uuid) to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

create function private.org_unit_name(p_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select name
    from core.org_unit
   where id = p_id
     and (
       coalesce(private.active_role(), '') <> 'ext_user'
       or (unit_type = 'station' and active)
     );
$$;

revoke all on function private.org_unit_name(uuid) from public;
grant execute on function private.org_unit_name(uuid) to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

create function private.next_certificate_no()
returns bigint
language sql
volatile
security definer
set search_path = ''
as $$
  select nextval('fleet.certificate_no_seq');
$$;

revoke all on function private.next_certificate_no() from public;
