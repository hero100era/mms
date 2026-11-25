import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { sha256Hex } from './canonical.ts'
import { createAzureBlobFileStorage } from '../storage/azure-blob.ts'

export class WormStorageCollisionError extends Error {
  constructor(path: string, existingHash: string, newHash: string) {
    super(`WORM storage collision at ${path}: existing sha256 ${existingHash} differs from new sha256 ${newHash}`)
    this.name = 'WormStorageCollisionError'
  }
}

export class WormStorageViolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WormStorageViolationError'
  }
}

export interface WormStorage {
  write(path: string, content: Buffer | Uint8Array | string): Promise<{ uri: string; sha256Hex: string }>
  read(path: string): Promise<Buffer | null>
  exists(path: string): Promise<boolean>
  list(prefix?: string): Promise<string[]>
}

export class MemoryWormStorage implements WormStorage {
  private store = new Map<string, { buffer: Buffer; sha256Hex: string; createdAt: Date }>()

  async write(filePath: string, content: Buffer | Uint8Array | string): Promise<{ uri: string; sha256Hex: string }> {
    let buffer = Buffer.isBuffer(content)
      ? content
      : typeof content === 'string'
        ? Buffer.from(content, 'utf8')
        : Buffer.from(content)

    let digest = sha256Hex(buffer)
    let existing = this.store.get(filePath)

    if (existing) {
      if (existing.sha256Hex === digest) {
        // Idempotent resume: identical content already written
        return { uri: filePath, sha256Hex: digest }
      }
      throw new WormStorageCollisionError(filePath, existing.sha256Hex, digest)
    }

    this.store.set(filePath, {
      buffer,
      sha256Hex: digest,
      createdAt: new Date(),
    })

    return { uri: filePath, sha256Hex: digest }
  }

  async read(filePath: string): Promise<Buffer | null> {
    let entry = this.store.get(filePath)
    return entry ? Buffer.from(entry.buffer) : null
  }

  async exists(filePath: string): Promise<boolean> {
    return this.store.has(filePath)
  }

  async list(prefix = ''): Promise<string[]> {
    let keys: string[] = []
    for (let key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        keys.push(key)
      }
    }
    return keys.sort()
  }

  // Deletion is strictly forbidden on WORM storage
  async delete(filePath: string): Promise<never> {
    throw new WormStorageViolationError(`Deletion is strictly prohibited on immutable WORM storage: ${filePath}`)
  }

  // Clear helper for tests only
  _clearForTest(): void {
    this.store.clear()
  }

  // Direct tamper helper for test simulations only
  _tamperForTest(filePath: string, tamperedContent: string | Buffer): void {
    let buffer = Buffer.isBuffer(tamperedContent) ? tamperedContent : Buffer.from(tamperedContent, 'utf8')
    this.store.set(filePath, {
      buffer,
      sha256Hex: sha256Hex(buffer),
      createdAt: new Date(),
    })
  }
}

export class FileSystemWormStorage implements WormStorage {
  private baseDir: string

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? process.env.MMS_WORM_DIR ?? path.join(process.cwd(), '.worm')
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true })
    }
  }

  private resolveSafePath(filePath: string): string {
    let resolvedBase = path.resolve(this.baseDir)
    let fullPath = path.resolve(resolvedBase, filePath)
    if (fullPath !== resolvedBase && !fullPath.startsWith(resolvedBase + path.sep)) {
      throw new WormStorageViolationError(`Path traversal denied in WORM storage: ${filePath}`)
    }
    return fullPath
  }

  async write(filePath: string, content: Buffer | Uint8Array | string): Promise<{ uri: string; sha256Hex: string }> {
    let buffer = Buffer.isBuffer(content)
      ? content
      : typeof content === 'string'
        ? Buffer.from(content, 'utf8')
        : Buffer.from(content)

    let digest = sha256Hex(buffer)
    let fullPath = this.resolveSafePath(filePath)
    let parentDir = path.dirname(fullPath)

    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true })
    }

    try {
      // Atomic exclusive create ('wx') eliminates TOCTOU overwrite races.
      fs.writeFileSync(fullPath, buffer, { flag: 'wx', mode: 0o444 })
    } catch (err: any) {
      if (err?.code === 'EEXIST') {
        let existingBytes = fs.readFileSync(fullPath)
        let existingDigest = sha256Hex(existingBytes)
        if (existingDigest === digest) {
          return { uri: filePath, sha256Hex: digest }
        }
        throw new WormStorageCollisionError(filePath, existingDigest, digest)
      }
      throw err
    }

    try {
      fs.chmodSync(fullPath, 0o444)
    } catch {}

    return { uri: filePath, sha256Hex: digest }
  }

  async read(filePath: string): Promise<Buffer | null> {
    let fullPath = this.resolveSafePath(filePath)
    if (!fs.existsSync(fullPath)) return null
    return fs.readFileSync(fullPath)
  }

  async exists(filePath: string): Promise<boolean> {
    let fullPath = this.resolveSafePath(filePath)
    return fs.existsSync(fullPath)
  }

  async list(prefix = ''): Promise<string[]> {
    if (!fs.existsSync(this.baseDir)) return []
    let results: string[] = []
    function walk(dir: string, base: string) {
      for (let entry of fs.readdirSync(dir, { withFileTypes: true })) {
        let full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full, base)
        } else {
          let rel = path.relative(base, full)
          if (rel.startsWith(prefix)) {
            results.push(rel)
          }
        }
      }
    }
    walk(this.baseDir, this.baseDir)
    return results.sort()
  }

  async delete(filePath: string): Promise<never> {
    throw new WormStorageViolationError(`Deletion is strictly prohibited on immutable WORM storage: ${filePath}`)
  }
}

export class AzureWormStorage implements WormStorage {
  private azureStorage: ReturnType<typeof createAzureBlobFileStorage>
  private container: string

  constructor(options: {
    accountName: string
    accountKey: string
    endpoint: string
    container?: string
  }) {
    this.container = options.container ?? 'audit-worm'
    this.azureStorage = createAzureBlobFileStorage({
      accountName: options.accountName,
      accountKey: options.accountKey,
      endpoint: options.endpoint,
      container: this.container,
    })
  }

  async write(filePath: string, content: Buffer | Uint8Array | string): Promise<{ uri: string; sha256Hex: string }> {
    let buffer = Buffer.isBuffer(content)
      ? content
      : typeof content === 'string'
        ? Buffer.from(content, 'utf8')
        : Buffer.from(content)

    let digest = sha256Hex(buffer)

    let file = new File([new Uint8Array(buffer)], filePath.split('/').pop() || 'seal.jsonl', {
      type: 'application/x-ndjson',
    })
    try {
      // Atomic write-once via If-None-Match: * prevents concurrent overwrites
      await this.azureStorage.set(filePath, file, { ifNoneMatch: true })
    } catch (err: any) {
      if (err?.status === 409 || err?.status === 412) {
        let existingFile = await this.azureStorage.get(filePath)
        if (existingFile) {
          let existingBytes = Buffer.from(await existingFile.arrayBuffer())
          let existingDigest = sha256Hex(existingBytes)
          if (existingDigest === digest) {
            return { uri: filePath, sha256Hex: digest }
          }
          throw new WormStorageCollisionError(filePath, existingDigest, digest)
        }
      }
      throw err
    }

    return { uri: filePath, sha256Hex: digest }
  }

  async read(filePath: string): Promise<Buffer | null> {
    let file = await this.azureStorage.get(filePath)
    if (!file) return null
    let arrayBuffer = await file.arrayBuffer()
    return Buffer.from(arrayBuffer)
  }

  async exists(filePath: string): Promise<boolean> {
    return this.azureStorage.has(filePath)
  }

  async list(prefix = ''): Promise<string[]> {
    let keys: string[] = []
    let cursor: string | undefined
    do {
      let result = await this.azureStorage.list({ prefix, ...(cursor ? { cursor } : {}) })
      for (let f of result.files) keys.push(f.key)
      cursor = result.cursor
    } while (cursor)
    return keys.sort()
  }
}

let globalWormStorage: WormStorage | null = null

export function getWormStorage(): WormStorage {
  if (globalWormStorage) return globalWormStorage

  let allowAzurite = process.env.AZURITE_ENABLED === '1' && process.env.NODE_ENV !== 'production'
  let accountName = process.env.AZURE_STORAGE_ACCOUNT || (allowAzurite ? 'devstoreaccount1' : '')
  let accountKey = process.env.AZURE_STORAGE_KEY || (allowAzurite ? 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==' : '')
  let endpoint = process.env.AZURE_STORAGE_ENDPOINT || (allowAzurite ? 'http://127.0.0.1:10000/devstoreaccount1' : '')
  let container = process.env.AZURE_WORM_CONTAINER || 'audit-worm'

  if (accountName && accountKey && endpoint) {
    globalWormStorage = new AzureWormStorage({ accountName, accountKey, endpoint, container })
    return globalWormStorage
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Azure WORM storage (AZURE_STORAGE_ACCOUNT, AZURE_STORAGE_KEY, AZURE_STORAGE_ENDPOINT) is required in production',
    )
  }

  // Persistent FileSystem WORM storage by default for local CLI and dev only
  globalWormStorage = new FileSystemWormStorage()
  return globalWormStorage
}

export function setWormStorageForTest(storage?: WormStorage | null): void {
  globalWormStorage = storage ?? null
}
