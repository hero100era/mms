import { get, post, put, route } from 'remix/routes'

/**
 * The URL contract, grouped by the controller that owns each group.
 *
 * A nested map in Remix is its own contract: `routes.admin` is served by
 * `actions/admin/controller.tsx`, `routes.mfa.challenge` by `actions/mfa/controller.tsx`, and so on --
 * and `createController` refuses an action for a leaf its map does not own. Two controllers
 * therefore never share one map, which is why every leaf below sits in the group whose
 * controller serves it rather than in one flat object. `app/router.ts` maps each group once,
 * so the ownership check is total at startup instead of "whichever controller registered
 * first".
 *
 * `href()` is unchanged by nesting; only the property path gets longer:
 *
 *   routes.mfa.challenge.href()                         // /mfa
 *   routes.admin.proposals.confirm.href()           // /admin/proposals/confirm
 *   routes.session.identity.unlink.href()           // /profile/identities/unlink
 *
 * A leaf that is a page and an action at the same URL stays one route in its group: `mfa`
 * and `stepUp` carry both the GET (`index`/`enrol`) and the POST (`submit`), so the two
 * methods share a path without needing two groups.
 */
export const routes = route({
  assets: get('/assets/*path'),
  // Public half only (ADR-0004): PostgREST refreshes its verifier from here, so it
  // must be reachable without a session and must never include private material.
  jwks: get('/.well-known/jwks.json'),

  // The root controller: the shell pages and the staff/password sign-in surface.
  session: {
    home: get('/'),
    login: get('/login'),
    loginDev: post('/login/dev'),
    devLogin: get('/dev/login'),
    devLoginSubmit: post('/dev/login'),
    loginPassword: post('/login/password'),
    logout: post('/logout'),
    chooseRole: get('/choose-role'),
    noAccess: get('/no-access'),
    sessionRole: post('/session/role'),
    profile: get('/profile'),
    devMailbox: get('/dev/mailbox'),

    // Credential recovery (I-09).
    forgotPassword: get('/forgot-password'),
    forgotPasswordSubmit: post('/forgot-password'),
    resetPassword: get('/reset-password/:token'),
    resetPasswordSubmit: post('/reset-password/:token'),

    // Self-service sessions (I-09).
    profileSessionRevoke: post('/profile/sessions/revoke'),
    profileSessionRevokeAll: post('/profile/sessions/revoke-all'),
  },

  // Identity linking (I-08, flow E) and the invitations that feed it.
  identity: {
    linkInvite: post('/invite/:token/link/:provider'),
    link: post('/profile/identities/link/:provider'),
    unlink: post('/profile/identities/unlink'),
    invite: get('/invite/:token'),
    accept: post('/invite/:token'),
  },

  // Staff sign-in via the external provider, and the round trip back (flow A).
  auth: {
    start: get('/auth/microsoft/start'),
    callback: get('/auth/microsoft/callback'),
    googleStart: get('/auth/google/start'),
    googleCallback: get('/auth/google/callback'),
  },

  // The second factor (H-09) and the step-up that destructive actions require.
  mfa: {
    challenge: get('/mfa'),
    submit: post('/mfa'),
    enrol: get('/mfa/enrol'),
    enrolSubmit: post('/mfa/enrol'),
    stepUp: get('/step-up'),
    stepUpSubmit: post('/step-up'),
    stepUpOAuth: post('/step-up/oauth/:provider'),
  },

  // Break-glass (H-10): the identity signs in dormant and must state a reason before any
  // other page is reachable; activation itself is the POST that creates the window.
  breakGlass: {
    index: get('/break-glass'),
    activate: post('/break-glass/activate'),
    deactivate: post('/break-glass/deactivate'),
  },

  // Organisation and role administration (I-06, H-08, H-13).
  admin: {
    positions: get('/admin/positions'),
    positionSet: post('/admin/positions/set'),
    assignments: get('/admin/assignments'),
    assignmentGrant: post('/admin/assignments/grant'),
    assignmentRevoke: post('/admin/assignments/revoke'),
    proposals: {
      index: get('/admin/proposals'),
      confirm: post('/admin/proposals/confirm'),
      reject: post('/admin/proposals/reject'),
    },
    externalUsers: {
      index: get('/admin/external-users'),
      create: post('/admin/external-users/create'),
      invite: post('/admin/external-users/invite'),
    },
  },

  // Uploads (S-03, H-05). `quarantine` is the one leaf served without a CSRF token: the
  // browser PUTs straight to storage through a write-only SAS, so there is no form and no
  // same-origin page to bind a token to. The exemption is derived from THIS leaf by
  // `app/csrf-exemption.ts`, never from a hand-written path prefix, so renaming the route
  // cannot silently move or widen the exemption.
  uploads: {
    prepare: post('/api/uploads/prepare'),
    quarantine: put('/uploads/quarantine/:uploadId'),
    finalize: post('/api/uploads/finalize'),
    promote: post('/api/uploads/promote/:versionId'),
    scan: post('/api/uploads/scan/:versionId'),
    documentDownload: get('/documents/:documentId/versions/:versionId/download'),
  },

  // Fleet / vessel register and particulars.
  ships: {
    index: get('/ships'),
    detail: get('/ships/:id'),
  },

  // SLICE-01: the external survey request and the station triage queue.
  survey: {
    index: get('/surveys'),
    new: get('/surveys/new'),
    create: post('/surveys/create'),
    detail: get('/surveys/:id'),
    submit: post('/surveys/:id/submit'),
  },
  triage: {
    queue: get('/triage'),
    detail: get('/triage/:id'),
    accept: post('/triage/:id/accept'),
    clarify: post('/triage/:id/clarify'),
    reject: post('/triage/:id/reject'),
    transfer: post('/triage/:id/transfer'),
  },
})
