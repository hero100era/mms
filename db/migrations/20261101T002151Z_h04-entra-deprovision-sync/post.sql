-- Backfill event_type for auth.user.deactivated
insert into audit_trail.event_type (code, description, regulated, reason_required, retention_class)
values ('auth.user.deactivated', 'User deactivated', true, true, 'RC-1')
on conflict (code) do update
  set description = excluded.description,
      regulated = excluded.regulated,
      reason_required = excluded.reason_required,
      retention_class = excluded.retention_class;
