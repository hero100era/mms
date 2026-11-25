import * as crypto from 'node:crypto'
import * as util from 'node:util'

const argon2Async = util.promisify(crypto.argon2)

const MIN_LENGTH = 12
const MAX_LENGTH = 128

// Common passwords blocklist (case-insensitive check)
const BLOCKLIST = new Set([
  '123456789012',
  'password1234',
  'password12345',
  'qwertyuiop12',
  'admin1234567',
  'welcome12345',
  'letmein12345',
  'changeme1234',
  'iloveyou1234',
  'monkey123456',
  'dragon123456',
  'master123456',
  'sunshine1234',
  'princess1234',
  'football1234',
  'shadow123456',
])

export function validatePassword(password: string): { valid: boolean; error?: string } {
  if (!password || password.length < MIN_LENGTH) {
    return { valid: false, error: `Password must be at least ${MIN_LENGTH} characters.` }
  }
  if (password.length > MAX_LENGTH) {
    return { valid: false, error: `Password cannot exceed ${MAX_LENGTH} characters.` }
  }
  if (BLOCKLIST.has(password.toLowerCase())) {
    return { valid: false, error: 'That password is too common or easily guessed.' }
  }
  return { valid: true }
}

const DEFAULT_MEMORY = 19456
const DEFAULT_PASSES = 2
const DEFAULT_PARALLELISM = 1
const DEFAULT_TAG_LENGTH = 32

export async function hashPassword(password: string): Promise<string> {
  let nonce = crypto.randomBytes(16)
  let derived = await argon2Async('argon2id', {
    message: password,
    nonce,
    parallelism: DEFAULT_PARALLELISM,
    tagLength: DEFAULT_TAG_LENGTH,
    memory: DEFAULT_MEMORY,
    passes: DEFAULT_PASSES,
  })
  return `$argon2id$v=19$m=${DEFAULT_MEMORY},t=${DEFAULT_PASSES},p=${DEFAULT_PARALLELISM}$${nonce.toString('base64url')}$${derived.toString('base64url')}`
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (!encoded || !encoded.startsWith('$argon2id$')) {
    return false
  }
  try {
    let parts = encoded.split('$')
    // parts[0] is "", parts[1] is "argon2id", parts[2] is "v=19", parts[3] is "m=...,t=...,p=...", parts[4] is nonce, parts[5] is key
    if (parts.length !== 6 || parts[2] !== 'v=19') return false
    let params = parts[3]!
    let mMatch = params.match(/m=(\d+)/)
    let tMatch = params.match(/t=(\d+)/)
    let pMatch = params.match(/p=(\d+)/)
    if (!mMatch || !tMatch || !pMatch) return false
    let memory = Number(mMatch[1])
    let passes = Number(tMatch[1])
    let parallelism = Number(pMatch[1])
    if (
      !Number.isInteger(memory) || memory < 19456 || memory > 262144 ||
      !Number.isInteger(passes) || passes < 1 || passes > 10 ||
      !Number.isInteger(parallelism) || parallelism < 1 || parallelism > 4
    ) {
      return false
    }
    let nonce = Buffer.from(parts[4]!, 'base64url')
    let expectedKey = Buffer.from(parts[5]!, 'base64url')
    if (nonce.length < 8 || expectedKey.length < 16 || expectedKey.length > 64) {
      return false
    }

    let derived = await argon2Async('argon2id', {
      message: password,
      nonce,
      parallelism,
      tagLength: expectedKey.length,
      memory,
      passes,
    })
    return crypto.timingSafeEqual(expectedKey, derived)
  } catch {
    return false
  }
}

// Process-stable precomputed dummy hash generated once at module load with production argon2id parameters
export const DUMMY_HASH: string = await hashPassword('mms-process-stable-dummy-password-timing-mitigation')

/**
 * Verifies submitted password against a process-stable dummy hash to equalize timing.
 */
export async function dummyVerifyPassword(password: string = 'dummy-password'): Promise<boolean> {
  return verifyPassword(password, DUMMY_HASH)
}

export function validateToken(token: string): boolean {
  return /^[0-9a-z-]+$/i.test(token)
}
