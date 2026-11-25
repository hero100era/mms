# ADR-0002: Remix version 3.3.0

- Status: accepted
- Date: 2026-10-30

## Context

Remix v3 changed import paths during 2026, and the plan depends on specific auth, session and middleware APIs. A range such as `^3.3.0` can silently move those APIs.

## Decision

Pin `remix` to exactly **3.3.0** in `apps/web/package.json` and the lockfile. The installed package is canonical: read `node_modules/remix/INDEX.md`, its guides and the package READMEs before using an API. `api.remix.run` is a secondary reference only.

Version bumps are their own PR, with the F-03 spike suite and the relevant auth/session tests re-run.

## Consequences

- Reproducible installs and documentation that matches the code.
- Security and bug fixes require an explicit version bump rather than a range update.
- Agents must not assume an online API exists in the pinned release.

## Version history

- **2026-10-30 — 3.1.0.** Initial exact pin for F-01. Removed the `^` range so auth, session and middleware imports cannot drift.
- **2026-11-05 — 3.2.0.** Minor release (no breaking router/auth/session API). Adds `csp()` from `remix/middleware/csp` plus `remix/headers/content-security-policy`, bumps ~30 `@remix-run/*` sub-packages, and changes `css()` serialization (unitless numbers, custom-property casing, vendor prefixes, generated `rmxc-*` class names). Verified by re-running the F-03 spike suite, the full `npm run check`, the pgTAP suites, `db:check` C1/C3/C5 and `remix doctor`. The registry mirror lagged some 3.2.0 sub-package tarballs, so the lockfile was resolved against `registry.npmjs.org`.
- **2026-11-20 — 3.3.0.** Minor release (no breaking router/auth/session API). Bumps `@remix-run/*` packages (adds `@remix-run/terminal`, `@remix-run/html-template`). Verified by `remix doctor` (0 warnings, 0 advice), `check:boundary`, `typecheck`, and application test suites.

The pin stays exact (`3.3.0`, not `^3.3.0`): the whole point of this ADR is that a range would silently move the APIs the plan depends on.
