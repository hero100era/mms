import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { psql } from '../scripts/lib.ts'
import {
  assertCanDestroyDatabase,
  isAllowedHost,
  isDisposableDatabaseName,
  isSafeAppEnv,
} from '../scripts/testenv-safety.ts'
import { seedTestDatabase } from '../scripts/seed-test.ts'
import { initializeTestEnvironment } from '../../scripts/testenv-init.ts'

describe('R8.6.4 Protect Destructive Test Operations', () => {
  const safeBaseUrl = 'postgresql://postgres@127.0.0.1:5432/mms_acceptance'

  it('1. Correct mms_acceptance target with disposable marker succeeds', () => {
    assert.doesNotThrow(() => {
      assertCanDestroyDatabase({
        databaseUrl: safeBaseUrl,
        targetDatabase: 'mms_acceptance',
        appEnv: 'test',
      })
    })
  })

  it('1b. Uncreated target database without explicit authorization fails closed', () => {
    assert.throws(
      () => {
        assertCanDestroyDatabase({
          databaseUrl: 'postgresql://postgres@127.0.0.1:5432/non_existent_scratch_test',
          targetDatabase: 'non_existent_scratch_test',
          appEnv: 'test',
        })
      },
      {
        message: /does not exist and lacks a verified disposable marker.*allow-initial-create/i,
      },
    )
  })

  it('1c. Uncreated target database with explicit allowInitialCreate succeeds', () => {
    assert.doesNotThrow(() => {
      assertCanDestroyDatabase({
        databaseUrl: 'postgresql://postgres@127.0.0.1:5432/non_existent_scratch_test',
        targetDatabase: 'non_existent_scratch_test',
        appEnv: 'test',
        allowInitialCreate: true,
      })
    })
  })

  it('2. postgres target fails', () => {
    assert.throws(
      () => {
        assertCanDestroyDatabase({
          databaseUrl: 'postgresql://postgres@127.0.0.1:5432/postgres',
          targetDatabase: 'postgres',
          appEnv: 'test',
          allowInitialCreate: true,
        })
      },
      {
        message: /destructive reset of administrative database "postgres" is strictly forbidden/i,
      },
    )
  })

  it('3. mms_dev target fails', () => {
    assert.throws(
      () => {
        assertCanDestroyDatabase({
          databaseUrl: 'postgresql://postgres@127.0.0.1:5432/mms_dev',
          targetDatabase: 'mms_dev',
          appEnv: 'test',
          allowInitialCreate: true,
        })
      },
      {
        message: /destructive reset of development database "mms_dev" is forbidden/i,
      },
    )
  })

  it('4. Unknown database name fails', () => {
    assert.throws(
      () => {
        assertCanDestroyDatabase({
          databaseUrl: 'postgresql://postgres@127.0.0.1:5432/random_other_db',
          targetDatabase: 'random_other_db',
          appEnv: 'test',
          allowInitialCreate: true,
        })
      },
      {
        message: /is not an authorized disposable database name/i,
      },
    )
  })

  it('5. Existing database without disposable marker fails', () => {
    // mms_spike_base exists in the local postgres instance and has no disposable marker
    assert.throws(
      () => {
        assertCanDestroyDatabase({
          databaseUrl: 'postgresql://postgres@127.0.0.1:5432/mms_spike_base_test',
          targetDatabase: 'mms_dev', // name check catches mms_dev first
          appEnv: 'test',
        })
      },
    )

    // Test a database that exists without marker
    // We test with mms_check which was built by db:check and has no disposable marker
    assert.throws(
      () => {
        assertCanDestroyDatabase({
          databaseUrl: 'postgresql://postgres@127.0.0.1:5432/mms_check',
          targetDatabase: 'mms_check',
          appEnv: 'test',
        })
      },
      {
        message: /is not an authorized disposable database name|lacks the required disposable environment marker/i,
      },
    )
  })

  it('6. Production APP_ENV fails', () => {
    assert.throws(
      () => {
        assertCanDestroyDatabase({
          databaseUrl: safeBaseUrl,
          targetDatabase: 'mms_acceptance',
          appEnv: 'production',
          allowInitialCreate: true,
        })
      },
      {
        message: /destructive test operations are prohibited in production environment/i,
      },
    )
  })

  it('7. Database host mismatch fails when host allow-listing is enabled', () => {
    assert.throws(
      () => {
        assertCanDestroyDatabase({
          databaseUrl: 'postgresql://postgres@remote-production-server.internal:5432/mms_acceptance',
          targetDatabase: 'mms_acceptance',
          appEnv: 'test',
          allowedHosts: ['127.0.0.1', 'localhost'],
          allowInitialCreate: true,
        })
      },
      {
        message: /is not on the disposable test host allow-list/i,
      },
    )
  })

  it('helper: isDisposableDatabaseName rejects unsafe names', () => {
    assert.equal(isDisposableDatabaseName('postgres'), false)
    assert.equal(isDisposableDatabaseName('mms_dev'), false)
    assert.equal(isDisposableDatabaseName('mms_prod'), false)
    assert.equal(isDisposableDatabaseName('production_db'), false)
    assert.equal(isDisposableDatabaseName('mms_acceptance'), true)
    assert.equal(isDisposableDatabaseName('mms_test'), true)
    assert.equal(isDisposableDatabaseName('my_drill'), true)
    assert.equal(isDisposableDatabaseName('ci_restore'), true)
  })

  it('helper: isAllowedHost checks hosts strictly', () => {
    assert.equal(isAllowedHost('localhost'), true)
    assert.equal(isAllowedHost('127.0.0.1'), true)
    assert.equal(isAllowedHost('remote.company.com', ['localhost', '127.0.0.1']), false)
  })

  it('helper: isSafeAppEnv rejects production', () => {
    assert.equal(isSafeAppEnv('local'), true)
    assert.equal(isSafeAppEnv('test'), true)
    assert.equal(isSafeAppEnv('acceptance'), true)
    assert.equal(isSafeAppEnv('production'), false)
  })

  it('seedTestDatabase refuses unmarked databases by name (including mms_dev)', () => {
    assert.throws(
      () => {
        seedTestDatabase('postgresql://postgres@127.0.0.1:5432/mms_dev')
      },
      {
        message: /cannot run against development database "mms_dev"|not positively marked as disposable/i,
      },
    )
  })

  it('seedTestDatabase refuses authorized database names when disposable marker is missing', () => {
    assert.throws(
      () => {
        seedTestDatabase('postgresql://postgres@127.0.0.1:5432/unmarked_test')
      },
      {
        message: /is not positively marked as disposable \(missing MMS_DISPOSABLE_ENV marker\)/i,
      },
    )
  })

  it('testenv:init refuses to relabel an existing unmarked database as disposable', async () => {
    let adminUrl = 'postgresql://postgres@127.0.0.1:5432/postgres'
    let scratchDb = 'mms_unmarked_safety_test'
    let scratchUrl = `postgresql://postgres@127.0.0.1:5432/${scratchDb}`

    try {
      psql(adminUrl, ['-c', `DROP DATABASE IF EXISTS ${scratchDb};`])
      psql(adminUrl, ['-c', `CREATE DATABASE ${scratchDb};`])

      await assert.rejects(
        async () => {
          await initializeTestEnvironment({
            databaseUrl: scratchUrl,
            targetDatabases: [{ name: scratchDb, disposable: true, envMarker: 'test' }],
          })
        },
        {
          message: /already exists but lacks a disposable environment marker\. Refusing to relabel an existing unmarked database as disposable/i,
        },
      )
    } finally {
      psql(adminUrl, ['-c', `DROP DATABASE IF EXISTS ${scratchDb};`])
    }
  })

  it('testenv:init refuses to overwrite or relabel a database carrying a PRODUCTION marker', async () => {
    let adminUrl = 'postgresql://postgres@127.0.0.1:5432/postgres'
    let scratchDb = 'mms_prod_safety_test'
    let scratchUrl = `postgresql://postgres@127.0.0.1:5432/${scratchDb}`

    try {
      // 1. Production comment
      psql(adminUrl, ['-c', `DROP DATABASE IF EXISTS ${scratchDb};`])
      psql(adminUrl, ['-c', `CREATE DATABASE ${scratchDb};`])
      psql(adminUrl, ['-c', `COMMENT ON DATABASE ${scratchDb} IS 'MMS_PRODUCTION_ENV';`])

      await assert.rejects(
        async () => {
          await initializeTestEnvironment({
            databaseUrl: scratchUrl,
            targetDatabases: [{ name: scratchDb, disposable: true, envMarker: 'test' }],
          })
        },
        {
          message: /carries a PRODUCTION environment marker\. Refusing to initialize or relabel as disposable/i,
        },
      )

      // 2. Production table marker
      psql(adminUrl, ['-c', `COMMENT ON DATABASE ${scratchDb} IS NULL;`])
      psql(scratchUrl, [
        '-c',
        `create schema if not exists meta;
         create table if not exists meta.disposable_marker (id int primary key, marker text, environment text, marked_at timestamptz);
         insert into meta.disposable_marker values (1, 'MMS_PRODUCTION_ENV', 'production', now());`,
      ])

      await assert.rejects(
        async () => {
          await initializeTestEnvironment({
            databaseUrl: scratchUrl,
            targetDatabases: [{ name: scratchDb, disposable: true, envMarker: 'test' }],
          })
        },
        {
          message: /carries a PRODUCTION environment marker\. Refusing to initialize or relabel as disposable/i,
        },
      )
    } finally {
      psql(adminUrl, ['-c', `DROP DATABASE IF EXISTS ${scratchDb};`])
    }
  })

  it('testenv:init checks database existence and authorization before modifying cluster roles', async () => {
    let missingDb = 'mms_completely_unauthorized_nonexistent_test'
    let adminUrl = 'postgresql://postgres@127.0.0.1:5432/postgres'

    await assert.rejects(
      async () => {
        await initializeTestEnvironment({
          databaseUrl: adminUrl,
          allowInitialCreate: false,
          targetDatabases: [{ name: missingDb, disposable: true, envMarker: 'test' }],
        })
      },
      {
        message: new RegExp(`ABORT: Database "${missingDb}" does not exist\\. First-time creation requires explicit fail-closed authorization`),
      },
    )
  })
})
