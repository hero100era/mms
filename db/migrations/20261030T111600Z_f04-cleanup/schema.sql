-- Remove the F-04 toy privilege-model objects. Hand-written because pgschema
-- drops functions before the policies that depend on them.
drop view api.demo_jobs;
drop view api.demo_cases;
drop function api.demo_job_draft(text);
drop function api.demo_job_submit(uuid);
drop table party.demo_job;
drop table party.demo_case;
drop function private.demo_my_units();
drop function private.demo_active_role();
drop function private.demo_claim(text);
drop table core.demo_org_coverage;
drop table core.demo_org_unit;
