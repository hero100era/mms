import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
import type { Pool } from 'pg'

import type { Alerter } from './alerter.ts'

export interface CryptoShredPayload {
  enc: true
  alg: 'AES-256-GCM'
  subjectId: string
  iv: string // base64
  tag: string // base64
  ciphertext: string // base64
}

export class CryptoShreddedError extends Error {
  readonly subjectId: string

  constructor(subjectId: string) {
    super(`Cryptographic key for data subject ${subjectId} has been permanently shredded. Personal data is unrecoverable.`)
    this.name = 'CryptoShreddedError'
    this.subjectId = subjectId
  }
}

export interface KeyRecord {
  subjectId: string
  keyStatus: 'active' | 'shredded'
  algorithm: string
  keyBuffer: Buffer | null // null when shredded
  fingerprint: string
}

export interface CryptoShredderOptions {
  masterKey?: Buffer // 32-byte master key used to wrap DEKs
  pool?: Pool
  alerter?: Alerter
}

export class CryptoShredder {
  private readonly masterKey: Buffer
  private readonly pool?: Pool
  private readonly alerter?: Alerter
  private readonly memoryKeyStore = new Map<string, KeyRecord>()

  constructor(options: CryptoShredderOptions = {}) {
    this.alerter = options.alerter
    if (options.masterKey) {
      if (options.masterKey.length !== 32) {
        throw new Error('Master key must be exactly 32 bytes (256 bits)')
      }
      this.masterKey = options.masterKey
    } else {
      // Sourced from environment or default dev/test key
      let envKey = process.env.MMS_CRYPTO_SHRED_MASTER_KEY || process.env.CRYPTO_SHRED_MASTER_KEY
      if (envKey) {
        let keyBuf = Buffer.from(envKey, 'hex')
        if (keyBuf.length !== 32) {
          throw new Error('Master key from environment must be exactly 32 bytes (64 hex characters)')
        }
        this.masterKey = keyBuf
      } else if (process.env.NODE_ENV === 'production') {
        // This key wraps every DEK: a published default would let anyone holding
        // a database dump decrypt the data a shred was supposed to destroy.
        throw new Error('MMS_CRYPTO_SHRED_MASTER_KEY is required in production')
      } else {
        this.masterKey = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex')
      }
    }
    this.pool = options.pool
  }

  /**
   * Encrypts a Data Encryption Key (DEK) with the master key using AES-256-GCM
   */
  private wrapKey(dek: Buffer): string {
    let iv = randomBytes(12)
    let cipher = createCipheriv('aes-256-gcm', this.masterKey, iv)
    let wrapped = Buffer.concat([cipher.update(dek), cipher.final()])
    let tag = cipher.getAuthTag()
    return JSON.stringify({
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: wrapped.toString('base64'),
    })
  }

  /**
   * Decrypts a wrapped Data Encryption Key (DEK) using the master key
   */
  private unwrapKey(wrappedJson: string): Buffer {
    let { iv, tag, data } = JSON.parse(wrappedJson)
    let decipher = createDecipheriv('aes-256-gcm', this.masterKey, Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()])
  }

  /**
   * Gets or creates a Data Encryption Key for a specific subject
   */
  async getOrCreateKey(subjectId: string, options: { forceRefresh?: boolean } = {}): Promise<KeyRecord> {
    if (!subjectId || typeof subjectId !== 'string') {
      throw new Error('subjectId is required')
    }

    // Only use memoryKeyStore when no database pool is configured (unit tests).
    // In DB-backed multi-replica runtimes, always read authoritative key_status
    // from PostgreSQL so shredded keys are rejected immediately across all replicas.
    if (!this.pool) {
      let cached = this.memoryKeyStore.get(subjectId)
      if (cached) return cached
    }

    if (this.pool) {
      let client = await this.pool.connect()
      try {
        let fetchKey = async (): Promise<KeyRecord | null> => {
          let res = await client.query(
            'SELECT subject_id, key_status, algorithm, encrypted_key, key_fingerprint FROM audit_trail.crypto_shred_key WHERE subject_id = $1',
            [subjectId],
          )
          if (res.rows.length === 0) return null
          let row = res.rows[0]
          let keyBuffer: Buffer | null = null
          if (row.key_status === 'active') {
            keyBuffer = this.unwrapKey(row.encrypted_key)
          }
          let record: KeyRecord = {
            subjectId: row.subject_id,
            keyStatus: row.key_status,
            algorithm: row.algorithm,
            keyBuffer,
            fingerprint: row.key_fingerprint,
          }
          let prev = this.memoryKeyStore.get(subjectId)
          if (prev?.keyBuffer && prev.keyBuffer !== keyBuffer) {
            prev.keyBuffer.fill(0)
          }
          this.memoryKeyStore.set(subjectId, record)
          return record
        }

        let existing = await fetchKey()
        if (existing) return existing

        // Generate new key
        let dek = randomBytes(32)
        let fingerprint = createHash('sha256').update(dek).digest('hex')
        let wrapped = this.wrapKey(dek)
        dek.fill(0)

        await client.query(
          `INSERT INTO audit_trail.crypto_shred_key (subject_id, key_status, algorithm, encrypted_key, key_fingerprint)
           VALUES ($1, 'active', 'AES-256-GCM', $2, $3)
           ON CONFLICT (subject_id) DO NOTHING`,
          [subjectId, wrapped, fingerprint],
        )

        // Re-query using the same client (avoids pool deadlock under max=1)
        let created = await fetchKey()
        if (!created) throw new Error(`Failed to load crypto-shred key for subject ${subjectId}`)
        return created
      } finally {
        client.release()
      }
    }

    // In-memory fallback (when pool is not provided)
    let dek = randomBytes(32)
    let fingerprint = createHash('sha256').update(dek).digest('hex')
    let record: KeyRecord = {
      subjectId,
      keyStatus: 'active',
      algorithm: 'AES-256-GCM',
      keyBuffer: dek,
      fingerprint,
    }
    this.memoryKeyStore.set(subjectId, record)
    return record
  }

  /**
   * Encrypts plaintext personal data with the subject's dedicated key
   */
  async encryptField(subjectId: string, plaintext: string): Promise<CryptoShredPayload> {
    if (typeof plaintext !== 'string') {
      throw new Error('plaintext must be a string')
    }

    let key = await this.getOrCreateKey(subjectId, { forceRefresh: true })
    if (key.keyStatus === 'shredded' || !key.keyBuffer) {
      throw new CryptoShreddedError(subjectId)
    }

    let iv = randomBytes(12)
    let ciphertext: Buffer
    let tag: Buffer
    try {
      let cipher = createCipheriv('aes-256-gcm', key.keyBuffer, iv)
      ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      tag = cipher.getAuthTag()
    } finally {
      if (this.pool) key.keyBuffer.fill(0)
    }

    return {
      enc: true,
      alg: 'AES-256-GCM',
      subjectId,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }
  }

  /**
   * Decrypts ciphertext personal data.
   * Throws CryptoShreddedError if the subject's key has been shredded.
   */
  async decryptField(payload: CryptoShredPayload): Promise<string> {
    if (!payload || typeof payload !== 'object' || !payload.enc || payload.alg !== 'AES-256-GCM') {
      throw new Error(`Unsupported encryption payload format or algorithm: ${payload?.alg}`)
    }
    if (!payload.subjectId || !payload.iv || !payload.tag || !payload.ciphertext) {
      throw new Error('Encryption payload is missing required cryptographic fields')
    }

    let key = await this.getOrCreateKey(payload.subjectId, { forceRefresh: true })
    if (key.keyStatus === 'shredded' || !key.keyBuffer) {
      throw new CryptoShreddedError(payload.subjectId)
    }

    try {
      let decipher = createDecipheriv('aes-256-gcm', key.keyBuffer, Buffer.from(payload.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
      let decrypted = Buffer.concat([
        decipher.update(Buffer.from(payload.ciphertext, 'base64')),
        decipher.final(),
      ])
      return decrypted.toString('utf8')
    } finally {
      if (this.pool) key.keyBuffer.fill(0)
    }
  }

  /**
   * Executes cryptographic shredding for a subject by permanently destroying their DEK.
   * After this method runs, all data previously encrypted with this subject's key
   * is mathematically impossible to decrypt, preserving WORM immutability while
   * satisfying GDPR Article 17 / PIPL Article 47.
   */
  async shredSubjectKey(subjectId: string, reason: string): Promise<boolean> {
    if (!reason || reason.trim().length === 0) {
      throw new Error('Shred reason is required')
    }

    if (this.pool) {
      let client = await this.pool.connect()
      try {
        let res = await client.query('SELECT private.shred_subject_key($1, $2) as shredded', [
          subjectId,
          reason,
        ])
        let success = res.rows[0]?.shredded ?? false
        // Zeroize any cached memory buffer before replacing with shredded state
        let existing = this.memoryKeyStore.get(subjectId)
        if (existing?.keyBuffer) {
          existing.keyBuffer.fill(0)
        }
        // Update local memory cache
        this.memoryKeyStore.set(subjectId, {
          subjectId,
          keyStatus: 'shredded',
          algorithm: 'AES-256-GCM',
          keyBuffer: null,
          fingerprint: 'SHREDDED',
        })
        if (success && this.alerter) {
          await this.alerter.emit(
            'CRYPTO_SHRED_EXECUTED',
            'INFO',
            'CryptoShredder',
            `Personal data encryption key for subject ${subjectId} permanently shredded: ${reason}`,
            { subjectId, reason },
          )
        }
        return success
      } finally {
        client.release()
      }
    }

    // In-memory fallback
    let existing = this.memoryKeyStore.get(subjectId)
    if (existing) {
      if (existing.keyStatus === 'shredded') return false
      // Zeroize the buffer before releasing reference
      if (existing.keyBuffer) {
        existing.keyBuffer.fill(0)
      }
      this.memoryKeyStore.set(subjectId, {
        subjectId,
        keyStatus: 'shredded',
        algorithm: 'AES-256-GCM',
        keyBuffer: null,
        fingerprint: 'SHREDDED',
      })
      if (this.alerter) {
        await this.alerter.emit(
          'CRYPTO_SHRED_EXECUTED',
          'INFO',
          'CryptoShredder',
          `Personal data encryption key for subject ${subjectId} permanently shredded: ${reason}`,
          { subjectId, reason },
        )
      }
      return true
    }

    // If never generated in memory, create as shredded record
    this.memoryKeyStore.set(subjectId, {
      subjectId,
      keyStatus: 'shredded',
      algorithm: 'AES-256-GCM',
      keyBuffer: null,
      fingerprint: 'SHREDDED',
    })
    if (this.alerter) {
      await this.alerter.emit(
        'CRYPTO_SHRED_EXECUTED',
        'INFO',
        'CryptoShredder',
        `Personal data encryption key for subject ${subjectId} permanently shredded: ${reason}`,
        { subjectId, reason },
      )
    }
    return true
  }

  /**
   * Invalidates cached keys and zeroizes their buffers in memory
   */
  invalidateCache(subjectId?: string): void {
    if (subjectId) {
      let existing = this.memoryKeyStore.get(subjectId)
      if (existing?.keyBuffer) {
        existing.keyBuffer.fill(0)
      }
      this.memoryKeyStore.delete(subjectId)
    } else {
      for (let record of this.memoryKeyStore.values()) {
        if (record.keyBuffer) {
          record.keyBuffer.fill(0)
        }
      }
      this.memoryKeyStore.clear()
    }
  }

  /**
   * Helper to inspect key status without revealing key bytes
   */
  async getKeyStatus(subjectId: string): Promise<'active' | 'shredded' | 'not_found'> {
    if (this.pool) {
      let res = await this.pool.query<{ key_status: 'active' | 'shredded' }>(
        'SELECT key_status FROM audit_trail.crypto_shred_key WHERE subject_id = $1',
        [subjectId],
      )
      return res.rows[0]?.key_status ?? 'not_found'
    }
    return this.memoryKeyStore.get(subjectId)?.keyStatus ?? 'not_found'
  }
}
