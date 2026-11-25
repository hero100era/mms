# Default role rules

Source: implementation plan §7.5. `iam.default_role_rule` seeds this table; a test
compares the seed against these rows. `int_plan` and `int_mts` rows are deferred to
H-16/H-15 because those roles do not exist yet.

| Unit type | Family | Grade | Role | Scope |
|---|---|---|---|---|
| *any* | *any* | 0–8 | `int_viewer` | own_unit |
| station | survey | 1–3 | `int_surveyor` | own_unit |
| station | survey | 4 | `int_surveyor` | parent_unit |
| station | audit | 2–3 | `int_auditor` | own_unit |
| station | audit | 4 | `int_auditor` | parent_unit |
| station | management | 4–5 | `int_manager` | own_unit |
| station | office_admin | 2–6 | `int_coordinator` | own_unit |
| regional_office | management | 4–8 | `int_manager` | own_unit |
| regional_office | office_admin | 2–6 | `int_coordinator` | own_unit |
| plan_approval_centre | management | 4–6 | `int_manager` | own_unit |
| plan_approval_centre | office_admin | 2–4 | `int_coordinator` | own_unit |
| mts_centre | management | 4–6 | `int_manager` | own_unit |
| ho_department | compliance | 2–8 | `int_compliance` | global |
| ho_department | management | 2–8 | `int_compliance` | global |
| *any* | hr | 2–6 | `int_hr` | own_unit |
| *any* | finance | 2–6 | `int_finance` | own_unit |
| head_office | management | 6–8 | `int_manager` | global |

## Authority rules

Source: implementation plan §7.6. Only roles created in F-02 are seeded.

| Action | Role | Family | Unit type | Min grade | Limit | Qualification |
|---|---|---|---|---|---|---|
| `survey.request.triage` | `int_coordinator` | office_admin | station | 2 | — | no |
| `survey.job.assign` | `int_manager` | — | station | 4 | — | no |
| `survey.job.assign` | `int_manager` | — | regional_office | 4 | — | no |
| `survey.report.release` | `int_surveyor` | survey | station | 2 | — | yes |
| `survey.report.countersign` | `int_surveyor` | survey | station | 3 | — | yes |
| `audit_trail.report.release` | `int_auditor` | audit | station | 2 | — | yes |
| `compliance.finding.raise` | `int_compliance` | compliance | ho_department | 2 | — | no |
| `compliance.record.hold` | `int_compliance` | compliance | ho_department | 3 | — | no |
| `billing.credit_note.approve` | `int_finance` | finance | — | 4 | 10,000 USD | no |
| `billing.credit_note.approve` | `int_finance` | finance | — | 6 | unlimited | no |
| `hr.position.set` | `int_hr` | hr | — | 3 | — | no |
| `iam.external_user.create` | `int_coordinator` | office_admin | — | 2 | — | no |
| `audit_trail.trail.read` | `int_compliance` | — | — | 2 | — | no |
| `audit_trail.trail.read` | `int_manager` | — | — | 4 | — | no |
| `plan.submission.reroute` | `int_manager` | — | plan_approval_centre | 4 | — | no |
| `org.unit.create` | `int_coordinator` | — | regional_office | 3 | — | no |
| `org.unit.create` | `int_manager` | — | regional_office | 3 | — | no |
| `org.unit.close` | `int_manager` | — | regional_office | 4 | — | no |
