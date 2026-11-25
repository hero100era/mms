import { AuthKey, type SessionAuth } from '../auth/context.ts'

export function sessionAuth() {
  return async (context: any, next: () => Promise<Response>) => {
    let auth = context.session.get('auth') as SessionAuth | undefined
    context.set(AuthKey, auth ?? null)
    return next()
  }
}
