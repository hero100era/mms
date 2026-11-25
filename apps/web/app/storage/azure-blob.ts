import * as crypto from 'node:crypto'
import type { FileLike, FileStorage, ListOptions, ListResult } from 'remix/file-storage'

export interface AzureBlobOptions {
  accountName: string
  accountKey: string
  endpoint: string
  container: string
  fetch?: typeof fetch
}

export interface SasUrlOptions {
  container?: string
  blobName: string
  expiresInMinutes?: number
  permissions?: 'c' | 'w' | 'cw' | 'r'
}

const AZURE_STORAGE_VERSION = '2021-08-06'

/**
 * Generates an Azure Blob Shared Access Signature (SAS) token.
 */
export function generateBlobSasToken(
  options: {
    accountName: string
    accountKey: string
    container: string
    blobName: string
    permissions: string
    startsOn?: Date
    expiresOn: Date
    protocol?: 'https' | 'https,http'
  },
): { token: string; urlQuery: string } {
  let startsOn = options.startsOn ?? new Date(Date.now() - 5 * 60 * 1000)
  let st = startsOn.toISOString().replace(/\.\d{3}Z$/, 'Z')
  let se = options.expiresOn.toISOString().replace(/\.\d{3}Z$/, 'Z')
  let sp = options.permissions
  let sr = 'b'
  let sv = AZURE_STORAGE_VERSION
  let spr = options.protocol ?? (process.env.AZURITE_ENABLED === '1' && process.env.NODE_ENV !== 'production' ? 'https,http' : 'https')
  let canonicalResource = `/blob/${options.accountName}/${options.container}/${options.blobName}`

  // Azure Storage 2020-10-02+ StringToSign format for Blob SAS:
  // signedPermissions + "\n" +
  // signedStart + "\n" +
  // signedExpiry + "\n" +
  // canonicalizedResource + "\n" +
  // signedIdentifier + "\n" +
  // signedIP + "\n" +
  // signedProtocol + "\n" +
  // signedVersion + "\n" +
  // signedResource + "\n" +
  // signedSnapshotTime + "\n" +
  // signedEncryptionScope + "\n" +
  // rscc + "\n" +
  // rscd + "\n" +
  // rsce + "\n" +
  // rscl + "\n" +
  // rsct
  let stringToSign = [
    sp,
    st,
    se,
    canonicalResource,
    '', // signedIdentifier
    '', // signedIP
    spr,
    sv,
    sr,
    '', // signedSnapshotTime
    '', // signedEncryptionScope
    '', // rscc
    '', // rscd
    '', // rsce
    '', // rscl
    '', // rsct
  ].join('\n')

  let keyBuffer = Buffer.from(options.accountKey, 'base64')
  let sig = crypto.createHmac('sha256', keyBuffer).update(stringToSign, 'utf8').digest('base64')

  let params = new URLSearchParams({
    sv,
    sr,
    sp,
    st,
    se,
    spr,
    sig,
  })

  let urlQuery = params.toString()
  return { token: urlQuery, urlQuery }
}

/**
 * Creates a FileStorage adapter backed by Azure Blob Storage / Azurite using native Web APIs.
 */
export function createAzureBlobFileStorage(options: AzureBlobOptions): FileStorage<File> & {
  set(key: string, file: FileLike, options?: { ifNoneMatch?: boolean }): Promise<void>
  generateWriteOnlySasUrl(sasOptions: SasUrlOptions): { url: string; expiresAt: Date }
  generateReadOnlySasUrl(sasOptions: SasUrlOptions): { url: string; expiresAt: Date }
} {
  let customFetch = options.fetch ?? fetch
  let endpoint = options.endpoint.replace(/\/$/, '')
  let container = options.container
  let keyBuffer = Buffer.from(options.accountKey, 'base64')

  function getBlobUrl(key: string, containerName = container): string {
    return `${endpoint}/${containerName}/${key.replace(/^\//, '')}`
  }

  function signRequest(
    method: string,
    url: URL,
    headers: Record<string, string>,
  ): Record<string, string> {
    let now = new Date().toUTCString()
    headers['x-ms-date'] = now
    headers['x-ms-version'] = AZURE_STORAGE_VERSION

    let canonicalHeaders = Object.keys(headers)
      .filter((k) => k.toLowerCase().startsWith('x-ms-'))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map((k) => `${k.toLowerCase()}:${headers[k]}`)
      .join('\n')
    if (canonicalHeaders) canonicalHeaders += '\n'

    let pathPart = url.pathname
    // Ensure account name prefix in canonical resource
    let canonicalResource: string
    if (pathPart.startsWith(`/${options.accountName}`)) {
      canonicalResource = pathPart
    } else {
      canonicalResource = `/${options.accountName}${pathPart}`
    }

    let searchParams = Array.from(url.searchParams.entries()).sort(([a], [b]) =>
      a.localeCompare(b),
    )
    if (searchParams.length > 0) {
      canonicalResource += '\n' + searchParams.map(([k, v]) => `${k.toLowerCase()}:${v}`).join('\n')
    }

    let stringToSign = [
      method.toUpperCase(),
      headers['Content-Encoding'] ?? '',
      headers['Content-Language'] ?? '',
      headers['Content-Length'] ?? '',
      headers['Content-MD5'] ?? '',
      headers['Content-Type'] ?? '',
      '', // Date is blank because x-ms-date is present
      headers['If-Modified-Since'] ?? '',
      headers['If-Match'] ?? '',
      headers['If-None-Match'] ?? '',
      headers['If-Unmodified-Since'] ?? '',
      headers['Range'] ?? '',
      canonicalHeaders + canonicalResource,
    ].join('\n')

    let sig = crypto.createHmac('sha256', keyBuffer).update(stringToSign, 'utf8').digest('base64')
    headers['Authorization'] = `SharedKey ${options.accountName}:${sig}`
    return headers
  }

  return {
    async get(key: string): Promise<File | null> {
      let url = new URL(getBlobUrl(key))
      let headers: Record<string, string> = {}
      signRequest('GET', url, headers)

      let res = await customFetch(url.toString(), { method: 'GET', headers })
      if (res.status === 404) return null
      if (!res.ok) {
        throw new Error(`AzureBlob.get failed: ${res.status} ${res.statusText}`)
      }

      let arrayBuffer = await res.arrayBuffer()
      let contentType = res.headers.get('content-type') || 'application/octet-stream'
      let fileName = key.split('/').pop() || 'file'
      return new File([arrayBuffer], fileName, { type: contentType })
    },

    async has(key: string): Promise<boolean> {
      let url = new URL(getBlobUrl(key))
      let headers: Record<string, string> = {}
      signRequest('HEAD', url, headers)

      let res = await customFetch(url.toString(), { method: 'HEAD', headers })
      if (res.status === 404) return false
      return res.ok
    },

    async set(key: string, file: FileLike, options?: { ifNoneMatch?: boolean }): Promise<void> {
      let url = new URL(getBlobUrl(key))
      let headers: Record<string, string> = {
        'x-ms-blob-type': 'BlockBlob',
        'Content-Type': file.type || 'application/octet-stream',
        ...(options?.ifNoneMatch ? { 'If-None-Match': '*' } : {}),
      }
      let body: any
      let streamAvailable = typeof (file as any).stream === 'function' && typeof file.size === 'number'
      if (streamAvailable) {
        headers['Content-Length'] = String(file.size)
        body = (file as any).stream()
      } else {
        let buffer = Buffer.from(await file.arrayBuffer())
        headers['Content-Length'] = String(buffer.byteLength)
        body = buffer
      }
      signRequest('PUT', url, headers)

      let res = await customFetch(url.toString(), {
        method: 'PUT',
        headers,
        body,
        ...(streamAvailable ? { duplex: 'half' as const } : {}),
      })
      if (!res.ok) {
        let err = new Error(`AzureBlob.set failed: ${res.status} ${res.statusText}`) as Error & { status?: number }
        err.status = res.status
        throw err
      }
    },

    async put(key: string, file: FileLike): Promise<File> {
      await this.set(key, file)
      let stored = await this.get(key)
      if (!stored) throw new Error(`AzureBlob.put failed: could not retrieve stored file`)
      return stored
    },

    async remove(key: string): Promise<void> {
      let url = new URL(getBlobUrl(key))
      let headers: Record<string, string> = {}
      signRequest('DELETE', url, headers)

      let res = await customFetch(url.toString(), { method: 'DELETE', headers })
      if (!res.ok && res.status !== 404) {
        throw new Error(`AzureBlob.remove failed: ${res.status} ${res.statusText}`)
      }
    },

    async list<T extends ListOptions>(options?: T): Promise<ListResult<T>> {
      let url = new URL(`${endpoint}/${container}?restype=container&comp=list`)
      if (options?.prefix) url.searchParams.set('prefix', options.prefix)
      if (options?.limit) url.searchParams.set('maxresults', String(options.limit))
      if (options?.cursor) url.searchParams.set('marker', options.cursor)

      let headers: Record<string, string> = {}
      signRequest('GET', url, headers)

      let res = await customFetch(url.toString(), { method: 'GET', headers })
      if (!res.ok) {
        throw new Error(`AzureBlob.list failed: ${res.status} ${res.statusText}`)
      }

      let xml = await res.text()
      let files: any[] = []
      let blobRegex = /<Blob>([\s\S]*?)<\/Blob>/g
      let match: RegExpExecArray | null

      while ((match = blobRegex.exec(xml)) !== null) {
        let blobXml = match[1]
        let nameMatch = /<Name>([\s\S]*?)<\/Name>/.exec(blobXml)
        if (!nameMatch) continue
        let key = nameMatch[1]

        if (options?.includeMetadata) {
          let lengthMatch = /<Content-Length>(\d+)<\/Content-Length>/.exec(blobXml)
          let typeMatch = /<Content-Type>([\s\S]*?)<\/Content-Type>/.exec(blobXml)
          let modifiedMatch = /<Last-Modified>([\s\S]*?)<\/Last-Modified>/.exec(blobXml)

          files.push({
            key,
            name: key.split('/').pop() || key,
            size: lengthMatch ? parseInt(lengthMatch[1], 10) : 0,
            type: typeMatch ? typeMatch[1] : 'application/octet-stream',
            lastModified: modifiedMatch ? new Date(modifiedMatch[1]).getTime() : Date.now(),
          })
        } else {
          files.push({ key })
        }
      }

      let nextMarkerMatch = /<NextMarker>([\s\S]*?)<\/NextMarker>/.exec(xml)
      let cursor = nextMarkerMatch && nextMarkerMatch[1] ? nextMarkerMatch[1] : undefined

      return { files, cursor } as ListResult<T>
    },

    generateWriteOnlySasUrl(sasOptions: SasUrlOptions): { url: string; expiresAt: Date } {
      let targetContainer = sasOptions.container ?? container
      let expiresInMinutes = sasOptions.expiresInMinutes ?? 15
      let expiresOn = new Date(Date.now() + expiresInMinutes * 60 * 1000)

      let { urlQuery } = generateBlobSasToken({
        accountName: options.accountName,
        accountKey: options.accountKey,
        container: targetContainer,
        blobName: sasOptions.blobName,
        permissions: sasOptions.permissions ?? 'c', // write-only 'create'
        expiresOn,
      })

      let baseUrl = getBlobUrl(sasOptions.blobName, targetContainer)
      return {
        url: `${baseUrl}?${urlQuery}`,
        expiresAt: expiresOn,
      }
    },

    generateReadOnlySasUrl(sasOptions: SasUrlOptions): { url: string; expiresAt: Date } {
      let targetContainer = sasOptions.container ?? container
      let expiresInMinutes = sasOptions.expiresInMinutes ?? 15
      let expiresOn = new Date(Date.now() + expiresInMinutes * 60 * 1000)

      let { urlQuery } = generateBlobSasToken({
        accountName: options.accountName,
        accountKey: options.accountKey,
        container: targetContainer,
        blobName: sasOptions.blobName,
        permissions: 'r', // read-only
        expiresOn,
      })

      let baseUrl = getBlobUrl(sasOptions.blobName, targetContainer)
      return {
        url: `${baseUrl}?${urlQuery}`,
        expiresAt: expiresOn,
      }
    },
  }
}
