import { MAX_JSON_BODY_BYTES } from '../../middleware/body-limits.ts'
import {
  optionalInteger,
  requireText,
  requireUuid,
} from '../validation.ts'
import { sanitizeFileName } from '../../storage/sniff.ts'
import { getMaxUploadBytesForDocType, MAX_UPLOAD_BYTES } from '../../storage/service.ts'

export async function readJsonWithLimit(request: Request, maxBytes = MAX_JSON_BODY_BYTES): Promise<any> {
  let lenHeader = request.headers.get('content-length')
  if (lenHeader !== null) {
    let len = Number(lenHeader)
    if (Number.isFinite(len) && len > maxBytes) {
      let err = new Error(`JSON body exceeds maximum size of ${maxBytes} bytes`)
      ;(err as any).status = 413
      throw err
    }
  }

  if (!request.body) return {}
  let reader = request.body.getReader()
  let received = 0
  let chunks: Uint8Array[] = []
  try {
    while (true) {
      let { done, value } = await reader.read()
      if (done) break
      if (value) {
        received += value.byteLength
        if (received > maxBytes) {
          await reader.cancel('payload_too_large').catch(() => {})
          let err = new Error(`JSON body exceeds maximum size of ${maxBytes} bytes`)
          ;(err as any).status = 413
          throw err
        }
        chunks.push(value)
      }
    }
  } finally {
    reader.releaseLock()
  }

  if (chunks.length === 0) return {}
  let totalBuffer = Buffer.concat(chunks)
  let text = totalBuffer.toString('utf8')
  if (!text.trim()) return {}
  return JSON.parse(text)
}

export function parsePrepareParams(form: FormData): {
  entityType: string
  entityId: string
  docType: string
  fileName: string
  expiresInMinutes: number
} {
  return {
    entityType: requireText(form, 'entityType'),
    entityId: requireUuid(form, 'entityId'),
    docType: requireText(form, 'docType'),
    fileName: requireText(form, 'fileName'),
    expiresInMinutes: optionalInteger(form, 'expiresInMinutes', { min: 1, max: 60, defaultValue: 60 }),
  }
}

export function parseQuarantineParams(url: URL, params: Record<string, string | undefined>): {
  uploadId: string
  fileName: string
  entityType: string
  entityId: string
  docType: string
  exp: number
  token: string
  maxBytes: number
} {
  let uploadId = String(params.uploadId ?? '').trim()
  let fileName = sanitizeFileName(url.searchParams.get('fileName') || 'file.bin')
  let entityType = url.searchParams.get('entityType') || ''
  let entityId = url.searchParams.get('entityId') || ''
  let docType = url.searchParams.get('docType') || ''
  let exp = Number(url.searchParams.get('exp') || 0)
  let token = url.searchParams.get('token') || ''
  let maxBytesParam = Number(url.searchParams.get('maxBytes') || 0)
  let maxBytes = maxBytesParam > 0 ? maxBytesParam : getMaxUploadBytesForDocType(docType)

  return {
    uploadId,
    fileName,
    entityType,
    entityId,
    docType,
    exp,
    token,
    maxBytes,
  }
}

export function parseFinalizeParams(form: FormData): {
  uploadId: string
  parsedUploadId: string
  quarantinePath: string
  entityType: string
  entityId: string
  docType: string
  title: string
  fileName: string
  safeName: string
  expectedQuarantinePath: string
} {
  let uploadId = requireText(form, 'uploadId')
  let parsedUploadId = requireUuid(form, 'uploadId')
  let quarantinePath = requireText(form, 'quarantinePath')
  let entityType = requireText(form, 'entityType')
  let entityId = requireUuid(form, 'entityId')
  let docType = requireText(form, 'docType')
  let title = requireText(form, 'title')
  let fileName = requireText(form, 'fileName')
  let safeName = sanitizeFileName(fileName)
  let expectedQuarantinePath = `quarantine/${parsedUploadId}/${safeName}`

  return {
    uploadId,
    parsedUploadId,
    quarantinePath,
    entityType,
    entityId,
    docType,
    title,
    fileName,
    safeName,
    expectedQuarantinePath,
  }
}
