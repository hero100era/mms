import { createRouter, type Middleware, type RouterContext } from 'remix/router'
import { cop } from 'remix/middleware/cop'
import { csrf } from 'remix/middleware/csrf'
import { formData } from 'remix/middleware/form-data'
import { logger } from 'remix/middleware/logger'
import { render } from 'remix/middleware/render'
import { session } from 'remix/middleware/session'
import { staticFiles } from 'remix/middleware/static'

import rootController from './actions/controller.tsx'
import sessionController from './actions/session/controller.tsx'
import identityController from './actions/identity/controller.tsx'
import authController from './actions/auth/controller.tsx'
import mfaController from './actions/mfa/controller.tsx'
import breakGlassController from './actions/break-glass/controller.tsx'
import adminController from './actions/admin/controller.tsx'
import adminProposalsController from './actions/admin/proposals/controller.tsx'
import adminExternalUsersController from './actions/admin/external-users/controller.tsx'
import uploadsController from './actions/uploads/controller.tsx'
import surveyController from './actions/survey/controller.tsx'
import triageController from './actions/triage/controller.tsx'
import { assets } from './assets.ts'
import { assertDevAuthAllowed } from './auth/dev-stub.ts'
import { sessionCookie, sessionStorage } from './auth/session-cookie.ts'
import { isQuarantineUpload } from './csrf-exemption.ts'
import { ValidationError } from './actions/validation.ts'
import { actionProblemResponse, isJsonOrProblemRequest } from './actions/errors.ts'
import { pgrst } from './middleware/pgrst.ts'
import { requireBreakGlass } from './middleware/require-break-glass.ts'
import { requireMfa } from './middleware/require-mfa.ts'
import { requestContext } from './middleware/request-context.ts'
import { contentSecurityPolicy, securityHeaders } from './middleware/security-headers.ts'
import { sessionAuth } from './middleware/session-auth.ts'
import { bodyLimits, MAX_FORM_BODY_BYTES } from './middleware/body-limits.ts'
import { routes } from './routes.ts'

assertDevAuthAllowed()

export const router = createRouter({
  middleware: [
    requestContext(),
    logger({ format: '%method %path %status %duration' }),
    securityHeaders(),
    contentSecurityPolicy(),
    staticFiles('./public', { index: false }),
    async (context, next) => {
      try {
        return await next()
      } catch (err) {
        if (err instanceof Response) {
          if (!err.headers.has('Cache-Control') && !context.url.pathname.startsWith('/assets') && context.url.pathname !== '/.well-known/jwks.json') {
            err.headers.set('Cache-Control', 'no-store')
          }
          return err
        }
        if (err instanceof ValidationError) {
          if (isJsonOrProblemRequest(context.request)) {
            return actionProblemResponse(context, err)
          }
          return new Response(err.message, {
            status: 422,
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              'Cache-Control': 'no-store',
            },
          })
        }
        throw err
      }
    },
    cop(),
    session(sessionCookie, sessionStorage),
    bodyLimits(),
    formData({ maxParts: 100, maxTotalSize: MAX_FORM_BODY_BYTES, maxFiles: 0 }),
    (() => {
      let defaultCsrf = csrf()
      let mw: Middleware = (context, next) => {
        // The quarantine upload is the ONLY leaf served without a CSRF token: the
        // browser PUTs directly to storage through a write-only SAS; there is no form
        // and no session to bind a token to. The predicate below derives from the
        // declared route, never from a hand-written prefix.
        if (isQuarantineUpload(context.url, context.request.method)) {
          return next()
        }
        return defaultCsrf(context, next)
      }
      return mw
    })(),
    render({ assets }),
    sessionAuth(),
    requireMfa(),
    requireBreakGlass(),
    pgrst(),
  ],
})

export type AppContext = RouterContext<typeof router>

declare module 'remix' {
  interface RouterTypes {
    context: AppContext
  }
}

router.map(routes, rootController)
router.map(routes.session, sessionController)
router.map(routes.identity, identityController)
router.map(routes.auth, authController)
router.map(routes.mfa, mfaController)
router.map(routes.breakGlass, breakGlassController)
router.map(routes.admin, adminController)
router.map(routes.admin.proposals, adminProposalsController)
router.map(routes.admin.externalUsers, adminExternalUsersController)
router.map(routes.uploads, uploadsController)
router.map(routes.survey, surveyController)
router.map(routes.triage, triageController)
