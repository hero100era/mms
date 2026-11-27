CREATE INDEX CONCURRENTLY IF NOT EXISTS certificate_org_ix ON fleet.certificate (org_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS finding_comment_org_ix ON fleet.finding_comment (org_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS survey_audit_org_ix ON fleet.survey_audit (org_id);
