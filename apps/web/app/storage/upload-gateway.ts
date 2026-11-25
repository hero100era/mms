import {
  dbUploadPrepare,
  dbUploadMarkUploaded,
  dbUploadMarkVerdict,
  recordMalwareScanRun,
  recordScan,
} from './upload-repository.ts'

export interface UploadStateGateway {
  prepare(params: {
    uploadId: string
    entityType: string
    entityId: string
    docType: string
    fileName: string
    quarantinePath: string
    expiresAt: string
  }): Promise<void>
  markUploaded(params: {
    uploadId: string
    sha256Hex: string
    byteSize: number
    mimeType: string
  }): Promise<void>
  markVerdict(params: {
    uploadId: string
    state: 'pending_scan' | 'clean' | 'infected' | 'error' | 'abandoned'
    engine: string
    threatName?: string | null
    documentVersionId?: string | null
  }): Promise<void>
  recordScan(
    versionId: string,
    status: 'clean' | 'infected' | 'error',
    scannerEngine: string,
    threatName: string | null,
    promotedPath: string | null,
    detail: Record<string, unknown>,
  ): Promise<void>
  recordMalwareScanRun(params: {
    versionId?: string
    documentId?: string
    fileName: string
    sha256Hex: string
    byteSize: number
    scannerEngine: string
    status: 'clean' | 'infected' | 'error'
    threatName?: string
    quarantinePath: string
    promotedPath?: string
    scannedBy?: string
    detail?: Record<string, unknown>
  }): Promise<void>
}

class WorkerPoolUploadGateway implements UploadStateGateway {
  prepare(params: Parameters<UploadStateGateway['prepare']>[0]): Promise<void> {
    return dbUploadPrepare(params)
  }
  markUploaded(params: Parameters<UploadStateGateway['markUploaded']>[0]): Promise<void> {
    return dbUploadMarkUploaded(params)
  }
  markVerdict(params: Parameters<UploadStateGateway['markVerdict']>[0]): Promise<void> {
    return dbUploadMarkVerdict(params)
  }
  recordScan(
    versionId: string,
    status: 'clean' | 'infected' | 'error',
    scannerEngine: string,
    threatName: string | null,
    promotedPath: string | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    return recordScan(versionId, status, scannerEngine, threatName, promotedPath, detail)
  }
  recordMalwareScanRun(params: Parameters<UploadStateGateway['recordMalwareScanRun']>[0]): Promise<void> {
    return recordMalwareScanRun(params)
  }
}

let activeGateway: UploadStateGateway = new WorkerPoolUploadGateway()

export function getUploadGateway(): UploadStateGateway {
  return activeGateway
}

export function setUploadGateway(gateway: UploadStateGateway): void {
  activeGateway = gateway
}

export function resetUploadGateway(): void {
  activeGateway = new WorkerPoolUploadGateway()
}
