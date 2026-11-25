CREATE INDEX CONCURRENTLY IF NOT EXISTS outbox_lease_expired_ix ON core.outbox (lease_expires_at) WHERE (status = 'processing'::text);
