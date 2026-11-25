import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  formatSecretForDisplay,
  generateTotpSecret,
  totpCode,
} from './index.ts'

// RFC 4648 section 10 test vectors for base32 (without padding).
test('base32Encode matches RFC 4648', () => {
  assert.equal(base32Encode(Buffer.from('')), '')
  assert.equal(base32Encode(Buffer.from('f')), 'MY')
  assert.equal(base32Encode(Buffer.from('fo')), 'MZXQ')
  assert.equal(base32Encode(Buffer.from('foo')), 'MZXW6')
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI')
})

test('base32Decode round-trips and ignores grouping', () => {
  let bytes = Buffer.from('12345678901234567890', 'ascii')
  assert.equal(base32Decode(base32Encode(bytes)).toString('ascii'), '12345678901234567890')
  assert.equal(
    base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').toString('ascii'),
    '12345678901234567890',
  )
})

test('generateTotpSecret produces 160 bits of base32', () => {
  let secret = generateTotpSecret()
  assert.equal(secret.length, 20)
  assert.equal(base32Encode(secret).length, 32)
})

// RFC 6238 appendix B, SHA-1 rows. The appendix prints eight digits; the last six are
// the ones a six-digit authenticator app shows.
test('totpCode matches RFC 6238 appendix B', () => {
  let key = Buffer.from('12345678901234567890', 'ascii')
  let vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ]
  for (let [time, expected] of vectors) {
    assert.equal(totpCode(key, Math.floor(time / 30)), String(expected).slice(-6))
  }
})

test('buildOtpauthUri carries the base32 secret and the standard parameters', () => {
  let uri = buildOtpauthUri({ secret: 'MZXW6YTBOI', accountName: 'a@b.com' })
  assert.equal(
    uri,
    'otpauth://totp/MMS%3Aa%40b.com?secret=MZXW6YTBOI&issuer=MMS&algorithm=SHA1&digits=6&period=30',
  )
})

test('formatSecretForDisplay groups the key in fours for manual entry', () => {
  assert.equal(formatSecretForDisplay('ABCDEFGHIJKLMNOP'), 'ABCD EFGH IJKL MNOP')
  assert.equal(formatSecretForDisplay('ABCD'), 'ABCD')
})
