CREATE INDEX CONCURRENTLY IF NOT EXISTS survey_request_item_cat_ix ON survey.survey_request_item (survey_catalog_id);

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS survey_request_item_req_cat_uk ON survey.survey_request_item (survey_request_id, survey_catalog_id) WHERE (survey_catalog_id IS NOT NULL);
