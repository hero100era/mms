# ADR-0031: Storage Path Terminology

## Status
Proposed
- Date: 2026-11-18

## Context
The codebase uses inconsistent terminology to refer to file paths in storage (`storagePath`, `quarantinePath`, `storage_path`, etc.). This causes ambiguity, especially in functions that handle both quarantined and promoted files, making the code harder to reason about.

## Decision
We will standardize on the following terminology:
1. `storagePath`: The general term for any path in our `FileStorage` backend.
2. `quarantinePath`: A path that specifically points to a file within the quarantine area (`quarantine/` prefix).
3. `promotedPath`: A path that specifically points to a file within the promoted/permanent storage area (`documents/` prefix).

Functions should use these terms explicitly in their arguments and documentation to clarify the expected path type.

## Consequences
- Improved code readability and reduced ambiguity.
- Easier enforcement of RLS/security policies based on storage path prefixes.
- Some refactoring effort required to update function signatures and variables.
