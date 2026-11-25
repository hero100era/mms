# ADR-0003: psqldef spike

- Status: superseded by ADR-0010
- Date: 2026-10-30

## Context

An earlier spike evaluated `psqldef` as the schema diff tool. It did not cover the object types and review controls the plan needs.

## Decision

The psqldef approach is abandoned. ADR-0010 records the replacement decision (pgschema) and the spike results that justify it.

## Consequences

This ADR is kept for history. Do not add new psqldef configuration, tolerated-drift files or generated artefacts.
