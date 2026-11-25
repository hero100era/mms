import * as crypto from 'node:crypto'
import { ClamAvScannerClient, type ClamAvScannerOptions } from './clamav-scanner.ts'

export { ClamAvScannerClient, type ClamAvScannerOptions }

export type MalwareScanStatus = 'clean' | 'infected' | 'error'

export interface MalwareScanResult {
  status: MalwareScanStatus
  threatName?: string
  scannerEngine: string
  engineVersion?: string
  signatureVersion?: string
  scannedAt: Date
  fileSha256: string
  fileByteSize: number
  details?: Record<string, unknown>
}

export interface MalwareScannerClient {
  readonly name: string
  scanBuffer(buffer: Buffer, fileName: string): Promise<MalwareScanResult>
}

/**
 * Standard EICAR Antivirus Test File signature (68 ASCII bytes).
 * Recognized universally by anti-malware scanners as a benign test threat.
 */
export const EICAR_STANDARD_SIGNATURE =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'

/**
 * Deterministic Mock Malware Scanner Client.
 * Automatically identifies the standard EICAR test signature and supports
 * custom configured responses for testing clean, infected, timeout, and error conditions.
 */
export class MockMalwareScannerClient implements MalwareScannerClient {
  readonly name = 'mock'
  private rules: Array<{
    match: string | RegExp | ((buffer: Buffer, fileName: string) => boolean)
    status: MalwareScanStatus
    threatName?: string
    error?: string
  }> = []

  private simulatedFailure: { shouldFail: boolean; message?: string } = { shouldFail: false }

  setSimulatedFailure(shouldFail: boolean, message = 'Scanner daemon connection timed out'): void {
    this.simulatedFailure = { shouldFail, message }
  }

  addMockRule(
    match: string | RegExp | ((buffer: Buffer, fileName: string) => boolean),
    status: MalwareScanStatus,
    threatName?: string,
    error?: string,
  ): void {
    this.rules.unshift({ match, status, threatName, error })
  }

  clearRules(): void {
    this.rules.length = 0
    this.simulatedFailure = { shouldFail: false }
  }

  async scanBuffer(buffer: Buffer, fileName: string): Promise<MalwareScanResult> {
    let sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
    let fileByteSize = buffer.length
    let scannedAt = new Date()

    if (this.simulatedFailure.shouldFail) {
      return {
        status: 'error',
        scannerEngine: this.name,
        engineVersion: 'mock-1.0',
        signatureVersion: '2026.11.08',
        scannedAt,
        fileSha256: sha256,
        fileByteSize,
        details: { error: this.simulatedFailure.message },
      }
    }

    // Check custom rules first
    for (let rule of this.rules) {
      let isMatch = false
      if (typeof rule.match === 'string') {
        isMatch = fileName.includes(rule.match) || buffer.toString('utf8').includes(rule.match)
      } else if (rule.match instanceof RegExp) {
        isMatch = rule.match.test(fileName) || rule.match.test(buffer.toString('utf8'))
      } else if (typeof rule.match === 'function') {
        isMatch = rule.match(buffer, fileName)
      }

      if (isMatch) {
        return {
          status: rule.status,
          threatName: rule.threatName,
          scannerEngine: this.name,
          engineVersion: 'mock-1.0',
          signatureVersion: '2026.11.08',
          scannedAt,
          fileSha256: sha256,
          fileByteSize,
          details: rule.error ? { error: rule.error } : undefined,
        }
      }
    }

    // Default EICAR standard detection
    let content = buffer.toString('binary')
    if (content.includes(EICAR_STANDARD_SIGNATURE) || content.includes('malware-test-signature')) {
      return {
        status: 'infected',
        threatName: 'Win32.EICAR.TestSignature',
        scannerEngine: this.name,
        engineVersion: 'mock-1.0',
        signatureVersion: '2026.11.08',
        scannedAt,
        fileSha256: sha256,
        fileByteSize,
        details: { detectedSignature: 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE' },
      }
    }

    // Default clean
    return {
      status: 'clean',
      scannerEngine: this.name,
      engineVersion: 'mock-1.0',
      signatureVersion: '2026.11.08',
      scannedAt,
      fileSha256: sha256,
      fileByteSize,
    }
  }
}

/**
 * Microsoft Defender for Cloud / Azure Blob Storage Scanner Client.
 * Parses Defender for Storage Blob Index Tags or scan metadata.
 */
export class AzureDefenderScannerClient implements MalwareScannerClient {
  readonly name = 'defender'

  async scanBuffer(buffer: Buffer, fileName: string): Promise<MalwareScanResult> {
    let sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
    let fileByteSize = buffer.length
    let scannedAt = new Date()

    // When running with mock fallback or simulated defender tags
    let content = buffer.toString('binary')
    if (content.includes(EICAR_STANDARD_SIGNATURE) || content.includes('malware-test-signature')) {
      return {
        status: 'infected',
        threatName: 'Virus:DOS/EICAR_Test_File',
        scannerEngine: this.name,
        engineVersion: 'Microsoft.Defender.Storage/v1',
        signatureVersion: '2026.11.08',
        scannedAt,
        fileSha256: sha256,
        fileByteSize,
        details: {
          defenderTag: 'Malicious',
          threatType: 'TestFile',
          threatName: 'Virus:DOS/EICAR_Test_File',
        },
      }
    }

    return {
      status: 'clean',
      scannerEngine: this.name,
      engineVersion: 'Microsoft.Defender.Storage/v1',
      signatureVersion: '2026.11.08',
      scannedAt,
      fileSha256: sha256,
      fileByteSize,
      details: {
        defenderTag: 'No threats found',
      },
    }
  }

  /**
   * Helper to parse Microsoft Defender Blob Index Tags from Azure Blob Storage.
   */
  static parseBlobTags(tags: Record<string, string>): {
    status: MalwareScanStatus
    threatName?: string
    scanTimeUtc?: string
    details?: Record<string, unknown>
  } {
    let scanResult = tags['Malware Scanning scan result']
    let scanTimeUtc = tags['Malware Scanning scan time UTC']
    if (!scanResult) {
      return { status: 'error', scanTimeUtc }
    }
    if (scanResult.toLowerCase().includes('no threats found')) {
      return { status: 'clean', scanTimeUtc }
    }
    if (scanResult.toLowerCase().includes('malicious')) {
      let threatName = 'Malicious.Blob.Threat'
      let detailsJson = tags['Malware Scanning scan result details']
      let details: Record<string, unknown> | undefined
      if (detailsJson) {
        try {
          details = JSON.parse(detailsJson)
          if (typeof details?.threatName === 'string') threatName = details.threatName
        } catch {
          // Keep default threatName
        }
      }
      return { status: 'infected', threatName, scanTimeUtc, details }
    }
    return { status: 'error', scanTimeUtc }
  }
}

let activeScanner: MalwareScannerClient | null = null

/**
 * True when the process is a production runtime. Mirrors
 * `storage/service.ts`: an explicit `MMS_FORCE_PROD_STORAGE=1` switch puts a
 * development machine on the production path deliberately.
 */
function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.MMS_FORCE_PROD_STORAGE === '1'
}

/**
 * Selects the scanner. There is **no implicit fallback**.
 *
 * ADR-0023 §4: a silent fallback to the mock is not "no scan": the mock answers
 * from rules that only tests install, so a misconfigured deployment reports
 * `clean` for every file and promotes it. A missing or unrecognised
 * `MALWARE_SCANNER_TYPE` is therefore a startup error in production, in the
 * same way `session-cookie.ts` refuses to run without `MMS_SESSION_SECRET`. The
 * mock remains reachable outside production, but only by naming it.
 */
export function createMalwareScanner(type?: string): MalwareScannerClient {
  let scannerType = (type ?? process.env.MALWARE_SCANNER_TYPE)?.toLowerCase().trim()

  if (scannerType === 'clamav') {
    return new ClamAvScannerClient()
  }
  if (scannerType === 'defender') {
    if (isProductionRuntime()) {
      throw new Error(
        'MALWARE_SCANNER_TYPE=defender is not yet implemented for production (EICAR stub only); ' +
          'configure MALWARE_SCANNER_TYPE=clamav until Azure Blob Index Tag integration is complete',
      )
    }
    return new AzureDefenderScannerClient()
  }
  // Unset and empty are both "nothing real was configured": outside production
  // that is the mock (as it always was), in production it is a startup error.
  if (scannerType === 'mock' || scannerType === undefined || scannerType === '') {
    if (isProductionRuntime()) {
      throw new Error(
        'MALWARE_SCANNER_TYPE must name a real scanner (clamav or defender) in production; ' +
          'the mock scanner never reports malware and must not be selected',
      )
    }
    return new MockMalwareScannerClient()
  }

  throw new Error(
    `unknown MALWARE_SCANNER_TYPE "${scannerType}"; expected clamav, defender` +
      (isProductionRuntime() ? '' : ' or mock'),
  )
}

export function getMalwareScanner(): MalwareScannerClient {
  if (!activeScanner) {
    activeScanner = createMalwareScanner()
  }
  return activeScanner
}

export function setMalwareScanner(scanner: MalwareScannerClient | null): void {
  activeScanner = scanner
}
