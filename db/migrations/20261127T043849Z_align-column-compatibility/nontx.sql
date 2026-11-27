CREATE INDEX CONCURRENTLY IF NOT EXISTS certificate_doc_admin_ix ON fleet.certificate (doc_administration);

CREATE INDEX CONCURRENTLY IF NOT EXISTS certificate_line_doc_admin_ix ON survey.certificate_line (doc_administration);
