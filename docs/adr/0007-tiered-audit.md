# ADR-0007: tiered audit

- Status: accepted
- Date: 2026-10-30

## Context

Auditing every read would produce a large, low-value log and a privacy burden. Auditing too little would make regulated changes unattributable.

## Decision

Use two audit tiers:

- **Tier 1 (required before production):** authentication events, role and authority changes, regulated state transitions, access to sensitive records, and administrative actions. Tier 1 writes are transactional with the change and record the actor as `iam.app_user.id`.
- **Tier 2 (before production where the data model supports it):** read access to sensitive records and other high-volume events. Tier 2 may be asynchronous but must preserve actor, subject, timestamp and request correlation.

Every audited write carries a transaction identifier from day one so Tier 2 can be correlated later without a schema change.

## Consequences

- Tier 1 is part of the same transaction as the change it records.
- Tier 2 is allowed to lag but must not lose the actor or correlation id.
- Retention and access to audit data need their own review.
