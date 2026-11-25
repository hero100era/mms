import assert from 'node:assert/strict'
import * as net from 'node:net'
import { describe, it } from 'node:test'

import {
  AzureDefenderScannerClient,
  ClamAvScannerClient,
  EICAR_STANDARD_SIGNATURE,
  MockMalwareScannerClient,
  createMalwareScanner,
  getMalwareScanner,
  setMalwareScanner,
} from './scanner.ts'

describe('Card H-05: Malware Scanner Engine & Protocol Clients', () => {
  describe('MockMalwareScannerClient', () => {
    it('detects clean files and computes sha256 and byteSize', async () => {
      let scanner = new MockMalwareScannerClient()
      let buffer = Buffer.from('Ordinary clean vessel survey notes', 'utf8')
      let res = await scanner.scanBuffer(buffer, 'notes.txt')

      assert.equal(res.status, 'clean')
      assert.equal(res.scannerEngine, 'mock')
      assert.equal(res.fileByteSize, buffer.length)
      assert.match(res.fileSha256, /^[0-9a-f]{64}$/)
      assert.ok(res.scannedAt instanceof Date)
      assert.equal(res.threatName, undefined)
    })

    it('identifies standard EICAR test string and reports infected', async () => {
      let scanner = new MockMalwareScannerClient()
      let eicarBuffer = Buffer.from(EICAR_STANDARD_SIGNATURE, 'binary')
      let res = await scanner.scanBuffer(eicarBuffer, 'eicar.com')

      assert.equal(res.status, 'infected')
      assert.equal(res.threatName, 'Win32.EICAR.TestSignature')
      assert.equal(res.scannerEngine, 'mock')
      assert.equal(res.fileByteSize, eicarBuffer.length)
      assert.equal(res.details?.detectedSignature, 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE')
    })

    it('matches custom rules by string, regex, or predicate', async () => {
      let scanner = new MockMalwareScannerClient()
      scanner.addMockRule(/malicious-macro/i, 'infected', 'VBA.Downloader.Payload')
      scanner.addMockRule('corrupted.pdf', 'error', undefined, 'Corrupted archive header')

      let res1 = await scanner.scanBuffer(Buffer.from('contains malicious-macro payload', 'utf8'), 'doc.docx')
      assert.equal(res1.status, 'infected')
      assert.equal(res1.threatName, 'VBA.Downloader.Payload')

      let res2 = await scanner.scanBuffer(Buffer.from('some data', 'utf8'), 'corrupted.pdf')
      assert.equal(res2.status, 'error')
      assert.equal(res2.details?.error, 'Corrupted archive header')
    })

    it('fails closed when simulated failure is enabled', async () => {
      let scanner = new MockMalwareScannerClient()
      scanner.setSimulatedFailure(true, 'Connection refused to AV socket')

      let res = await scanner.scanBuffer(Buffer.from('clean content', 'utf8'), 'file.txt')
      assert.equal(res.status, 'error')
      assert.equal(res.details?.error, 'Connection refused to AV socket')

      scanner.clearRules()
      let resAfterClear = await scanner.scanBuffer(Buffer.from('clean content', 'utf8'), 'file.txt')
      assert.equal(resAfterClear.status, 'clean')
    })
  })

  describe('ClamAvScannerClient protocol', () => {
    it('scans clean stream over TCP clamd protocol (stream: OK)', async () => {
      let server = net.createServer((socket) => {
        let chunks: Buffer[] = []
        socket.on('data', (d) => {
          chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d))
        })
        // When client sends terminator, reply stream: OK
        setTimeout(() => {
          socket.write(Buffer.from('stream: OK\0', 'utf8'))
          socket.end()
        }, 10)
      })

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      let addr = server.address() as net.AddressInfo

      try {
        let client = new ClamAvScannerClient({
          host: '127.0.0.1',
          port: addr.port,
          timeoutMs: 1000,
        })

        let buffer = Buffer.from('Harmless ship drawing metadata', 'utf8')
        let result = await client.scanBuffer(buffer, 'drawing.pdf')

        assert.equal(result.status, 'clean')
        assert.equal(result.scannerEngine, 'clamav')
        assert.equal(result.fileByteSize, buffer.length)
      } finally {
        server.close()
      }
    })

    it('identifies malware over TCP clamd protocol (stream: <threat> FOUND)', async () => {
      let server = net.createServer((socket) => {
        socket.on('data', () => {})
        setTimeout(() => {
          socket.write(Buffer.from('stream: Win.Trojan.Agent-12345 FOUND\0', 'utf8'))
          socket.end()
        }, 10)
      })

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      let addr = server.address() as net.AddressInfo

      try {
        let client = new ClamAvScannerClient({
          host: '127.0.0.1',
          port: addr.port,
          timeoutMs: 1000,
        })

        let buffer = Buffer.from('Simulated trojan binary chunk', 'utf8')
        let result = await client.scanBuffer(buffer, 'suspicious.exe')

        assert.equal(result.status, 'infected')
        assert.equal(result.threatName, 'Win.Trojan.Agent-12345')
        assert.equal(result.scannerEngine, 'clamav')
      } finally {
        server.close()
      }
    })

    it('handles clamd timeout and error fail-closed', async () => {
      // Create server that never replies
      let server = net.createServer((_socket) => {
        // Intentionally silent
      })

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      let addr = server.address() as net.AddressInfo

      try {
        let client = new ClamAvScannerClient({
          host: '127.0.0.1',
          port: addr.port,
          timeoutMs: 50, // Short timeout
        })

        let buffer = Buffer.from('test', 'utf8')
        let result = await client.scanBuffer(buffer, 'test.txt')

        assert.equal(result.status, 'error')
        assert.match(String(result.details?.error), /timed out/i)
      } finally {
        server.close()
      }

      // Connection error when socket is dead
      let deadClient = new ClamAvScannerClient({
        host: '127.0.0.1',
        port: 59999,
        timeoutMs: 50,
      })
      let deadRes = await deadClient.scanBuffer(Buffer.from('test', 'utf8'), 'test.txt')
      assert.equal(deadRes.status, 'error')
      assert.ok(deadRes.details?.error)
    })

    it('resolves immediately when clamd sends stream: OK\\0 without closing connection', async () => {
      let server = net.createServer((socket) => {
        socket.on('data', () => {})
        setTimeout(() => {
          // Do NOT close socket, send response with \0
          socket.write(Buffer.from('stream: OK\0', 'utf8'))
        }, 10)
      })

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      let addr = server.address() as net.AddressInfo

      try {
        let client = new ClamAvScannerClient({
          host: '127.0.0.1',
          port: addr.port,
          timeoutMs: 2000,
        })

        let start = Date.now()
        let result = await client.scanBuffer(Buffer.from('clean metadata', 'utf8'), 'clean.pdf')
        let duration = Date.now() - start

        assert.equal(result.status, 'clean')
        // Must resolve promptly via delimiter check rather than waiting for 2000ms timeout
        assert.ok(duration < 1000, `Expected duration < 1000ms, was ${duration}ms`)
      } finally {
        server.close()
      }
    })

    it('identifies malware when clamd detects threat on first chunk and terminates socket during streaming', async () => {
      let server = net.createServer((socket) => {
        let receivedFirst = false
        socket.on('data', () => {
          if (!receivedFirst) {
            receivedFirst = true
            // Immediately send threat response and destroy socket while client is still streaming chunks
            socket.write(Buffer.from('stream: Win.Exploit.Dropper-99 FOUND\0', 'utf8'))
            socket.destroy()
          }
        })
      })

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      let addr = server.address() as net.AddressInfo

      try {
        let client = new ClamAvScannerClient({
          host: '127.0.0.1',
          port: addr.port,
          chunkSize: 128,
          timeoutMs: 2000,
        })

        // 10KB buffer so multiple chunks are streamed
        let largeBuffer = Buffer.alloc(10 * 1024, 'A')
        let result = await client.scanBuffer(largeBuffer, 'dropper.bin')

        // Must report infected, not error!
        assert.equal(result.status, 'infected')
        assert.equal(result.threatName, 'Win.Exploit.Dropper-99')
      } finally {
        server.close()
      }
    })

    it('identifies malware even if clamd response contains both FOUND and trailing OK', async () => {
      let server = net.createServer((socket) => {
        socket.on('data', () => {})
        setTimeout(() => {
          // Compound or multiline clamd response ending in OK
          socket.write(Buffer.from('stream: Win.Trojan.NotOK FOUND\nstream: OK\0', 'utf8'))
          socket.end()
        }, 10)
      })

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      let addr = server.address() as net.AddressInfo

      try {
        let client = new ClamAvScannerClient({
          host: '127.0.0.1',
          port: addr.port,
          timeoutMs: 1000,
        })

        let buffer = Buffer.from('Suspicious compound content', 'utf8')
        let result = await client.scanBuffer(buffer, 'compound.exe')

        // Must NEVER report clean when a threat is found!
        assert.equal(result.status, 'infected')
        assert.equal(result.threatName, 'Win.Trojan.NotOK')
        assert.equal(result.scannerEngine, 'clamav')
        assert.equal(result.engineVersion, 'ClamAV 1.4.1')
        assert.equal(result.signatureVersion, '27000')
      } finally {
        server.close()
      }
    })

    it('fails immediately when clamd returns unrecognized delimited response without waiting for timeout', async () => {
      let server = net.createServer((socket) => {
        socket.on('data', () => {})
        setTimeout(() => {
          // Delimited response that does not match OK or FOUND
          socket.write(Buffer.from('UNKNOWN CLAMD PROTOCOL RESPONSE\0', 'utf8'))
        }, 10)
      })

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      let addr = server.address() as net.AddressInfo

      try {
        let client = new ClamAvScannerClient({
          host: '127.0.0.1',
          port: addr.port,
          timeoutMs: 2000, // 2-second timeout
        })

        let start = Date.now()
        let result = await client.scanBuffer(Buffer.from('test', 'utf8'), 'test.txt')
        let elapsed = Date.now() - start

        assert.equal(result.status, 'error')
        assert.match(String(result.details?.error), /UNKNOWN CLAMD PROTOCOL RESPONSE/i)
        assert.ok(elapsed < 1000, `Expected immediate error without waiting 2000ms, took ${elapsed}ms`)
      } finally {
        server.close()
      }
    })

    it('fails closed when clamd daemon half-opens connection and hangs indefinitely', async () => {
      let server = net.createServer((socket) => {
        socket.on('data', () => {
          // Send incomplete stream prefix then hang completely without closing or timing out
          socket.write(Buffer.from('stream: ', 'utf8'))
        })
      })

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      let addr = server.address() as net.AddressInfo

      try {
        let client = new ClamAvScannerClient({
          host: '127.0.0.1',
          port: addr.port,
          timeoutMs: 80, // Fast test watchdog
        })

        let start = Date.now()
        let result = await client.scanBuffer(Buffer.from('hanging data chunk', 'utf8'), 'hang.txt')
        let elapsed = Date.now() - start

        assert.equal(result.status, 'error')
        assert.equal(result.scannerEngine, 'clamav')
        assert.equal(result.engineVersion, 'ClamAV 1.4.1')
        assert.equal(result.signatureVersion, '27000')
        assert.match(String(result.details?.error), /timed out/i)
        assert.ok(elapsed >= 70 && elapsed < 2000, `Expected watchdog timeout near 80ms, took ${elapsed}ms`)
      } finally {
        server.close()
      }
    })
  })

  describe('AzureDefenderScannerClient', () => {
    it('scans clean buffer and identifies EICAR signature', async () => {
      let client = new AzureDefenderScannerClient()

      let cleanRes = await client.scanBuffer(Buffer.from('Clean survey attachment', 'utf8'), 'report.pdf')
      assert.equal(cleanRes.status, 'clean')
      assert.equal(cleanRes.scannerEngine, 'defender')

      let eicarRes = await client.scanBuffer(Buffer.from(EICAR_STANDARD_SIGNATURE, 'binary'), 'bad.bin')
      assert.equal(eicarRes.status, 'infected')
      assert.equal(eicarRes.threatName, 'Virus:DOS/EICAR_Test_File')
    })

    it('parses Microsoft Defender Blob Index Tags correctly', () => {
      let cleanTags = {
        'Malware Scanning scan result': 'No threats found',
        'Malware Scanning scan time UTC': '2026-11-01T01:00:00Z',
      }
      let cleanParsed = AzureDefenderScannerClient.parseBlobTags(cleanTags)
      assert.equal(cleanParsed.status, 'clean')
      assert.equal(cleanParsed.scanTimeUtc, '2026-11-01T01:00:00Z')

      let infectedTags = {
        'Malware Scanning scan result': 'Malicious',
        'Malware Scanning scan time UTC': '2026-11-02T12:00:00Z',
        'Malware Scanning scan result details': JSON.stringify({
          threatType: 'Trojan',
          threatName: 'Trojan:Win32/Wacatac.B!ml',
        }),
      }
      let infectedParsed = AzureDefenderScannerClient.parseBlobTags(infectedTags)
      assert.equal(infectedParsed.status, 'infected')
      assert.equal(infectedParsed.threatName, 'Trojan:Win32/Wacatac.B!ml')
      assert.equal(infectedParsed.scanTimeUtc, '2026-11-02T12:00:00Z')
      assert.equal(infectedParsed.details?.threatType, 'Trojan')

      let missingParsed = AzureDefenderScannerClient.parseBlobTags({})
      assert.equal(missingParsed.status, 'error')
    })
  })

  describe('Scanner Factory and Singleton Accessor', () => {
    function withProd<T>(value: string | undefined, run: () => T): T {
      let prevEnv = process.env.NODE_ENV
      let prevForce = process.env.MMS_FORCE_PROD_STORAGE
      if (value === undefined) {
        delete process.env.NODE_ENV
        delete process.env.MMS_FORCE_PROD_STORAGE
      } else {
        process.env.NODE_ENV = value
        process.env.MMS_FORCE_PROD_STORAGE = '1'
      }
      try {
        return run()
      } finally {
        process.env.NODE_ENV = prevEnv
        if (prevForce === undefined) delete process.env.MMS_FORCE_PROD_STORAGE
        else process.env.MMS_FORCE_PROD_STORAGE = prevForce
      }
    }

    // ADR-0023 §4: the silent fallback to the mock made a misconfigured
    // deployment report every file clean. Production must fail closed instead.
    it('refuses the mock scanner in production', () => {
      withProd('production', () => {
        assert.throws(() => createMalwareScanner('mock'), /MALWARE_SCANNER_TYPE/)
      })
    })

    it('refuses an unset or unknown scanner type in production', () => {
      withProd('production', () => {
        assert.throws(() => createMalwareScanner(''), /MALWARE_SCANNER_TYPE/)
        assert.throws(() => createMalwareScanner('nonsense'), /unknown MALWARE_SCANNER_TYPE/)
      })
    })

    it('allows a real scanner in production', () => {
      withProd('production', () => {
        assert.equal(createMalwareScanner('clamav').name, 'clamav')
        assert.throws(
          () => createMalwareScanner('defender'),
          /MALWARE_SCANNER_TYPE=defender is not yet implemented for production/,
        )
      })
    })

    it('creates appropriate scanner type by argument or env', () => {
      let mockScanner = createMalwareScanner('mock')
      assert.equal(mockScanner.name, 'mock')

      let clamScanner = createMalwareScanner('clamav')
      assert.equal(clamScanner.name, 'clamav')

      let defenderScanner = createMalwareScanner('defender')
      assert.equal(defenderScanner.name, 'defender')

      // getMalwareScanner returns default mock
      let current = getMalwareScanner()
      assert.ok(current)

      let customMock = new MockMalwareScannerClient()
      setMalwareScanner(customMock)
      assert.equal(getMalwareScanner(), customMock)

      setMalwareScanner(null) // Resets
    })
  })
})
