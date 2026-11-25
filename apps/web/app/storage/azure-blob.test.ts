import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import {
  createAzureBlobFileStorage,
  generateBlobSasToken,
} from './azure-blob.ts'

describe('Azure Blob Storage and SAS generation', () => {
  const dummyAccount = 'teststorageaccount'
  const dummyKey = Buffer.from('mock-storage-account-key-for-test-32bytes!!').toString('base64')
  const endpoint = `https://${dummyAccount}.blob.core.windows.net`
  const container = 'mms-quarantine'

  it('generates a write-only SAS token with short-lived expiration and write permission', () => {
    let expiresOn = new Date(Date.now() + 15 * 60 * 1000)
    let { token, urlQuery } = generateBlobSasToken({
      accountName: dummyAccount,
      accountKey: dummyKey,
      container,
      blobName: 'quarantine/upload-123/survey_plan.pdf',
      permissions: 'c', // create/write-only
      expiresOn,
    })

    assert.ok(token)
    assert.ok(urlQuery)

    let params = new URLSearchParams(urlQuery)
    // Permission MUST be write-only ('c')
    assert.equal(params.get('sp'), 'c')
    // MUST NOT have read ('r') or delete ('d') or list ('l')
    assert.ok(!params.get('sp')?.includes('r'), 'Write-only SAS must not include read permission')
    assert.ok(!params.get('sp')?.includes('d'), 'Write-only SAS must not include delete permission')
    assert.ok(!params.get('sp')?.includes('l'), 'Write-only SAS must not include list permission')

    // Resource must be blob
    assert.equal(params.get('sr'), 'b')
    // Storage version must be 2021-08-06
    assert.equal(params.get('sv'), '2021-08-06')
    // Protocol must be https or https,http
    assert.match(params.get('spr') || '', /https/)
    // Must contain signature
    assert.ok(params.get('sig'))
    // Expiry must match
    assert.ok(params.get('se'))
  })

  it('createAzureBlobFileStorage generates full write-only SAS URL with quarantine path', () => {
    let storage = createAzureBlobFileStorage({
      accountName: dummyAccount,
      accountKey: dummyKey,
      endpoint,
      container,
    })

    let sas = storage.generateWriteOnlySasUrl({
      blobName: 'quarantine/0192d7/specs.pdf',
      expiresInMinutes: 10,
      permissions: 'c',
    })

    assert.ok(sas.url.startsWith(`https://${dummyAccount}.blob.core.windows.net/${container}/quarantine/0192d7/specs.pdf?`))
    assert.match(sas.url, /sp=c/)
    assert.ok(!sas.url.includes('sp=r'))
    assert.ok(sas.expiresAt.getTime() > Date.now())
  })

  it('createAzureBlobFileStorage generates read-only SAS URL when requested', () => {
    let storage = createAzureBlobFileStorage({
      accountName: dummyAccount,
      accountKey: dummyKey,
      endpoint,
      container,
    })

    let sas = storage.generateReadOnlySasUrl({
      blobName: 'documents/survey_request/123/plans.pdf',
      expiresInMinutes: 30,
    })

    assert.ok(sas.url.includes('sp=r'))
    assert.ok(!sas.url.includes('sp=w'))
    assert.ok(!sas.url.includes('sp=c'))
  })

  it('FileStorage get, set, has, remove operations sign requests correctly', async () => {
    let interceptedRequests: { method: string; url: string; headers: Headers }[] = []

    let mockFetch: typeof fetch = async (input, init) => {
      let urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
      let method = init?.method ?? 'GET'
      let headers = new Headers(init?.headers as any)
      interceptedRequests.push({ method, url: urlStr, headers })

      if (method === 'HEAD') {
        if (urlStr.includes('exists.pdf')) {
          return new Response(null, { status: 200 })
        }
        return new Response(null, { status: 404 })
      }

      if (method === 'GET') {
        if (urlStr.includes('exists.pdf')) {
          return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), {
            status: 200,
            headers: { 'content-type': 'application/pdf' },
          })
        }
        return new Response('Not Found', { status: 404 })
      }

      if (method === 'PUT') {
        return new Response(null, { status: 201 })
      }

      if (method === 'DELETE') {
        return new Response(null, { status: 204 })
      }

      return new Response('Unsupported', { status: 500 })
    }

    let storage = createAzureBlobFileStorage({
      accountName: dummyAccount,
      accountKey: dummyKey,
      endpoint,
      container,
      fetch: mockFetch,
    })

    // 1. Check has
    let exists = await storage.has('exists.pdf')
    assert.equal(exists, true)
    let notExists = await storage.has('missing.pdf')
    assert.equal(notExists, false)

    // Verify Authorization header was generated with SharedKey
    let lastReq = interceptedRequests[interceptedRequests.length - 1]
    assert.ok(lastReq.headers.get('authorization')?.startsWith(`SharedKey ${dummyAccount}:`))
    assert.ok(lastReq.headers.get('x-ms-date'))

    // 2. Check set
    let dummyFile = new File([new Uint8Array([1, 2, 3])], 'test.bin', { type: 'application/octet-stream' })
    await storage.set('test.bin', dummyFile)

    let putReq = interceptedRequests[interceptedRequests.length - 1]
    assert.equal(putReq.method, 'PUT')
    assert.equal(putReq.headers.get('x-ms-blob-type'), 'BlockBlob')

    // 3. Check get
    let file = await storage.get('exists.pdf')
    assert.ok(file)
    assert.equal(file.type, 'application/pdf')
    let missingFile = await storage.get('missing.pdf')
    assert.equal(missingFile, null)

    // 4. Check remove
    await storage.remove('test.bin')
    let delReq = interceptedRequests[interceptedRequests.length - 1]
    assert.equal(delReq.method, 'DELETE')
  })
})
