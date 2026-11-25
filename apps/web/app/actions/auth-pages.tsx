/**
 * Authentication and Identity UI Pages (Facade & Re-exports)
 * Decomposed into modular page components under ./auth/pages/
 */

export {
  DevLoginPage,
  LoginPage,
  NoAccessPage,
  type DevLoginProps,
  type LoginProps,
} from './auth/pages/login.tsx'

export {
  ForgotPasswordPage,
  InvitePage,
  ResetPasswordPage,
  type ForgotPasswordProps,
  type InviteProps,
  type ResetPasswordProps,
} from './auth/pages/password.tsx'

export {
  ChooseRolePage,
  ProfilePage,
  type ChooseRoleProps,
  type ProfileIdentity,
  type ProfileProps,
} from './auth/pages/session.tsx'

export {
  MfaEnrolPage,
  MfaPage,
  StepUpPage,
  type MfaEnrolProps,
  type MfaProps,
  type StepUpProps,
} from './auth/pages/mfa.tsx'

export {
  BreakGlassPage,
  type BreakGlassProps,
} from './auth/pages/break-glass.tsx'
