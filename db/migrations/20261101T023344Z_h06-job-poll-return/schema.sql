-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION job_poll(
    p_limit integer DEFAULT 10
)
RETURNS TABLE(id uuid, kind text, payload jsonb, attempts integer, enqueued_by uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  -- A job that another instance has already claimed (`processing`) or finished
  -- (`done`) must never be handed out twice: `job_begin` has already bumped
  -- `attempts` and set the worker context, so re-processing would re-send the
  -- invite mail and double the audit attribution. Only terminal states are
  -- retried, and `failed` is terminal here (a human re-queues it).
  --
  -- `return query` is required: in PL/pgSQL a bare SELECT discards its result.
  -- `skip locked` lets a second instance take other rows instead of blocking.
  return query
  select o.id, o.kind, o.payload, o.attempts, o.enqueued_by
    from core.outbox o
   where o.status = 'pending'
     and o.next_at <= now()
   order by o.next_at, o.created_at
   limit coalesce(p_limit, 10)
     for update skip locked;
end;
$$;
