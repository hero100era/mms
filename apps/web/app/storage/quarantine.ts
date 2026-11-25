import * as crypto from 'node:crypto'
import { defaultAlerter } from '../audit_trail/alerter.ts'
import { getMalwareScanner, type MalwareScanResult } from './scanner.ts'
import { sanitizeFileName, sha256, sha256Hex, sniffMimeType } from './sniff.ts'
import {
  getMaxUploadBytesForDocType,
  getStorage,
  isDevEnvironment,
  MAX_UPLOAD_BYTES,
  UploadEmptyError,
  UploadTooLargeError,
} from './config.ts'

export interface QuarantineStreamResult {
  byteSize: number
  sha256: Buffer
  sha256Hex: string
}

/**
 * Saves a file buffer directly to quarantine storage.
 */
export async function putQuarantineFile(
  quarantinePath: string,
  buffer: Buffer | Uint8Array,
  fileName: string,
  contentType = 'application/octet-stream',
): Promise<void> {
  let storage = getStorage()
  let safeName = sanitizeFileName(fileName)
  let file = new File([new Uint8Array(buffer)], safeName, { type: contentType })
  await storage.set(quarantinePath, file)
}

/**
 * Streams a quarantine upload directly to storage while computing SHA-256 and enforcing byte limits.
 * Avoids buffering arbitrary payloads in memory by rejecting as soon as maxBytes is exceeded.
 */
export async function putQuarantineStream(
  quarantinePath: string,
  stream: ReadableStream<Uint8Array>,
  fileName: string,
  contentType: string,
  maxBytes = MAX_UPLOAD_BYTES,
): Promise<QuarantineStreamResult> {
  let reader = stream.getReader()
  let totalBytes = 0
  let hash = crypto.createHash('sha256')
  let chunks: Uint8Array[] = []

  try {
    while (true) {
      let { done, value } = await reader.read()
      if (done) break
      if (value) {
        totalBytes += value.byteLength
        if (totalBytes > maxBytes) {
          await reader.cancel('payload_too_large').catch(() => {})
          throw new UploadTooLargeError(`upload_too_large: ${totalBytes} bytes exceeds limit of ${maxBytes} bytes`)
        }
        hash.update(value)
        chunks.push(value)
      }
    }
  } finally {
    reader.releaseLock()
  }

  if (totalBytes === 0) {
    throw new UploadEmptyError('upload_empty')
  }

  let sha256Buf = hash.digest()
  let sha256HexStr = sha256Buf.toString('hex')
  let safeName = sanitizeFileName(fileName)
  let file = new File(chunks as any, safeName, { type: contentType || 'application/octet-stream' })

  let storage = getStorage()
  await storage.set(quarantinePath, file)

  return {
    byteSize: totalBytes,
    sha256: sha256Buf,
    sha256Hex: sha256HexStr,
  }
}

export interface InspectResult {
  buffer: Buffer
  sha256: Buffer
  sha256Hex: string
  byteSize: number
  mimeType: string
  fileName: string
}

/**
 * Inspects a quarantine file: reads bytes, computes SHA-256 digest, sniffs MIME type, and measures byte size.
 *
 * ADR-0023 §5: this is the authority for the stored digest (the prepare step only
 * predicts one), so it also enforces the upload limit on the bytes it actually
 * read. A blob written by another path (a direct SAS upload, a restored backup)
 * never gets past here just because the prepare step approved a size.
 */
export async function inspectQuarantineFile(
  quarantinePath: string,
  maxBytes = MAX_UPLOAD_BYTES,
): Promise<InspectResult> {
  let storage = getStorage()
  let file = await storage.get(quarantinePath)
  if (!file) {
    throw new Error(`quarantine_file_not_found: ${quarantinePath}`)
  }

  // Pre-buffer checks using File metadata to avoid loading oversized or empty payloads into RAM
  if (file.size === 0) {
    throw new UploadEmptyError('quarantine_file_empty')
  }
  if (file.size > maxBytes) {
    throw new UploadTooLargeError(`upload_too_large: ${file.size} bytes exceeds ${maxBytes}`)
  }

  let arrayBuffer = await file.arrayBuffer()
  let buffer = Buffer.from(arrayBuffer)
  if (buffer.length === 0) {
    throw new UploadEmptyError('quarantine_file_empty')
  }
  if (buffer.length > maxBytes) {
    throw new UploadTooLargeError(`upload_too_large: ${buffer.length} bytes exceeds ${maxBytes}`)
  }

  let hash = sha256(buffer)
  let hashHex = sha256Hex(buffer)
  let fileName = file.name || quarantinePath.split('/').pop() || 'document'
  let { mimeType } = sniffMimeType(buffer, fileName)

  return {
    buffer,
    sha256: hash,
    sha256Hex: hashHex,
    byteSize: buffer.length,
    mimeType,
    fileName,
  }
}

export class MalwareDetectedError extends Error {
  readonly threatName: string
  readonly scannerEngine: string
  readonly sha256Hex: string

  constructor(threatName: string, scannerEngine: string, sha256Hex: string) {
    super(`Malware detected in uploaded file: ${threatName}`)
    this.name = 'MalwareDetectedError'
    this.threatName = threatName
    this.scannerEngine = scannerEngine
    this.sha256Hex = sha256Hex
  }
}

export interface FinalizeUploadResult {
  sha256: Buffer
  sha256Hex: string
  byteSize: number
  mimeType: string
  storagePath: string
  status: 'promoted' | 'quarantined'
  isQuarantined: boolean
  scanStatus: 'clean' | 'pending' | 'infected' | 'error'
  threatName?: string
  scannerEngine?: string
  engineVersion?: string
  signatureVersion?: string
  scannedAt?: Date
}

export async function handleInfectedBlob(
  storage: ReturnType<typeof getStorage>,
  quarantinePath: string,
  inspected: InspectResult,
  scanResult: MalwareScanResult,
  source: string,
  extraDetails?: Record<string, unknown>,
): Promise<void> {
  // Purge infected quarantine blob immediately to prevent infection persistence
  try {
    await storage.remove(quarantinePath)
  } catch {}

  let message =
    source === 'upload-finalizer' && extraDetails?.uploadId
      ? `Malware detected in upload ${extraDetails.uploadId}: ${scanResult.threatName}`
      : `Malware detected in quarantined file ${quarantinePath}: ${scanResult.threatName}`

  let details: Record<string, unknown> = {
    fileName: inspected.fileName,
    sha256: inspected.sha256Hex,
    threatName: scanResult.threatName,
    scannerEngine: scanResult.scannerEngine,
    ...extraDetails,
  }

  await defaultAlerter.emit('MALWARE_DETECTED', 'CRITICAL', source, message, details)
}

export async function promoteInspectedBlob(
  storage: ReturnType<typeof getStorage>,
  quarantinePath: string,
  inspected: InspectResult,
  entityType: string,
  entityId: string,
  fileName: string,
  uploadId?: string,
): Promise<{ promotedPath: string; sha256Hex: string; byteSize: number; mimeType: string }> {
  let safeName = sanitizeFileName(fileName || inspected.fileName)
  let resolvedUploadId = uploadId
  if (!resolvedUploadId) {
    let parts = quarantinePath.split('/')
    resolvedUploadId = parts.length >= 3 && parts[0] === 'quarantine' ? parts[1] : crypto.randomUUID()
  }
  let promotedPath = `documents/${entityType}/${entityId}/${resolvedUploadId}/${safeName}`

  let cleanFile = new File([new Uint8Array(inspected.buffer)], safeName, { type: inspected.mimeType })
  await storage.set(promotedPath, cleanFile)

  return {
    promotedPath,
    sha256Hex: inspected.sha256Hex,
    byteSize: inspected.byteSize,
    mimeType: inspected.mimeType,
  }
}

/**
 * Finalizes an upload: verifies quarantine file, computes digest, runs malware scanner,
 * and either promotes to clean storage (if scan clean and auto-promote enabled)
 * or leaves in quarantine outside dev until scanned/promoted with H-05.
 */
export async function finalizeUpload(params: {
  uploadId: string
  quarantinePath: string
  entityType: string
  entityId: string
  docType: string
  title: string
  fileName: string
  forceDevPromote?: boolean
  skipScan?: boolean
}): Promise<FinalizeUploadResult> {
  // ADR-0023 §4: these switches exist so a developer can promote a file without
  // a scanner running locally. In production they are a refusal to enforce the
  // one control that decides whether bytes become a document, so they are not
  // reachable there at all.
  if ((params.skipScan || params.forceDevPromote) && !isDevEnvironment()) {
    throw new Error('scan_required: skipScan and forceDevPromote are development-only')
  }

  let maxBytes = getMaxUploadBytesForDocType(params.docType)
  let inspected = await inspectQuarantineFile(params.quarantinePath, maxBytes)
  let storage = getStorage()
  let safeName = sanitizeFileName(params.fileName || inspected.fileName)

  let shouldPromote = params.forceDevPromote ?? isDevEnvironment()

  // Only run a synchronous scan when promoting inline (dev/test). In production
  // the file stays quarantined for the async malware-scanner worker, avoiding
  // blocking the HTTP request and double-scanning the same blob.
  let scanResult: MalwareScanResult | null = null
  if (!params.skipScan && shouldPromote) {
    let scanner = getMalwareScanner()
    scanResult = await scanner.scanBuffer(inspected.buffer, safeName)
    if (scanResult.status === 'infected') {
      await handleInfectedBlob(storage, params.quarantinePath, inspected, scanResult, 'upload-finalizer', {
        uploadId: params.uploadId,
        fileName: safeName,
      })

      throw new MalwareDetectedError(
        scanResult.threatName || 'Malware.Detected',
        scanResult.scannerEngine,
        inspected.sha256Hex,
      )
    }
  }

  if (shouldPromote && (!scanResult || scanResult.status === 'clean')) {
    let promoted = await promoteInspectedBlob(
      storage,
      params.quarantinePath,
      inspected,
      params.entityType,
      params.entityId,
      safeName,
      params.uploadId,
    )
    try {
      await storage.remove(params.quarantinePath)
    } catch {}

    return {
      sha256: inspected.sha256,
      sha256Hex: inspected.sha256Hex,
      byteSize: inspected.byteSize,
      mimeType: inspected.mimeType,
      storagePath: promoted.promotedPath,
      status: 'promoted',
      isQuarantined: false,
      scanStatus: scanResult?.status ?? (params.skipScan ? 'pending' : 'clean'),
      scannerEngine: scanResult?.scannerEngine,
      engineVersion: scanResult?.engineVersion,
      signatureVersion: scanResult?.signatureVersion,
      scannedAt: scanResult?.scannedAt,
    }
  } else {
    // Outside dev / pending async scan: leaves in quarantine
    return {
      sha256: inspected.sha256,
      sha256Hex: inspected.sha256Hex,
      byteSize: inspected.byteSize,
      mimeType: inspected.mimeType,
      storagePath: params.quarantinePath,
      status: 'quarantined',
      isQuarantined: true,
      scanStatus: scanResult?.status ?? 'pending',
      scannerEngine: scanResult?.scannerEngine,
      engineVersion: scanResult?.engineVersion,
      signatureVersion: scanResult?.signatureVersion,
      scannedAt: scanResult?.scannedAt,
    }
  }
}

/**
 * Promotes a quarantined blob to clean storage (used by H-05 malware scanner or admin).
 */
export async function promoteQuarantinedBlob(
  quarantinePath: string,
  entityType: string,
  entityId: string,
  fileName: string,
): Promise<{ promotedPath: string; sha256Hex: string; byteSize: number; mimeType: string }> {
  let inspected = await inspectQuarantineFile(quarantinePath)
  let storage = getStorage()
  return promoteInspectedBlob(storage, quarantinePath, inspected, entityType, entityId, fileName)
}

/**
 * Scans a quarantined blob using the malware scanner and promotes to clean storage if clean.
 * If infected, purges the quarantine blob and emits an alert.
 */
export async function scanAndPromoteQuarantinedBlob(
  quarantinePath: string,
  entityType: string,
  entityId: string,
  fileName: string,
): Promise<{
  status: 'promoted' | 'infected' | 'error'
  promotedPath?: string
  threatName?: string
  scannerEngine: string
  sha256Hex: string
  byteSize: number
  mimeType: string
}> {
  let inspected = await inspectQuarantineFile(quarantinePath)
  let storage = getStorage()
  let scanner = getMalwareScanner()
  let scanResult = await scanner.scanBuffer(inspected.buffer, fileName || inspected.fileName)

  if (scanResult.status === 'infected') {
    await handleInfectedBlob(storage, quarantinePath, inspected, scanResult, 'quarantine-promoter', {
      quarantinePath,
      fileName,
    })

    return {
      status: 'infected',
      threatName: scanResult.threatName || 'Malware.Detected',
      scannerEngine: scanResult.scannerEngine,
      sha256Hex: inspected.sha256Hex,
      byteSize: inspected.byteSize,
      mimeType: inspected.mimeType,
    }
  }

  if (scanResult.status === 'error') {
    return {
      status: 'error',
      scannerEngine: scanResult.scannerEngine,
      sha256Hex: inspected.sha256Hex,
      byteSize: inspected.byteSize,
      mimeType: inspected.mimeType,
    }
  }

  let promoted = await promoteInspectedBlob(storage, quarantinePath, inspected, entityType, entityId, fileName)
  return {
    status: 'promoted',
    promotedPath: promoted.promotedPath,
    scannerEngine: scanResult.scannerEngine,
    sha256Hex: promoted.sha256Hex,
    byteSize: promoted.byteSize,
    mimeType: promoted.mimeType,
  }
}
