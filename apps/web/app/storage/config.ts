import type { FileStorage } from 'remix/file-storage'
import { createMemoryFileStorage } from 'remix/file-storage/memory'
import { createAzureBlobFileStorage } from './azure-blob.ts'

export interface StorageConfig {
  backend: 'azure' | 'memory'
  azureOptions?: {
    accountName: string
    accountKey: string
    endpoint: string
    container: string
  }
  quarantinePrefix?: string
  cleanPrefix?: string
}

let globalStorage: FileStorage<File> | null = null
let azureStorageHelper: ReturnType<typeof createAzureBlobFileStorage> | null = null

export function getAzureStorageHelper(): ReturnType<typeof createAzureBlobFileStorage> | null {
  return azureStorageHelper
}

export function initStorage(config?: Partial<StorageConfig>): FileStorage<File> {
  if (config?.backend === 'azure' && config.azureOptions) {
    let az = createAzureBlobFileStorage(config.azureOptions)
    azureStorageHelper = az
    globalStorage = az
    return az
  }

  // Check env for Azure configuration (Azurite is strictly disallowed in production)
  let allowAzurite = process.env.AZURITE_ENABLED === '1' && process.env.NODE_ENV !== 'production'
  let accountName = process.env.AZURE_STORAGE_ACCOUNT || (allowAzurite ? 'devstoreaccount1' : '')
  let accountKey = process.env.AZURE_STORAGE_KEY || (allowAzurite ? 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==' : '')
  let endpoint = process.env.AZURE_STORAGE_ENDPOINT || (allowAzurite ? 'http://127.0.0.1:10000/devstoreaccount1' : '')
  let container = process.env.AZURE_STORAGE_CONTAINER || 'mms-files'

  if (accountName && accountKey && endpoint) {
    let az = createAzureBlobFileStorage({ accountName, accountKey, endpoint, container })
    azureStorageHelper = az
    globalStorage = az
    return az
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Azure Blob Storage (AZURE_STORAGE_ACCOUNT, AZURE_STORAGE_KEY, AZURE_STORAGE_ENDPOINT) is required in production',
    )
  }

  // Default to memory storage in dev/test only
  globalStorage = createMemoryFileStorage()
  azureStorageHelper = null
  return globalStorage
}

export function getStorage(): FileStorage<File> {
  if (!globalStorage) {
    return initStorage()
  }
  return globalStorage
}

export function resetStorageForTest(mockStorage?: FileStorage<File>) {
  globalStorage = mockStorage ?? createMemoryFileStorage()
  azureStorageHelper = null
}

export function isDevEnvironment(): boolean {
  if (process.env.MMS_FORCE_PROD_STORAGE === '1') return false
  return process.env.NODE_ENV !== 'production'
}

/**
 * Maximum upload size, in bytes (ADR-0023 §5). 100 MiB.
 *
 * Enforced in three places, because each one protects something different:
 * the upload action rejects an oversized body before reading it (memory), the
 * signed token carries it so a token cannot be used for a larger file than the
 * prepare step authorised (integrity), and `inspectQuarantineFile` checks the
 * bytes it actually read (truth — storage may have been written by another
 * path).
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

export class UploadTooLargeError extends Error {
  readonly code = 'UPLOAD_TOO_LARGE'
  readonly status = 413
  constructor(message = 'Upload payload exceeds size limit') {
    super(message)
    this.name = 'UploadTooLargeError'
  }
}

export class UploadEmptyError extends Error {
  readonly code = 'UPLOAD_EMPTY'
  readonly status = 400
  constructor(message = 'Upload payload is empty') {
    super(message)
    this.name = 'UploadEmptyError'
  }
}

/**
 * Maximum upload size limits per document category (R4.3).
 *
 * Drawings/plans: 100 MiB (maximum system upload ceiling)
 * Reports/specifications/logs: 25 MiB
 * Certificates/identity/other attachments: 10 MiB
 */
export const DOCUMENT_CATEGORY_LIMITS: Record<string, number> = {
  // Heavy CAD/engineering drawings and general arrangement plans
  general_arrangement: 100 * 1024 * 1024,
  spec_drawing: 100 * 1024 * 1024,
  plans: 100 * 1024 * 1024,
  drawings: 100 * 1024 * 1024,

  // Technical specifications, survey reports, logs
  specification: 25 * 1024 * 1024,
  hull_report: 25 * 1024 * 1024,
  boiler_log: 25 * 1024 * 1024,
  radar_spec: 25 * 1024 * 1024,
  rudder_log: 25 * 1024 * 1024,
  fuel_test_report: 25 * 1024 * 1024,
  survey_report: 25 * 1024 * 1024,

  // Standard certificates, identity, and miscellaneous attachments
  certificate: 10 * 1024 * 1024,
  identity: 10 * 1024 * 1024,
  default: 10 * 1024 * 1024,
}

export function getMaxUploadBytesForDocType(docType: string): number {
  let key = (docType || '').toLowerCase().trim()
  return DOCUMENT_CATEGORY_LIMITS[key] ?? DOCUMENT_CATEGORY_LIMITS.default
}
