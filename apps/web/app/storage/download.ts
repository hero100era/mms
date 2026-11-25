import { getStorage, MAX_UPLOAD_BYTES } from './config.ts'

/**
 * Checks if a file is permitted to be downloaded. Quarantined or infected files cannot be served!
 */
export function canDownloadStorageFile(
  storagePath: string,
  scanStatus?: string,
): { allowed: boolean; reason?: string } {
  if (scanStatus === 'infected') {
    return {
      allowed: false,
      reason: 'malware_detected',
    }
  }
  let isQuarantined = storagePath.startsWith('quarantine/')
  if (isQuarantined || scanStatus !== 'clean') {
    return {
      allowed: false,
      reason: 'quarantined_pending_scan',
    }
  }
  return { allowed: true }
}

/**
 * Retrieves a file from storage for download.
 */
export async function getStorageFile(
  storagePath: string,
  maxBytes = MAX_UPLOAD_BYTES,
): Promise<{ buffer: Buffer; fileName: string; mimeType: string; size: number } | null> {
  let storage = getStorage()
  let file = await storage.get(storagePath)
  if (!file) return null

  if (file.size > maxBytes) {
    throw new Error(`storage_file_too_large: ${file.size} exceeds ${maxBytes}`)
  }

  let arrayBuffer = await file.arrayBuffer()
  let buffer = Buffer.from(arrayBuffer)
  let fileName = file.name || storagePath.split('/').pop() || 'document'
  let mimeType = file.type || 'application/octet-stream'

  return {
    buffer,
    fileName,
    mimeType,
    size: buffer.length,
  }
}

/**
 * Retrieves a file from storage as a stream for download without buffering into memory.
 */
export async function getStorageFileStream(
  storagePath: string,
  maxBytes = MAX_UPLOAD_BYTES,
): Promise<{ stream: ReadableStream<Uint8Array>; fileName: string; mimeType: string; size: number } | null> {
  let storage = getStorage()
  let file = await storage.get(storagePath)
  if (!file) return null

  if (file.size > maxBytes) {
    throw new Error(`storage_file_too_large: ${file.size} exceeds ${maxBytes}`)
  }

  let fileName = file.name || storagePath.split('/').pop() || 'document'
  let mimeType = file.type || 'application/octet-stream'

  return {
    stream: file.stream(),
    fileName,
    mimeType,
    size: file.size,
  }
}
