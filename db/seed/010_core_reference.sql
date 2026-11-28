-- Reference data for the organisation model.

insert into core.region (code, name) values
  ('CN-EAST', 'East China'),
  ('CN-SOUTH', 'South China')
on conflict (code) do update set name = excluded.name;

insert into core.org_unit_type (code, scoping, default_family) values
  ('head_office', 'global', null),
  ('ho_department', 'global', null),
  ('regional_office', 'location', null),
  ('station', 'location', null),
  ('plan_approval_centre', 'routed', 'plan'),
  ('mts_centre', 'location', 'mts')
on conflict (code) do update
  set scoping = excluded.scoping, default_family = excluded.default_family;

insert into audit_trail.retention_class
  (class_code, name, description, statutory_retention_years, active_db_retention_years, disposition_policy, requires_worm, crypto_shred_eligible)
values
  ('RC-1', 'Identity and Access', 'Authentication attempts, session histories, role assignment changes, user status transitions', 7, 2, 'cold_archive', true, true),
  ('RC-2', 'Operational Surveys & Triage', 'Operational survey triage, attendances, non-conformities, Conditions of Class (CoC), deficiencies', 10, 5, 'cold_archive', true, false),
  ('RC-3', 'Technical Ship Data & Plan Approvals', 'Ship particulars, hull/machinery specifications, approved drawings, technical stability calculations', 30, 10, 'cold_immutable', true, false),
  ('RC-4', 'Issued Statutory & Class Certificates', 'Formal interim/full-term class and statutory certificates, statements of compliance, certified reports', 30, 10, 'cold_immutable', true, false),
  ('RC-5', 'Row-Level Audit Change Log', 'Granular row modification diffs captured by private.audit_capture() on all domain tables', 30, 2, 'seal_and_worm', true, true),
  ('RC-6', 'Administrative Events', 'Structural organizational changes: unit creation/closure, MTS coverage, routing rule changes, user account suspension', 7, 3, 'cold_archive', true, false),
  ('RC-7', 'Database Schema Changes & Migration Ledgers', 'Migration ledger (public.schema_migrations), Git history, pgaudit DDL logs', null, null, 'perpetual', true, false)
on conflict (class_code) do update
  set name = excluded.name,
      description = excluded.description,
      statutory_retention_years = excluded.statutory_retention_years,
      active_db_retention_years = excluded.active_db_retention_years,
      disposition_policy = excluded.disposition_policy,
      requires_worm = excluded.requires_worm,
      crypto_shred_eligible = excluded.crypto_shred_eligible;

insert into audit_trail.table_retention_policy (schema_name, table_name, retention_class, description) values
  ('iam', 'app_user', 'RC-1', 'Identity and access user profiles'),
  ('iam', 'session', 'RC-1', 'User sessions and login activity'),
  ('iam', 'role_assignment', 'RC-1', 'Capability role assignments'),
  ('iam', 'staff_position', 'RC-1', 'Staff position assignments and compensation grades'),
  ('survey', 'survey_request', 'RC-2', 'Operational survey triage and requests'),
  ('fleet', 'ship', 'RC-3', 'Vessel particulars and technical registers'),
  ('core', 'document', 'RC-4', 'Issued artifacts and documentation metadata'),
  ('core', 'document_version', 'RC-4', 'Document binary hashes and versions'),
  ('audit_trail', 'malware_scan_run', 'RC-1', 'Malware scanning execution run records and threat detection ledger'),
  ('core', 'org_unit', 'RC-6', 'Organizational structure and units'),
  ('party', 'organization', 'RC-6', 'Customer and partner organizations'),
  ('qual', 'staff_qualification', 'RC-1', 'Staff qualification authorizations and history'),
  ('qual', 'qualification', 'RC-6', 'Qualification catalog'),
  ('qual', 'qualification_action', 'RC-6', 'Qualification action mappings')
on conflict (schema_name, table_name) do update
  set retention_class = excluded.retention_class,
      description = excluded.description;

insert into audit_trail.event_type (code, description, regulated, reason_required, retention_class) values
  ('org.unit.created', 'Organisation unit created', true, true, 'RC-6'),
  ('org.unit.changed', 'Organisation unit changed', true, true, 'RC-6'),
  ('org.unit.closed', 'Organisation unit closed', true, true, 'RC-6'),
  ('org.coverage.granted', 'Coverage granted', true, true, 'RC-6'),
  ('org.coverage.ended', 'Coverage ended', true, true, 'RC-6'),
  ('org.routing_rule.changed', 'Routing rule changed', true, true, 'RC-6'),

  ('auth.login.success', 'Login succeeded', true, false, 'RC-1'),
  ('auth.login.failure', 'Login failed', true, false, 'RC-1'),
  ('auth.logout', 'Logout', true, false, 'RC-1'),
  ('auth.session.created', 'Session created', true, false, 'RC-1'),
  ('auth.session.revoked', 'Session revoked', true, false, 'RC-1'),
  ('auth.role.switched', 'Role switched', true, false, 'RC-1'),
  ('auth.role_assignment.granted', 'Role assignment granted', true, true, 'RC-1'),
  ('auth.role_assignment.revoked', 'Role assignment revoked', true, true, 'RC-1'),
  ('auth.identity.linked', 'Identity linked', true, false, 'RC-1'),
  ('auth.identity.unlinked', 'Identity unlinked', true, false, 'RC-1'),
  ('auth.password.set', 'Password set', true, false, 'RC-1'),
  ('auth.password.changed', 'Password changed', true, false, 'RC-1'),
  ('auth.password.reset_requested', 'Password reset requested', true, false, 'RC-1'),
  ('auth.password.reset_completed', 'Password reset completed', true, false, 'RC-1'),
  ('auth.invite.created', 'Invite created', true, false, 'RC-1'),
  ('auth.invite.accepted', 'Invite accepted', true, false, 'RC-1'),
  ('auth.invite.expired', 'Invite expired', true, false, 'RC-1'),
  ('auth.membership.granted', 'Membership granted', true, true, 'RC-1'),
  ('auth.membership.revoked', 'Membership revoked', true, true, 'RC-1'),
  ('auth.user.created', 'User created', true, true, 'RC-1'),
  ('auth.user.suspended', 'User suspended', true, true, 'RC-1'),
  ('auth.user.reactivated', 'User reactivated', true, true, 'RC-1'),
  ('auth.user.deactivated', 'User deactivated', true, true, 'RC-1'),
  ('auth.lockout', 'Account lockout', true, false, 'RC-1'),
  ('auth.stepup.success', 'Step-up succeeded', true, false, 'RC-1'),
  ('auth.stepup.failure', 'Step-up failed', true, false, 'RC-1'),
  ('auth.mfa.enrolled', 'MFA enrolled', true, false, 'RC-1'),
  ('auth.mfa.disabled', 'MFA disabled', true, false, 'RC-1'),
  ('auth.breakglass.activated', 'Break-glass activated', true, true, 'RC-1'),
  ('auth.breakglass.deactivated', 'Break-glass deactivated', true, true, 'RC-1'),
  ('auth.breakglass.denied', 'Denied: break-glass disabled', true, false, 'RC-1'),
  ('auth.breakglass.failure', 'Break-glass activation failed', true, false, 'RC-1'),
  ('auth.breakglass.registered', 'Break-glass account registered', true, true, 'RC-1'),
  ('auth.breakglass.drill_recorded', 'Break-glass drill recorded with evidence', true, false, 'RC-1'),
  ('auth.mfa.success', 'MFA challenge succeeded', true, false, 'RC-1'),
  ('auth.mfa.failure', 'MFA challenge failed', true, false, 'RC-1'),
  ('authz.denied.out_of_scope', 'Denied: out of scope', true, false, 'RC-1'),
  ('authz.denied.insufficient_authority', 'Denied: insufficient authority', true, false, 'RC-1'),
  ('authz.denied.break_glass_forbidden', 'Denied: break-glass forbidden operation', true, false, 'RC-1'),
  ('iam.position.changed', 'Position changed', true, true, 'RC-1'),
  ('iam.position.closed', 'Position closed', true, true, 'RC-1'),
  ('iam.assignment.granted', 'Role assignment granted', true, true, 'RC-1'),
  ('iam.assignment.revoked', 'Role assignment revoked', true, true, 'RC-1'),
  ('iam.position.proposed', 'Position proposed from directory attributes', true, false, 'RC-1'),
  ('iam.position.proposal_confirmed', 'Position proposal confirmed', true, true, 'RC-1'),
  ('iam.position.proposal_rejected', 'Position proposal rejected', true, true, 'RC-1'),
  ('survey.request.created', 'Survey request created', true, false, 'RC-2'),
  ('survey.request.submitted', 'Survey request submitted', true, false, 'RC-2'),
  ('survey.request.accepted', 'Survey request accepted', true, true, 'RC-2'),
  ('survey.request.clarification_requested', 'Survey request clarification requested', true, true, 'RC-2'),
  ('survey.request.rejected', 'Survey request rejected', true, true, 'RC-2'),
  ('survey.request.transferred', 'Survey request transferred', true, true, 'RC-2'),
  ('core.document.created', 'Document version attached', true, false, 'RC-4'),
  ('core.document.scan_passed', 'Malware scan passed clean for document version', true, false, 'RC-4'),
  ('core.document.malware_detected', 'Malware threat detected in uploaded document', true, false, 'RC-1'),
  ('privacy.crypto_shred.executed', 'Personal data encryption key destroyed for data subject', true, true, 'RC-1'),
  ('audit_trail.retention.purged', 'Expired audit records purged from active DB following WORM sealing', true, true, 'RC-6'),
  ('audit_trail.retention.hold_applied', 'Retention hold applied to records', true, true, 'RC-6'),
  ('qual.qualification.granted', 'Staff qualification granted', true, true, 'RC-1'),
  ('qual.qualification.revoked', 'Staff qualification revoked', true, true, 'RC-1'),
  ('core.upload.failed', 'Upload failed or was abandoned before becoming a document', true, false, 'RC-4')
on conflict (code) do update
  set description = excluded.description,
      regulated = excluded.regulated,
      reason_required = excluded.reason_required,
      retention_class = excluded.retention_class;

-- ADR-0023 §8: only these engines may settle a scan verdict. The mock exists so
-- tests and local development never need a daemon, and is explicitly marked
-- non-production so the production path refuses it rather than trusting the name.
insert into private.approved_scanner_engine (engine, description, production) values
  ('clamav', 'ClamAV via clamd stream protocol', true),
  ('defender', 'Microsoft Defender for Storage (blob index tags)', true),
  ('mock', 'Deterministic test double; never scans real bytes', false)
on conflict (engine) do update
  set description = excluded.description,
      production = excluded.production;


-- ---------------------------------------------------------------------------
-- Maritime classification and survey reference data
-- ---------------------------------------------------------------------------

insert into core.administration_type (code, name) values
  ('C', 'Civilian'),
  ('N', 'Naval'),
  ('O', 'Other'),
  ('X', 'None'),
  ('U', 'Unknown')
on conflict (code) do update set name = excluded.name;

insert into core.class_status (code, name) values
  ('V', 'Valid'),
  ('S', 'Suspended'),
  ('W', 'Withdrawn')
on conflict (code) do update set name = excluded.name;

insert into core.ship_status (code, name) values
  ('in_service', 'In Service'),
  ('laid_up', 'Laid Up'),
  ('under_construction', 'Under Construction'),
  ('decommissioned', 'Decommissioned')
on conflict (code) do update set name = excluded.name;

insert into core.certificate_status (code, name) values
  ('V', 'Valid'),
  ('S', 'Suspended'),
  ('W', 'Withdrawn')
on conflict (code) do update set name = excluded.name;

insert into core.certificate_validity_type (code, name) values
  ('F', 'Full Term'),
  ('I', 'Interim'),
  ('S', 'Short Term'),
  ('C', 'Conditional')
on conflict (code) do update set name = excluded.name;

insert into core.certificate_category (code, name) values
  ('IC', 'International Certificates'),
  ('C', 'Conditional'),
  ('SoC', 'Statement of Compliance')
on conflict (code) do update set name = excluded.name;

insert into core.certificate_internal_category (code, name, description) values
  ('CL', 'Classification', 'Certificates of classification issued by the classification society'),
  ('ST', 'Standard', 'Certificates of conformity to particular requirements issued on the authority of the ships''s flag administration'),
  ('SI', 'Statement for Issue', 'Statement issued by RO for the purpose of the issue of the actual certificates by the flag administration'),
  ('DoC', 'Document of Compliance', 'certificates stating that the ships complies with particular requirements even though they are not applicable to the vessel'),
  ('SoC', 'Statement of Compliance', 'statement issued by RO not on behalf of the flag administration'),
  ('OT', 'Other', 'Other certificates')
on conflict (code) do update
  set name = excluded.name,
      description = excluded.description;

insert into core.certificate_action (code, name) values
  ('I', 'Issued'),
  ('EN', 'Endorsed'),
  ('S', 'Statement for Endorsement'),
  ('W', 'Withdrawn'),
  ('EX', 'Extended'),
  ('RI', 'Registered')
on conflict (code) do update set name = excluded.name;

insert into core.survey_audit_status (code, name) values
  ('D', 'Within Due Date'),
  ('O', 'Overdue'),
  ('P', 'Partial'),
  ('B', 'Before Due Date'),
  ('PP', 'Postponed')
on conflict (code) do update set name = excluded.name;

insert into core.finding_type (code, name) values
  ('M', 'Memorandum'),
  ('C', 'Class Condition'),
  ('S', 'Statutory Condition'),
  ('N', 'Non-conformity'),
  ('D', 'Deficiency'),
  ('O', 'Observation'),
  ('R', 'Retroactive Requirement')
on conflict (code) do update set name = excluded.name;

insert into core.finding_status (code, name) values
  ('A', 'Active'),
  ('P', 'Postponed'),
  ('O', 'Overdue')
on conflict (code) do update set name = excluded.name;

insert into core.classification_society (code, name) values
  ('ABS', 'American Bureau of Shipping'),
  ('BV', 'Bureau Veritas'),
  ('CCS', 'China Classification Society'),
  ('CRS', 'Croatian Register of Shipping'),
  ('IRS', 'Indian Register of Shipping'),
  ('KR', 'Korean Register of Shipping'),
  ('LR', 'Lloyd''s Register of Shipping'),
  ('NK', 'Nippon Kaiji Kyokai'),
  ('PRS', 'Polish Register of Shipping'),
  ('RINA', 'RINA Services S.p.A.'),
  ('RS', 'Russian Maritime Register of Shipping'),
  ('VL', 'DNV GL')
on conflict (code) do update set name = excluded.name;

insert into core.vessel_type_iacs (code, name) values
  ('BC', 'Bulk carrier (all combinations OB, OBO,OO)'),
  ('CT', 'Chemical tanker'),
  ('GC', 'General cargo vessel (including ro-ro cargo, container, reefer, HSC cargo)'),
  ('GT', 'Gas tanker'),
  ('LC', 'Other bulk liquid carrier'),
  ('OT', 'Oil tanker'),
  ('PS', 'Passenger vessel (including Passenger/General cargo, Passenger/ro-ro, Passenger HSC)'),
  ('ZZ', 'Other vessel type')
on conflict (code) do update set name = excluded.name;

insert into core.vessel_type_mms (code, name) values
  ('BC', 'Bulk carrier'),
  ('CH', 'Cargo high speed craft'),
  ('CT', 'Chemical tanker'),
  ('GC', 'Gas carrier'),
  ('MO', 'Mobile offshore drilling unit'),
  ('OC', 'Other cargo ships'),
  ('OT', 'Oil tanker'),
  ('PH', 'Passenger high speed craft'),
  ('PS', 'Passenger ships'),
  ('PR', 'Ro-ro cargo ships')
on conflict (code) do update set name = excluded.name;

insert into core.certificate_type (code, description) values
  ('AFS', 'Anti-Fouling System'),
  ('BWM', 'Ballast Water Management'),
  ('CL', 'Classification'),
  ('DSC', 'Dynamically Supported Craft Construction and Equipment'),
  ('EU-MRV', 'Monitoring, reporting, and verification of carbon dioxide emissions'),
  ('RECYCL_HKC', 'Inventory of Hazardous Materials'),
  ('HSC', 'High-Speed Craft Safety'),
  ('IBC', 'Fitness for the Carriage of Dangerous Chemicals in Bulk'),
  ('IMSBC', 'International Maritime Solid Bulk Cargoes'),
  ('IGC', 'Fitness for the Carriage of Liquefied Gases in Bulk'),
  ('ILO92', 'ILO92 - Crew Accommodation'),
  ('ILO133', 'ILO133 - Crew Accommodation'),
  ('ILO152', 'ILO152 - Cargo Gear'),
  ('INF', 'Fitness for the Carriage of INF Cargo'),
  ('DOC', 'Safety Management - Company'),
  ('SMC', 'Safety Management - Vessel'),
  ('ISPS', 'Ships and Port Facility Security'),
  ('ISO9001', 'Quality management systems'),
  ('ISO14001', 'Environmental management systems'),
  ('ISO45001', 'Occupational health and safety management system'),
  ('ISO50001', 'Energy management system'),
  ('LL', 'International Convention on Load Lines'),
  ('OPP', 'Oil Pollution Prevention'),
  ('OPP-T', 'Oil Pollution Prevention - Tanker'),
  ('NLS', 'Pollution Prevention for the Carriage of Noxious Liquid Substances in Bulk'),
  ('SPP', 'Sewage Pollution Prevention'),
  ('GPP', 'Garbage Pollution Prevention'),
  ('APP', 'Air Pollution Prevention'),
  ('EE', 'Energy Efficiency'),
  ('FDCS', 'Fuel Oil Consumption Reporting'),
  ('MLC', 'Maritime Labour Convention'),
  ('MODU', 'Code for the Construction and Equipment of Mobile Offshore Drilling Units'),
  ('POLAR', 'International Code for ships Operating in Polar Waters'),
  ('CSS', 'Cargo Ships Safety'),
  ('DG', 'For the Carriage of Dangerous Goods'),
  ('SC', 'Cargo Ships Safety Construction'),
  ('SE', 'Cargo Ships Safety Equipment'),
  ('SR', 'Cargo Ships Safety Radio'),
  ('PSS', 'Passenger Ships Safety'),
  ('SPS', 'Special Purpose Ships Safety'),
  ('TM', 'Tonnage'),
  ('REFCS', 'Refrigerated Cargo System')
on conflict (code) do update set description = excluded.description;

insert into core.survey_audit_type (code, name, is_scheduled) values
  ('A', 'Annual', true),
  ('F', 'Final', false),
  ('I', 'Initial', false),
  ('In', 'Intermediate', true),
  ('It', 'Interim', false),
  ('O', 'Other', false),
  ('Ad', 'Additional', false),
  ('P', 'Periodical', true),
  ('R', 'Renewal', true)
on conflict (code) do update
  set name = excluded.name,
      is_scheduled = excluded.is_scheduled;

insert into core.survey_audit_catalog (code, name, description, item_kind) values
  ('B', 'Inspection of the outside of the ship''s bottom (DRY)', 'Inspection of the outside of the ship''s bottom (DRY)', 'survey'),
  ('W', 'Inspection of the outside of the ship''s bottom (IWS)', 'Inspection of the outside of the ship''s bottom (IWS)', 'survey'),
  ('T', 'Tailshaft Survey', 'Tailshaft Survey', 'survey'),
  ('T1', 'Tailshaft Survey(No.1)', 'Tailshaft Survey(No.1)', 'survey'),
  ('T2', 'Tailshaft Survey(No.2)', 'Tailshaft Survey(No.2)', 'survey'),
  ('T3', 'Tailshaft Survey(No.3)', 'Tailshaft Survey(No.3)', 'survey'),
  ('T4', 'Tailshaft Survey(No.4)', 'Tailshaft Survey(No.4)', 'survey'),
  ('T5', 'Tailshaft Survey(No.5)', 'Tailshaft Survey(No.5)', 'survey'),
  ('T6', 'Tailshaft Survey(No.6)', 'Tailshaft Survey(No.6)', 'survey'),
  ('Bo', 'Boiler Survey', 'Boiler Survey', 'survey'),
  ('Bo1', 'Boiler Survey(No.1)', 'Boiler Survey(No.1)', 'survey'),
  ('Bo2', 'Boiler Survey(No.2)', 'Boiler Survey(No.2)', 'survey'),
  ('Bo3', 'Boiler Survey(No.3)', 'Boiler Survey(No.3)', 'survey'),
  ('Bo4', 'Boiler Survey(No.4)', 'Boiler Survey(No.4)', 'survey'),
  ('Bo5', 'Boiler Survey(No.5)', 'Boiler Survey(No.5)', 'survey'),
  ('Bo6', 'Boiler Survey(No.6)', 'Boiler Survey(No.6)', 'survey'),
  ('BOT', 'Bottom survey', 'Bottom survey', 'survey')
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  item_kind = excluded.item_kind;

-- IMO HSSC (Harmonized System of Survey and Certification, Res. A.1156(32)) statutory surveys
insert into core.survey_audit_catalog (
  code, name, description, item_kind,
  certificate_type_code, survey_audit_type_code,
  period, window_before, window_after,
  is_statutory, is_mandatory, is_periodical
) values
  -- Cargo Ship Safety Construction (SOLAS Ch. I, Reg. 10)
  ('SC-I', 'Cargo Ship Safety Construction - Initial Survey', 'SOLAS Ch. I Reg. 10(a)(i) initial survey', 'survey', 'SC', 'I', null, null, null, true, true, false),
  ('SC-A', 'Cargo Ship Safety Construction - Annual Survey', 'SOLAS Ch. I Reg. 10(a)(iv) annual survey', 'survey', 'SC', 'A', interval '1 year', interval '3 months', interval '3 months', true, true, true),
  ('SC-In', 'Cargo Ship Safety Construction - Intermediate Survey', 'SOLAS Ch. I Reg. 10(a)(iii) intermediate survey (2nd or 3rd anniversary)', 'survey', 'SC', 'In', interval '5 years', interval '6 months', interval '6 months', true, true, true),
  ('SC-R', 'Cargo Ship Safety Construction - Renewal Survey', 'SOLAS Ch. I Reg. 10(a)(ii) 5-year renewal survey', 'survey', 'SC', 'R', interval '5 years', interval '3 months', interval '0 days', true, true, true),

  -- Cargo Ship Safety Equipment (SOLAS Ch. I, Reg. 8)
  ('SE-I', 'Cargo Ship Safety Equipment - Initial Survey', 'SOLAS Ch. I Reg. 8(a)(i) initial survey', 'survey', 'SE', 'I', null, null, null, true, true, false),
  ('SE-A', 'Cargo Ship Safety Equipment - Annual Survey', 'SOLAS Ch. I Reg. 8(a)(iv) annual survey', 'survey', 'SE', 'A', interval '1 year', interval '3 months', interval '3 months', true, true, true),
  ('SE-P', 'Cargo Ship Safety Equipment - Periodical Survey', 'SOLAS Ch. I Reg. 8(a)(iii) periodical survey (2nd or 3rd anniversary)', 'survey', 'SE', 'P', interval '5 years', interval '6 months', interval '6 months', true, true, true),
  ('SE-R', 'Cargo Ship Safety Equipment - Renewal Survey', 'SOLAS Ch. I Reg. 8(a)(ii) 5-year renewal survey', 'survey', 'SE', 'R', interval '5 years', interval '3 months', interval '0 days', true, true, true),

  -- Cargo Ship Safety Radio (SOLAS Ch. I, Reg. 9)
  ('SR-I', 'Cargo Ship Safety Radio - Initial Survey', 'SOLAS Ch. I Reg. 9(a)(i) initial survey', 'survey', 'SR', 'I', null, null, null, true, true, false),
  ('SR-P', 'Cargo Ship Safety Radio - Periodical Survey', 'SOLAS Ch. I Reg. 9(a)(iii) annual periodical survey', 'survey', 'SR', 'P', interval '1 year', interval '3 months', interval '3 months', true, true, true),
  ('SR-R', 'Cargo Ship Safety Radio - Renewal Survey', 'SOLAS Ch. I Reg. 9(a)(ii) 5-year renewal survey', 'survey', 'SR', 'R', interval '5 years', interval '3 months', interval '0 days', true, true, true),

  -- Combined Cargo Ship Safety Certificate (SOLAS Ch. I, Reg. 12(a)(v))
  ('CSS-I', 'Cargo Ship Safety - Initial Survey', 'SOLAS Ch. I combined Cargo Ship Safety initial survey', 'survey', 'CSS', 'I', null, null, null, true, false, false),
  ('CSS-A', 'Cargo Ship Safety - Annual Survey', 'SOLAS Ch. I combined Cargo Ship Safety annual survey', 'survey', 'CSS', 'A', interval '1 year', interval '3 months', interval '3 months', true, false, true),
  ('CSS-P', 'Cargo Ship Safety - Periodical Survey', 'SOLAS Ch. I combined Cargo Ship Safety annual periodical survey', 'survey', 'CSS', 'P', interval '1 year', interval '3 months', interval '3 months', true, false, true),
  ('CSS-In', 'Cargo Ship Safety - Intermediate Survey', 'SOLAS Ch. I combined Cargo Ship Safety intermediate survey', 'survey', 'CSS', 'In', interval '5 years', interval '6 months', interval '6 months', true, false, true),
  ('CSS-R', 'Cargo Ship Safety - Renewal Survey', 'SOLAS Ch. I combined Cargo Ship Safety 5-year renewal survey', 'survey', 'CSS', 'R', interval '5 years', interval '3 months', interval '0 days', true, false, true),

  -- Passenger Ship Safety (SOLAS Ch. I, Reg. 7)
  ('PSS-I', 'Passenger Ship Safety - Initial Survey', 'SOLAS Ch. I Reg. 7(a)(i) initial survey', 'survey', 'PSS', 'I', null, null, null, true, true, false),
  ('PSS-R', 'Passenger Ship Safety - Renewal Survey', 'SOLAS Ch. I Reg. 7(a)(ii) annual renewal survey', 'survey', 'PSS', 'R', interval '1 year', interval '3 months', interval '0 days', true, true, true),

  -- International Load Line (ICLL 1966/1988 Protocol, Art. 14)
  ('LL-I', 'Load Line - Initial Survey', 'ICLL 66/88 Art. 14(1)(a) initial survey', 'survey', 'LL', 'I', null, null, null, true, true, false),
  ('LL-A', 'Load Line - Annual Survey', 'ICLL 66/88 Art. 14(1)(c) annual survey', 'survey', 'LL', 'A', interval '1 year', interval '3 months', interval '3 months', true, true, true),
  ('LL-R', 'Load Line - Renewal Survey', 'ICLL 66/88 Art. 14(1)(b) 5-year renewal survey', 'survey', 'LL', 'R', interval '5 years', interval '3 months', interval '0 days', true, true, true),

  -- Oil Pollution Prevention (MARPOL Annex I, Reg. 6)
  ('OPP-I', 'Oil Pollution Prevention (IOPP) - Initial Survey', 'MARPOL Annex I Reg. 6.1.1 initial survey', 'survey', 'OPP', 'I', null, null, null, true, true, false),
  ('OPP-A', 'Oil Pollution Prevention (IOPP) - Annual Survey', 'MARPOL Annex I Reg. 6.1.4 annual survey', 'survey', 'OPP', 'A', interval '1 year', interval '3 months', interval '3 months', true, true, true),
  ('OPP-In', 'Oil Pollution Prevention (IOPP) - Intermediate Survey', 'MARPOL Annex I Reg. 6.1.3 intermediate survey', 'survey', 'OPP', 'In', interval '5 years', interval '6 months', interval '6 months', true, true, true),
  ('OPP-R', 'Oil Pollution Prevention (IOPP) - Renewal Survey', 'MARPOL Annex I Reg. 6.1.2 5-year renewal survey', 'survey', 'OPP', 'R', interval '5 years', interval '3 months', interval '0 days', true, true, true),

  -- Oil Pollution Prevention - Oil Tankers (MARPOL Annex I, Reg. 6 / Form B)
  ('OPP-T-I', 'Oil Pollution Prevention (Tanker) - Initial Survey', 'MARPOL Annex I Reg. 6.1.1 tanker initial survey', 'survey', 'OPP-T', 'I', null, null, null, true, false, false),
  ('OPP-T-A', 'Oil Pollution Prevention (Tanker) - Annual Survey', 'MARPOL Annex I Reg. 6.1.4 tanker annual survey', 'survey', 'OPP-T', 'A', interval '1 year', interval '3 months', interval '3 months', true, false, true),
  ('OPP-T-In', 'Oil Pollution Prevention (Tanker) - Intermediate Survey', 'MARPOL Annex I Reg. 6.1.3 tanker intermediate survey', 'survey', 'OPP-T', 'In', interval '5 years', interval '6 months', interval '6 months', true, false, true),
  ('OPP-T-R', 'Oil Pollution Prevention (Tanker) - Renewal Survey', 'MARPOL Annex I Reg. 6.1.2 tanker 5-year renewal survey', 'survey', 'OPP-T', 'R', interval '5 years', interval '3 months', interval '0 days', true, false, true),

  -- Noxious Liquid Substances in Bulk (MARPOL Annex II, Reg. 8)
  ('NLS-I', 'Noxious Liquid Substances (NLS) - Initial Survey', 'MARPOL Annex II Reg. 8.1.1 initial survey', 'survey', 'NLS', 'I', null, null, null, true, false, false),
  ('NLS-A', 'Noxious Liquid Substances (NLS) - Annual Survey', 'MARPOL Annex II Reg. 8.1.4 annual survey', 'survey', 'NLS', 'A', interval '1 year', interval '3 months', interval '3 months', true, false, true),
  ('NLS-In', 'Noxious Liquid Substances (NLS) - Intermediate Survey', 'MARPOL Annex II Reg. 8.1.3 intermediate survey', 'survey', 'NLS', 'In', interval '5 years', interval '6 months', interval '6 months', true, false, true),
  ('NLS-R', 'Noxious Liquid Substances (NLS) - Renewal Survey', 'MARPOL Annex II Reg. 8.1.2 5-year renewal survey', 'survey', 'NLS', 'R', interval '5 years', interval '3 months', interval '0 days', true, false, true),

  -- Sewage Pollution Prevention (MARPOL Annex IV, Reg. 4)
  ('SPP-I', 'Sewage Pollution Prevention (ISPP) - Initial Survey', 'MARPOL Annex IV Reg. 4.1.1 initial survey', 'survey', 'SPP', 'I', null, null, null, true, false, false),
  ('SPP-R', 'Sewage Pollution Prevention (ISPP) - Renewal Survey', 'MARPOL Annex IV Reg. 4.1.2 5-year renewal survey', 'survey', 'SPP', 'R', interval '5 years', interval '3 months', interval '0 days', true, false, true),

  -- Air Pollution Prevention (MARPOL Annex VI, Reg. 5)
  ('APP-I', 'Air Pollution Prevention (IAPP) - Initial Survey', 'MARPOL Annex VI Reg. 5.1.1 initial survey', 'survey', 'APP', 'I', null, null, null, true, true, false),
  ('APP-A', 'Air Pollution Prevention (IAPP) - Annual Survey', 'MARPOL Annex VI Reg. 5.1.4 annual survey', 'survey', 'APP', 'A', interval '1 year', interval '3 months', interval '3 months', true, true, true),
  ('APP-In', 'Air Pollution Prevention (IAPP) - Intermediate Survey', 'MARPOL Annex VI Reg. 5.1.3 intermediate survey', 'survey', 'APP', 'In', interval '5 years', interval '6 months', interval '6 months', true, true, true),
  ('APP-R', 'Air Pollution Prevention (IAPP) - Renewal Survey', 'MARPOL Annex VI Reg. 5.1.2 5-year renewal survey', 'survey', 'APP', 'R', interval '5 years', interval '3 months', interval '0 days', true, true, true),

  -- Energy Efficiency (MARPOL Annex VI, Reg. 5.4)
  ('EE-I', 'International Energy Efficiency (IEE) - Initial Survey', 'MARPOL Annex VI Reg. 5.4.1 initial verification survey', 'survey', 'EE', 'I', null, null, null, true, true, false),

  -- Carriage of Dangerous Chemicals in Bulk (IBC Code / MARPOL Annex II / SOLAS Ch. VII)
  ('IBC-I', 'Chemical Tanker Fitness (IBC) - Initial Survey', 'IBC Code Sec. 1.5.2.1.1 initial survey', 'survey', 'IBC', 'I', null, null, null, true, false, false),
  ('IBC-A', 'Chemical Tanker Fitness (IBC) - Annual Survey', 'IBC Code Sec. 1.5.2.1.4 annual survey', 'survey', 'IBC', 'A', interval '1 year', interval '3 months', interval '3 months', true, false, true),
  ('IBC-In', 'Chemical Tanker Fitness (IBC) - Intermediate Survey', 'IBC Code Sec. 1.5.2.1.3 intermediate survey', 'survey', 'IBC', 'In', interval '5 years', interval '6 months', interval '6 months', true, false, true),
  ('IBC-R', 'Chemical Tanker Fitness (IBC) - Renewal Survey', 'IBC Code Sec. 1.5.2.1.2 5-year renewal survey', 'survey', 'IBC', 'R', interval '5 years', interval '3 months', interval '0 days', true, false, true),

  -- Carriage of Liquefied Gases in Bulk (IGC Code / SOLAS Ch. VII)
  ('IGC-I', 'Gas Carrier Fitness (IGC) - Initial Survey', 'IGC Code Sec. 1.4.2.1.1 initial survey', 'survey', 'IGC', 'I', null, null, null, true, false, false),
  ('IGC-A', 'Gas Carrier Fitness (IGC) - Annual Survey', 'IGC Code Sec. 1.4.2.1.4 annual survey', 'survey', 'IGC', 'A', interval '1 year', interval '3 months', interval '3 months', true, false, true),
  ('IGC-In', 'Gas Carrier Fitness (IGC) - Intermediate Survey', 'IGC Code Sec. 1.4.2.1.3 intermediate survey', 'survey', 'IGC', 'In', interval '5 years', interval '6 months', interval '6 months', true, false, true),
  ('IGC-R', 'Gas Carrier Fitness (IGC) - Renewal Survey', 'IGC Code Sec. 1.4.2.1.2 5-year renewal survey', 'survey', 'IGC', 'R', interval '5 years', interval '3 months', interval '0 days', true, false, true),

  -- High-Speed Craft Safety (SOLAS Ch. X / HSC Code)
  ('HSC-I', 'High-Speed Craft Safety - Initial Survey', 'HSC Code Sec. 1.5.1.1 initial survey', 'survey', 'HSC', 'I', null, null, null, true, false, false),
  ('HSC-P', 'High-Speed Craft Safety - Periodical Survey', 'HSC Code Sec. 1.5.1.3 annual periodical survey', 'survey', 'HSC', 'P', interval '1 year', interval '3 months', interval '3 months', true, false, true),
  ('HSC-R', 'High-Speed Craft Safety - Renewal Survey', 'HSC Code Sec. 1.5.1.2 5-year renewal survey', 'survey', 'HSC', 'R', interval '5 years', interval '3 months', interval '0 days', true, false, true),

  -- Dynamically Supported Craft (Res. A.373(X))
  ('DSC-I', 'Dynamically Supported Craft - Initial Survey', 'Res. A.373(X) Sec. 1.5.1.1 initial survey', 'survey', 'DSC', 'I', null, null, null, true, false, false),
  ('DSC-P', 'Dynamically Supported Craft - Periodical Survey', 'Res. A.373(X) Sec. 1.5.1.3 annual periodical survey', 'survey', 'DSC', 'P', interval '1 year', interval '3 months', interval '3 months', true, false, true),
  ('DSC-R', 'Dynamically Supported Craft - Renewal Survey', 'Res. A.373(X) Sec. 1.5.1.2 renewal survey', 'survey', 'DSC', 'R', interval '1 year', interval '3 months', interval '0 days', true, false, true),

  -- Special Purpose Ships Safety (SPS Code / Res. MSC.266(84))
  ('SPS-I', 'Special Purpose Ship Safety - Initial Survey', '2008 SPS Code Ch. 1 initial survey', 'survey', 'SPS', 'I', null, null, null, true, false, false),
  ('SPS-A', 'Special Purpose Ship Safety - Annual Survey', '2008 SPS Code Ch. 1 annual survey', 'survey', 'SPS', 'A', interval '1 year', interval '3 months', interval '3 months', true, false, true),
  ('SPS-In', 'Special Purpose Ship Safety - Intermediate Survey', '2008 SPS Code Ch. 1 intermediate survey', 'survey', 'SPS', 'In', interval '5 years', interval '6 months', interval '6 months', true, false, true),
  ('SPS-P', 'Special Purpose Ship Safety - Periodical Survey', '2008 SPS Code Ch. 1 periodical equipment/radio survey', 'survey', 'SPS', 'P', interval '1 year', interval '3 months', interval '3 months', true, false, true),
  ('SPS-R', 'Special Purpose Ship Safety - Renewal Survey', '2008 SPS Code Ch. 1 5-year renewal survey', 'survey', 'SPS', 'R', interval '5 years', interval '3 months', interval '0 days', true, false, true),

  -- Mobile Offshore Drilling Units (2009 MODU Code)
  ('MODU-I', 'MODU Safety - Initial Survey', '2009 MODU Code Sec. 1.6.1.1 initial survey', 'survey', 'MODU', 'I', null, null, null, true, false, false),
  ('MODU-A', 'MODU Safety - Annual Survey', '2009 MODU Code Sec. 1.6.1.4 annual survey', 'survey', 'MODU', 'A', interval '1 year', interval '3 months', interval '3 months', true, false, true),
  ('MODU-In', 'MODU Safety - Intermediate Survey', '2009 MODU Code Sec. 1.6.1.3 intermediate survey', 'survey', 'MODU', 'In', interval '5 years', interval '6 months', interval '6 months', true, false, true),
  ('MODU-P', 'MODU Safety - Periodical Survey', '2009 MODU Code Sec. 1.6.1.5 periodical survey', 'survey', 'MODU', 'P', interval '5 years', interval '6 months', interval '6 months', true, false, true),
  ('MODU-R', 'MODU Safety - Renewal Survey', '2009 MODU Code Sec. 1.6.1.2 5-year renewal survey', 'survey', 'MODU', 'R', interval '5 years', interval '3 months', interval '0 days', true, false, true),

  -- Polar Ship Certificate (Polar Code / SOLAS Ch. XIV)
  ('POLAR-I', 'Polar Ship - Initial Survey', 'Polar Code Part I-A Sec. 1.3 initial survey', 'survey', 'POLAR', 'I', null, null, null, true, false, false),
  ('POLAR-A', 'Polar Ship - Annual Survey', 'Polar Code Part I-A Sec. 1.3 annual survey', 'survey', 'POLAR', 'A', interval '1 year', interval '3 months', interval '3 months', true, false, true),
  ('POLAR-In', 'Polar Ship - Intermediate Survey', 'Polar Code Part I-A Sec. 1.3 intermediate survey', 'survey', 'POLAR', 'In', interval '5 years', interval '6 months', interval '6 months', true, false, true),
  ('POLAR-P', 'Polar Ship - Periodical Survey', 'Polar Code Part I-A Sec. 1.3 periodical survey', 'survey', 'POLAR', 'P', interval '5 years', interval '6 months', interval '6 months', true, false, true),
  ('POLAR-R', 'Polar Ship - Renewal Survey', 'Polar Code Part I-A Sec. 1.3 renewal survey', 'survey', 'POLAR', 'R', interval '5 years', interval '3 months', interval '0 days', true, false, true),

  -- Ballast Water Management (BWM Convention, Reg. E-1)
  ('BWM-I', 'Ballast Water Management - Initial Survey', 'BWM Convention Reg. E-1.1.1 initial survey', 'survey', 'BWM', 'I', null, null, null, true, true, false),
  ('BWM-A', 'Ballast Water Management - Annual Survey', 'BWM Convention Reg. E-1.1.4 annual survey', 'survey', 'BWM', 'A', interval '1 year', interval '3 months', interval '3 months', true, true, true),
  ('BWM-In', 'Ballast Water Management - Intermediate Survey', 'BWM Convention Reg. E-1.1.3 intermediate survey', 'survey', 'BWM', 'In', interval '5 years', interval '6 months', interval '6 months', true, true, true),
  ('BWM-R', 'Ballast Water Management - Renewal Survey', 'BWM Convention Reg. E-1.1.2 5-year renewal survey', 'survey', 'BWM', 'R', interval '5 years', interval '3 months', interval '0 days', true, true, true),

  -- Anti-Fouling System (AFS Convention, Annex 4 Reg. 1)
  ('AFS-I', 'Anti-Fouling System (AFS) - Initial Survey', 'AFS Convention Annex 4 Reg. 1(1)(a) initial survey', 'survey', 'AFS', 'I', null, null, null, true, true, false),

  -- Safe and Environmentally Sound Recycling of Ships (Hong Kong Convention, Reg. 10)
  ('HKC-I', 'Inventory of Hazardous Materials (HKC) - Initial Survey', 'HKC Reg. 10.1.1 initial survey', 'survey', 'RECYCL_HKC', 'I', null, null, null, true, false, false),
  ('HKC-R', 'Inventory of Hazardous Materials (HKC) - Renewal Survey', 'HKC Reg. 10.1.2 5-year renewal survey', 'survey', 'RECYCL_HKC', 'R', interval '5 years', interval '3 months', interval '0 days', true, false, true),
  ('HKC-F', 'Inventory of Hazardous Materials (HKC) - Final Survey', 'HKC Reg. 10.1.4 final survey prior to recycling', 'survey', 'RECYCL_HKC', 'F', null, null, null, true, false, false),

  -- Carriage of Dangerous Goods & INF Cargo (SOLAS Ch. II-2 Reg. 19 / Ch. VII)
  ('DG-I', 'Carriage of Dangerous Goods - Initial Survey', 'SOLAS II-2 Reg. 19 initial compliance survey', 'survey', 'DG', 'I', null, null, null, true, false, false),
  ('DG-R', 'Carriage of Dangerous Goods - Renewal Survey', 'SOLAS II-2 Reg. 19 5-year renewal survey', 'survey', 'DG', 'R', interval '5 years', interval '3 months', interval '0 days', true, false, true),
  ('INF-I', 'Carriage of INF Cargo - Initial Survey', 'INF Code Ch. 1 initial fitness survey', 'survey', 'INF', 'I', null, null, null, true, false, false),
  ('INF-R', 'Carriage of INF Cargo - Renewal Survey', 'INF Code Ch. 1 5-year renewal survey', 'survey', 'INF', 'R', interval '5 years', interval '3 months', interval '0 days', true, false, true),

  -- International Tonnage (ITC 1969)
  ('TM-I', 'International Tonnage (ITC 69) - Initial Survey', 'ITC 1969 Art. 7 initial tonnage measurement survey', 'survey', 'TM', 'I', null, null, null, true, true, false)
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  item_kind = excluded.item_kind,
  certificate_type_code = excluded.certificate_type_code,
  survey_audit_type_code = excluded.survey_audit_type_code,
  period = excluded.period,
  window_before = excluded.window_before,
  window_after = excluded.window_after,
  is_statutory = excluded.is_statutory,
  is_mandatory = excluded.is_mandatory,
  is_periodical = excluded.is_periodical;

insert into core.checklist_result (code, description) values
  ('N', 'Not inspected (item will be listed as "pending" in the Ship Status)'),
  ('PI', 'Partially inspected (item will be listed as "partially inspected" in the Ship Status)'),
  ('X', 'Inspected and found in order (or Yes if the item requires a Yes/No answer)'),
  ('D', 'Damaged and/or deficient, to be detailed in the narrative form'),
  ('R', 'Repaired, to be detailed in the narrative form'),
  ('NA', 'Not Applicable (not required by the rules or considered not necessary by the Surveyor when allowed by rules)'),
  ('NS', 'Not requested by the rules or not fitted on board'),
  ('OS', 'Out of Service (not in service)')
on conflict (code) do update set description = excluded.description;

insert into core.notation_group (group_code, group_name, description, display_order, is_prefix, min_notations, max_notations, is_active) values
  ('SYM', 'Construction Symbol', 'Construction Symbol', 1, true, 1, 1, true),
  ('MAIN', 'Main Class Notation', 'Main Class Notation', 2, false, 1, 1, true),
  ('TYPE', 'Ship Type Notation', 'Ship Type Notation', 3, false, 1, null, true),
  ('AREA', 'Sevice Area Notation', 'Navigation and service area notation', 4, false, 1, 1, true),
  ('ADD', 'Additional Notation', 'Additional Notation', 5, false, 0, null, true),
  ('STR', 'Structural Strength and Integrity', 'Related to structural strength and integrity', 6, false, 0, null, true),
  ('EFF', 'Energy Efficiency', 'Related to propulsion, power eneration and auxiliary systems', 7, false, 0, null, true),
  ('NAV', 'Navigation', 'Related to navigation and manoeuvring', 8, false, 0, null, true),
  ('CARGO', 'Cargo Operation', 'Related to cargo operation', 9, false, 0, null, true),
  ('EQU', 'Equipment and Design Features', 'Related to equipment and design feature', 10, false, 0, null, true),
  ('CLIMA', 'Climate', 'Related to climate', 11, false, 0, null, true),
  ('ENV', 'Environment', 'Related to environmental protection and pollution control', 12, false, 0, null, true),
  ('SURV', 'Survey', 'Related to survey arrangement', 13, false, 0, null, true)
on conflict (group_code) do update
  set group_name = excluded.group_name,
      description = excluded.description,
      display_order = excluded.display_order,
      is_prefix = excluded.is_prefix,
      min_notations = excluded.min_notations,
      max_notations = excluded.max_notations,
      is_active = excluded.is_active;

insert into core.flag (code, name, fullname) values
  ('PA', 'Panama', 'Republic of Panama'),
  ('LR', 'Liberia', 'Republic of Liberia'),
  ('SG', 'Singapore', 'Republic of Singapore'),
  ('MH', 'Marshall Islands', 'Republic of the Marshall Islands'),
  ('HK', 'Hong Kong', 'Hong Kong, China'),
  ('CN', 'China', 'People''s Republic of China'),
  ('BS', 'Bahamas', 'Commonwealth of The Bahamas'),
  ('MT', 'Malta', 'Republic of Malta'),
  ('CY', 'Cyprus', 'Republic of Cyprus')
on conflict (code) do update set
  name = excluded.name,
  fullname = excluded.fullname;

