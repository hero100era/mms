import crypto from 'node:crypto'

// RFC 4648 base32, the encoding authenticator apps expect for a manually entered key.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export const SECRET_BYTES = 20
export const DIGITS = 6
export const PERIOD_SECONDS = 30

export function base32Encode(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (let byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  let clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  let out: number[] = []
  for (let ch of clean) {
    let index = ALPHABET.indexOf(ch)
    if (index < 0) throw new Error('invalid base32')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function generateTotpSecret(): Buffer {
  return crypto.randomBytes(SECRET_BYTES)
}

export function buildOtpauthUri(options: { secret: string; accountName: string; issuer?: string }): string {
  let issuer = options.issuer ?? 'MMS'
  let label = encodeURIComponent(`${issuer}:${options.accountName}`)
  let params = new URLSearchParams({
    secret: options.secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

export function formatSecretForDisplay(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(' ') ?? secret
}

export function totpCode(secret: Buffer, step: number): string {
  let counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  let mac = crypto.createHmac('sha1', secret).update(counter).digest()
  let offset = mac[mac.length - 1] & 15
  let binary = ((mac[offset] & 127) << 24) | ((mac[offset + 1] & 255) << 16) | ((mac[offset + 2] & 255) << 8) | (mac[offset + 3] & 255)
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0')
}
