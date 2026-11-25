import * as path from 'node:path'

import { psql, repoRoot, requireDatabaseUrl } from './lib.ts'

let url = requireDatabaseUrl()
psql(url, ['-f', path.join(repoRoot, 'db', 'fixtures', 'org.sql')])
console.log('applied db/fixtures/org.sql')
