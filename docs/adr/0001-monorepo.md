# ADR-0001: npm workspaces monorepo

- Status: accepted
- Date: 2026-10-30

## Context

The application needs a web BFF, shared domain code, database assets and infrastructure assets that change together. The starter is a single npm package at the repository root. pnpm was considered, but the project will use npm.

## Decision

Use an **npm workspaces** monorepo:

- `apps/web` — the Remix application, and the only deployable workspace.
- `packages/*` — framework-agnostic libraries.
- `db/` and `infra/` — data and infrastructure assets, not workspaces.

The root `package.json` is private, declares the workspaces, owns the shared scripts and commits `package-lock.json`. `apps/web` keeps its own manifest and the starter scripts; root scripts delegate to it.

## Consequences

- One lockfile and one install at the root.
- The app can import shared packages without publishing them.
- `db/` and `infra/` scripts run from the root but are not npm packages.
- Adding a new package means adding its manifest and workspace entry.
