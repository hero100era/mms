import * as crypto from 'node:crypto'
import * as path from 'node:path'

/**
 * Computes the SHA-256 hash of a buffer, returning the 32-byte binary digest.
 */
export function sha256(data: Buffer | Uint8Array): Buffer {
  return crypto.createHash('sha256').update(data).digest()
}

/**
 * Computes the SHA-256 hash of a buffer, returning the 64-character lowercase hexadecimal string.
 */
export function sha256Hex(data: Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

/**
 * Sanitizes a user-supplied file name to prevent path traversal or problematic characters.
 */
export function sanitizeFileName(rawName: string): string {
  let normalized = rawName.replace(/\\/g, '/').trim()
  let base = normalized.split('/').filter(Boolean).pop() || ''
  // Replace dangerous or whitespace characters
  let clean = base.replace(/[^a-zA-Z0-9._-]/g, '_')
  clean = clean.replace(/^\.+/, '')
  if (!clean) {
    return 'document.bin'
  }
  return clean
}

/**
 * Sniffs the MIME type of a buffer based on magic byte headers.
 * Does NOT rely on unverified client-provided MIME headers.
 */
export function sniffMimeType(
  buffer: Buffer | Uint8Array,
  fileName?: string,
): { mimeType: string; isKnown: boolean } {
  let buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  let ext = fileName ? path.extname(fileName).toLowerCase() : ''

  // Empty buffer
  if (buf.length === 0) {
    return { mimeType: 'application/octet-stream', isKnown: false }
  }

  // PDF: %PDF- (0x25, 0x50, 0x44, 0x46, 0x2D)
  if (
    buf.length >= 5 &&
    buf[0] === 0x25 &&
    buf[1] === 0x50 &&
    buf[2] === 0x44 &&
    buf[3] === 0x46 &&
    buf[4] === 0x2d
  ) {
    return { mimeType: 'application/pdf', isKnown: true }
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return { mimeType: 'image/png', isKnown: true }
  }

  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mimeType: 'image/jpeg', isKnown: true }
  }

  // GIF: GIF87a or GIF89a (47 49 46 38 37 61 or 47 49 46 38 39 61)
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return { mimeType: 'image/gif', isKnown: true }
  }

  // TIFF: II*. or MM.*
  if (
    buf.length >= 4 &&
    ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a))
  ) {
    return { mimeType: 'image/tiff', isKnown: true }
  }

  // ZIP / Office OpenXML: PK\x03\x04 (50 4B 03 04)
  if (
    buf.length >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    buf[2] === 0x03 &&
    buf[3] === 0x04
  ) {
    if (ext === '.docx') {
      return {
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        isKnown: true,
      }
    }
    if (ext === '.xlsx') {
      return {
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        isKnown: true,
      }
    }
    if (ext === '.pptx') {
      return {
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        isKnown: true,
      }
    }
    return { mimeType: 'application/zip', isKnown: true }
  }

  // Microsoft Office 97-2003 / OLE2 Compound Document: D0 CF 11 E0 A1 B1 1A E1
  if (
    buf.length >= 8 &&
    buf[0] === 0xd0 &&
    buf[1] === 0xcf &&
    buf[2] === 0x11 &&
    buf[3] === 0xe0 &&
    buf[4] === 0xa1 &&
    buf[5] === 0xb1 &&
    buf[6] === 0x1a &&
    buf[7] === 0xe1
  ) {
    if (ext === '.doc') {
      return { mimeType: 'application/msword', isKnown: true }
    }
    if (ext === '.xls') {
      return { mimeType: 'application/vnd.ms-excel', isKnown: true }
    }
    if (ext === '.ppt') {
      return { mimeType: 'application/vnd.ms-powerpoint', isKnown: true }
    }
    return { mimeType: 'application/x-ole-storage', isKnown: true }
  }

  // WebP image: RIFF....WEBP (52 49 46 46 .... 57 45 42 50)
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return { mimeType: 'image/webp', isKnown: true }
  }

  // Check for plain text, CSV, or SVG (ASCII / UTF-8 printable)
  let checkLen = Math.min(buf.length, 1024)
  let isText = true
  for (let i = 0; i < checkLen; i++) {
    let byte = buf[i]
    // Allow tab (9), newline (10), carriage return (13), and printable ASCII (32-126) or UTF-8 multi-byte (> 127)
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      isText = false
      break
    }
  }

  if (isText) {
    let textPrefix = buf.subarray(0, checkLen).toString('utf8').trim()
    if (textPrefix.startsWith('<svg') || (textPrefix.startsWith('<?xml') && textPrefix.includes('<svg'))) {
      return { mimeType: 'image/svg+xml', isKnown: true }
    }
    if (ext === '.csv') {
      return { mimeType: 'text/csv', isKnown: true }
    }
    if (ext === '.json') {
      return { mimeType: 'application/json', isKnown: true }
    }
    if (ext === '.txt' || ext === '.log') {
      return { mimeType: 'text/plain', isKnown: true }
    }
    return { mimeType: 'text/plain', isKnown: false }
  }

  // Fallback
  return { mimeType: 'application/octet-stream', isKnown: false }
}

