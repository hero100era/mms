# ADR-0018: Delegated organisation administration (Card H-08, Q4)

- Status: proposed
- Date: 2026-11-01

## Context

Plan §7.5 currently restricts organisation maintenance (flow C) to `int_sysadmin`:
every `api.org_unit_*` and `api.org_coverage_*` function opens with
`perform private.assert_sysadmin()`. That is right for the MVP while the tree is
still being built, but Q4 asks whether a regional administrator should be able to
maintain their own part of the organisation without a sysadmin ticket.

The problem with simply relaxing the guard is that "organisation maintenance" is
not one permission. Three operations have very different blast radii:

| Operation | Effect if abused |
|---|---|
| Create a station under a regional office | Contained: the new unit is a leaf in a subtree the caller already administers |
| Move a unit to a different parent | Re-parents an entire subtree, and every role assignment scoped to it, across an administrative boundary |
| Close a unit | Withdraws an office from every workflow that routes work to it |
| Change coverage (`core.org_unit_coverage`) | Grants a multi-type team sight of another office's work |

Re-parenting is the dangerous one: it can silently move subordinates — and the
authority their positions carry — under any parent the caller names.

## Decision

Delegation is **scope-limited to the caller's own subtree**, expressed with the
mechanism the plan already uses everywhere else, not with a new role.

1. **No new database role.** The caller keeps their existing capability role
   (`int_coordinator`, `int_manager`, …). Rule 10 forbids one role per unit, and a
   delegated administrator is distinguished by *where they sit*, which is exactly
   what `iam.role_assignment.scope_unit_id` already records.

2. **Two authority actions gate the operations**, seeded in `iam.authority_rule`
   like every other regulated action:

   | action_code | db_role | unit_type | min_grade | allows |
   |---|---|---|---|---|
   | `org.unit.create` | `int_coordinator`, `int_manager` | `regional_office` | 3 | create and rename a child unit |
   | `org.unit.close` | `int_manager` | `regional_office` | 4 | close a descendant unit |

   `private.assert_authority` already matches on the caller's current position,
   family, unit type and grade, so the rules are data and changing them needs
   `security-review` rather than a deploy.

3. **The target must be inside the caller's scope.** Every delegated call runs
   `private.assert_in_scope` against the unit it touches — the parent for a
   create, the unit itself for an update or close. `assert_in_scope` resolves
   through `private.my_units()` / `private.my_offices()`, so a regional
   administrator whose assignment is scoped to one regional office can only reach
   that office and its stations.

4. **Re-parenting is not delegated.** `api.org_unit_update` keeps accepting a new
   `parent_id` only from `int_sysadmin`. A delegated caller may rename a unit and
   change its function code, but the parent must equal the current parent, or the
   call fails with `parent_change_requires_sysadmin`. Moving a subtree across
   administrative boundaries is an org-design decision, not an administrative one.

5. **Coverage and routing stay sysadmin-only.** `api.org_coverage_*` and
   `api.routing_rule_*` determine who can see whose work; a delegated
   administrator cannot widen their own reach by pointing coverage at a unit they
   do not already administer.

6. **Every delegated change is attributed the same way as a sysadmin change.**
   The existing audit capture path records the actor, the active role, the
   authority rule id and the reason; `private.set_change_context` still requires a
   reason, so a delegated create is indistinguishable in the audit trail except by
   who performed it.

## Consequences

- A regional office can be staffed and re-staffed without a sysadmin round trip,
  which was the point of Q4, while the tree's shape stays under central control.
- Two new `iam.authority_rule` rows become part of the seeded reference data and
  therefore part of authorization matrix v1 (Q1). They are illustrative until Q1
  confirms grades and unit types.
- The delegated path has more moving parts than the sysadmin path (scope check,
  authority check, parent-immutability check), so it carries its own pgTAP suite
  proving each refusal: outside scope, insufficient grade, parent change, and
  coverage escalation.
- `int_sysadmin` keeps its unconditional path, so the break-glass route from
  H-10 still works if a delegated administrator paints themselves into a corner.

## Alternatives considered

- **A dedicated `int_org_admin` role.** Rejected: it creates a role per
  administrative function and does not express *where* the administrator may act,
  so the scope check would still be needed; the role would add a second dimension
  that has to be kept in sync with positions.
- **Reuse `org.unit.changed` as the action code** for both rename and re-parent.
  Rejected: the two operations need different authority, and a single code cannot
  carry both.
- **Allow delegated re-parenting within the scope subtree.** Rejected for now: it
  is defensible once the tree is stable, but it lets an administrator restructure
  authority boundaries (a station moved under a different regional office changes
  who approves its reports) without the org-design review that currently
  accompanies such a change.
