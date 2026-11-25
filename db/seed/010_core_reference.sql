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
  ('E', 'In Service'),
  ('L', 'Laid Up'),
  ('P', 'Withdrawn')
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
  ('B', 'Before Due Date')
on conflict (code) do update set name = excluded.name;

insert into core.comment_type (code, name) values
  ('M', 'Memorandum'),
  ('C', 'Class Condition'),
  ('S', 'Statutory Condition'),
  ('N', 'Non-conformity'),
  ('D', 'Deficiency'),
  ('O', 'Observation'),
  ('R', 'Retroactive Requirement')
on conflict (code) do update set name = excluded.name;

insert into core.comment_status (code, name) values
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

insert into core.certificate_survey_pool (code, description) values
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
  ('B', 'Inspection of the outside of the ship''s bottom (DRY)'),
  ('W', 'Inspection of the outside of the ship''s bottom (IWS)'),
  ('T', 'Tailshaft Survey'),
  ('T1', 'Tailshaft Survey(No.1)'),
  ('T2', 'Tailshaft Survey(No.2)'),
  ('T3', 'Tailshaft Survey(No.3)'),
  ('T4', 'Tailshaft Survey(No.4)'),
  ('T5', 'Tailshaft Survey(No.5)'),
  ('T6', 'Tailshaft Survey(No.6)'),
  ('Bo', 'Boiler Survey'),
  ('Bo1', 'Boiler Survey(No.1)'),
  ('Bo2', 'Boiler Survey(No.2)'),
  ('Bo3', 'Boiler Survey(No.3)'),
  ('Bo4', 'Boiler Survey(No.4)'),
  ('Bo5', 'Boiler Survey(No.5)'),
  ('Bo6', 'Boiler Survey(No.6)'),
  ('BOT', 'Bottom survey'),
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

