# ADR-0025: MMS application shell, design system and CSP nonce-only styles (R1.3, R5.1, R5.2)

- Status: proposed
- Date: 2026-11-06

## Context

`docs/plans/rectification-implementation-plan.md` R5.1 removes the Remix starter surface and replaces
it with an MMS dashboard shell; R5.2 defines a design system with WCAG 2.2 AA,
keyboard access, visible focus, correct label/error association and responsive
layout down to 320 CSS px. R1.3 requires `unsafe-inline` to be absent unless a
documented Remix limitation requires a temporary, security-reviewed exception.

The R1.3 implementation installed a strict nonce-based CSP, but retained
`style-src-attr 'unsafe-inline'` because 367 authored `style="…"` attributes
exist across the admin/survey/auth pages. Remix 3.2.0's `css()` mixin emits
`<style data-rmx-style>` elements that `render()` stamps with the request nonce;
CSP nonces do not apply to style attributes, so those attributes cannot be
covered by a nonce.

## Decisions

1. **Shell.** The home page becomes a server-rendered, progressively enhanced
   dashboard: a page shell, primary navigation, headings/sections and status
   badges. Navigation is derived from the authenticated session's active role and
   the existing `routes.ts` contract; no raw role codes are shown as primary
   labels. No new routing convention.
2. **Styling.** New and rewritten pages use `css()` mixins exclusively; no inline
   `style` attributes. A shared set of style tokens (surface, text, status) lives
   in one module so colours are never the only signal.
3. **CSP exception removal.** Once every page reachable from the shell was free of
   inline style attributes, `styleSrcAttr` was removed from
   `apps/web/app/middleware/security-headers.ts` in Phase R5.2. A test asserts the policy
   contains no `unsafe-inline` at all. The temporary exception has been retired.
4. **Accessibility.** Visible focus, labelled form fields, error association,
   empty states, and a 320 px layout are acceptance criteria for R5.2; they are
   not retrofitted silently into unrelated pages during R5.1.

## Consequences

- Converting all 367 inline style attributes is a large mechanical refactor with
  visual-regression risk; it should be a dedicated R5.2 task card, not bundled
  into a security fix.
- The starter `PromptButton` browser island and Remix/Shopify/Discord/AI content
  are removed in R5.1. Removing the island changes the browser asset graph, so
  `npm run check:boundary` and `remix doctor` must be re-run.

## Review

Requires human approval of the shell's navigation/authorization model and
security-review sign-off on the temporary CSP exception or on its removal.
