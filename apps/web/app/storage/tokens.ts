import * as crypto from 'node:crypto'
import { getAzureStorageHelper, getMaxUploadBytesForDocType } from './config.ts'
import { sanitizeFileName } from './sniff.ts'

// A per-process fallback, never a published constant: these tokens authorise a
// write into quarantine without a session, so a well-known key would let anyone
// forge one. Production must always supply MMS_UPLOAD_SECRET explicitly.
let devUploadSecret: string | undefined

/**
 * Upload tokens authorise a write into quarantine without a session, so the
 * signing key must never be a published constant outside development. A missing
 * key in production is a startup error, not a silently weak default.
 */
function uploadTokenSecretValue(): string {
  let secret = process.env.MMS_UPLOAD_SECRET
  if (secret) return secret
  if (process.env.NODE_ENV === 'production' || process.env.MMS_FORCE_PROD_STORAGE === '1') {
    throw new Error('MMS_UPLOAD_SECRET is required in production')
  }
  return (devUploadSecret ??= crypto.randomBytes(32).toString('hex'))
}

/**
 * Signs a short-lived direct upload token for dev / test / fallback upload URLs.
 *
 * ADR-0023 §6: the token binds the upload id to the destination it was issued
 * for — sanitized filename, entity, document type, expiry and maximum size —
 * not just to the id and an expiry. Fields are length-prefixed so no combination
 * of values can be re-split into a different tuple that produces the same input.
 */
export interface UploadTokenClaims {
  uploadId: string
  fileName: string
  entityType: string
  entityId: string
  docType: string
  expiresAtMs: number
  maxBytes: number
}

function canonicalTokenInput(claims: UploadTokenClaims): string {
  let fields = [
    claims.uploadId,
    claims.fileName,
    claims.entityType,
    claims.entityId,
    claims.docType,
    String(claims.expiresAtMs),
    String(claims.maxBytes),
  ]
  return fields.map((field) => `${field.length}:${field}`).join('|')
}

export function signUploadToken(claims: UploadTokenClaims): string {
  let hmac = crypto.createHmac('sha256', uploadTokenSecretValue())
  hmac.update(canonicalTokenInput(claims))
  return hmac.digest('hex')
}

/**
 * Validates a direct upload token against the claims it was issued for.
 * Fails closed on expiry, on any bound-field mismatch, and on a malformed token.
 */
export function verifyUploadToken(claims: UploadTokenClaims, token: string): boolean {
  if (!token) return false
  if (!Number.isFinite(claims.expiresAtMs) || Date.now() > claims.expiresAtMs) return false
  if (!claims.uploadId) return false
  let expected = signUploadToken(claims)
  let a = Buffer.from(token)
  let b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export interface PrepareUploadResult {
  uploadId: string
  quarantinePath: string
  uploadUrl: string
  expiresAt: string
  writeOnly: boolean
}

/**
 * Prepares an upload destination in quarantine and generates a short-lived write-only SAS or signed upload URL.
 */
export async function prepareQuarantineUpload(params: {
  entityType: string
  entityId: string
  docType: string
  fileName: string
  expiresInMinutes?: number
  baseUrl?: string
  maxBytes?: number
}): Promise<PrepareUploadResult> {
  let uploadId = crypto.randomUUID()
  let safeName = sanitizeFileName(params.fileName)
  let quarantinePath = `quarantine/${uploadId}/${safeName}`
  let expiresInMinutes = params.expiresInMinutes ?? 15
  let expiresAtMs = Date.now() + expiresInMinutes * 60 * 1000
  let expiresAt = new Date(expiresAtMs).toISOString()
  let maxBytes = params.maxBytes ?? getMaxUploadBytesForDocType(params.docType)

  let uploadUrl: string
  let claims: UploadTokenClaims = {
    uploadId,
    fileName: safeName,
    entityType: params.entityType,
    entityId: params.entityId,
    docType: params.docType,
    expiresAtMs,
    maxBytes,
  }
  let azureStorageHelper = getAzureStorageHelper()
  if (azureStorageHelper) {
    // Generate real Azure Blob write-only SAS URL (sp=c)
    let sas = azureStorageHelper.generateWriteOnlySasUrl({
      blobName: quarantinePath,
      expiresInMinutes,
      permissions: 'c', // write-only (create)
    })
    uploadUrl = sas.url
  } else {
    // Local / Dev signed upload endpoint
    let token = signUploadToken(claims)
    let base = (params.baseUrl || '').replace(/\/$/, '')
    uploadUrl =
      `${base}/uploads/quarantine/${uploadId}` +
      `?fileName=${encodeURIComponent(safeName)}` +
      `&entityType=${encodeURIComponent(params.entityType)}` +
      `&entityId=${encodeURIComponent(params.entityId)}` +
      `&docType=${encodeURIComponent(params.docType)}` +
      `&maxBytes=${maxBytes}` +
      `&exp=${expiresAtMs}` +
      `&token=${token}`
  }

  return {
    uploadId,
    quarantinePath,
    uploadUrl,
    expiresAt,
    writeOnly: true,
  }
}
