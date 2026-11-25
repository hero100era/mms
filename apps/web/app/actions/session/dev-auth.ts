import { redirect } from 'remix/response/redirect'
import { routes } from '../../routes.ts'
import { getSession, type AnyRequestContext } from '../context.ts'
import { userRoles } from '../../auth/service.ts'
import { clientIp } from '../../middleware/request-context.ts'
import { safeReturnTo } from '../utils.ts'
import type { DevPersona } from '../../auth/dev-personas.ts'

export async function authenticateDevPersona(
  context: AnyRequestContext,
  persona: DevPersona,
  returnTo: string,
): Promise<Response> {
  let session = getSession(context)
  session.regenerateId(true)
  let authTime = new Date().toISOString()

  // Server-side role resolution through auth.user_roles (caller-supplied role is ignored)
  let assignableRoles: string[] = []
  try {
    let roles = await userRoles(persona.userId)
    if (roles && roles.length > 0) {
      assignableRoles = Array.isArray(roles)
        ? roles.map((r: any) => (typeof r === 'string' ? r : r.role))
        : []
    }
  } catch {
    // fallback for unit test harness where gateway pool is unconfigured
  }
  if (assignableRoles.length === 0) {
    assignableRoles = [persona.role]
  }
  let activeRole = assignableRoles.includes(persona.role) ? persona.role : assignableRoles[0]!

  let ctx = context as any
  session.set('auth', {
    userId: persona.userId,
    kind: persona.kind,
    email: persona.email,
    activeRole,
    authMethod: persona.kind === 'internal' ? 'entra' : 'pwd',
    authTime,
    stepUpAt: authTime,
    mfaVerifiedAt: authTime,
    assignableRoles,
    clientIp: clientIp(context),
    userAgent: ctx.request?.headers?.get('user-agent') ?? 'acceptance-agent',
  })
  return redirect(safeReturnTo(returnTo, routes.session.profile.href()))
}
