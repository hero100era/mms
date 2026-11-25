import { randomBytes } from 'node:crypto'
import { createCookie } from 'remix/cookie'

import { DbSessionStorage } from './session-storage.ts'

// Outside production a missing secret gets a fresh per-process value, not a
// published constant: a well-known secret would let anyone forge a session
// cookie locally. Production fails closed instead.
let devSessionSecret: string | undefined

function sessionSecret(): string {
  let secret = process.env.MMS_SESSION_SECRET
  if (secret) return secret
  if (process.env.NODE_ENV === 'production') {
    throw new Error('MMS_SESSION_SECRET is required in production')
  }
  return (devSessionSecret ??= randomBytes(32).toString('hex'))
}

export let sessionCookie = createCookie('__mms_sid', {
  secrets: [sessionSecret()],
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  maxAge: 12 * 60 * 60,
})

export let sessionStorage = new DbSessionStorage()
