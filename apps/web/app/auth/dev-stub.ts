// T7 & R8.6: Development auth stubs and unsafe test switches must NEVER be reachable in production.

export function isDevLoginAllowed(): boolean {
  let appEnv = (process.env.APP_ENV ?? 'local').toLowerCase().trim()
  let nodeEnv = (process.env.NODE_ENV ?? 'development').toLowerCase().trim()
  let isProd = appEnv === 'production' || nodeEnv === 'production'
  let allowSwitch = process.env.ALLOW_DEV_LOGIN === 'true' || process.env.ALLOW_DEV_LOGIN === '1'
  return !isProd && ['local', 'test'].includes(appEnv) && allowSwitch
}

export function assertDevAuthAllowed(): void {
  let appEnv = (process.env.APP_ENV ?? '').toLowerCase().trim()
  let nodeEnv = (process.env.NODE_ENV ?? '').toLowerCase().trim()
  let isProduction = appEnv === 'production' || nodeEnv === 'production'

  if (isProduction) {
    if (process.env.ALLOW_DEV_LOGIN === 'true' || process.env.ALLOW_DEV_LOGIN === '1') {
      throw new Error('ALLOW_DEV_LOGIN is strictly prohibited in production')
    }
    if (process.env.ALLOW_TEST_SCANNER === 'true' || process.env.ALLOW_TEST_SCANNER === '1') {
      throw new Error('ALLOW_TEST_SCANNER is strictly prohibited in production')
    }
    if (process.env.ALLOW_TEST_STORAGE === 'true' || process.env.ALLOW_TEST_STORAGE === '1') {
      throw new Error('ALLOW_TEST_STORAGE is strictly prohibited in production')
    }
    if (process.env.MMS_AUTH_STUB === '1') {
      throw new Error('MMS_AUTH_STUB is not allowed in production')
    }
    return
  }

  if (process.env.MMS_AUTH_STUB !== '1') return

  let host = process.env.HOST ?? '127.0.0.1'
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`MMS_AUTH_STUB is not allowed on host ${host}`)
  }
}
