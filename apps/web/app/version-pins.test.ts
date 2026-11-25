import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../../..')

function readJson(filePath: string): {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  engines?: Record<string, string>
} {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

const manifests: Record<string, ReturnType<typeof readJson>> = {
  'root/package.json': readJson(path.join(repoRoot, 'package.json')),
  'apps/web/package.json': readJson(path.join(repoRoot, 'apps/web/package.json')),
  'packages/pgrst-client/package.json': readJson(path.join(repoRoot, 'packages/pgrst-client/package.json')),
  'packages/totp/package.json': readJson(path.join(repoRoot, 'packages/totp/package.json')),
}

const FLOATING = new Set(['latest', '*', ''])

describe('R8.3 toolchain pins', () => {
  // Third-party toolchain versions must be pinned. Workspace-internal packages
  // are deliberately `"*"`: npm links them from the local workspace and their
  // version is the one in the repository, not a registry range.
  const WORKSPACE_INTERNAL = /^@mms\//

  it('declares no floating or wildcard third-party dependency', () => {
    for (let [name, manifest] of Object.entries(manifests)) {
      for (let field of ['dependencies', 'devDependencies'] as const) {
        for (let [dependency, range] of Object.entries(manifest[field] ?? {})) {
          if (WORKSPACE_INTERNAL.test(dependency)) continue
          assert.ok(!FLOATING.has(range), `${name} ${field}.${dependency} must not be "${range}"`)
        }
      }
    }
  })

  it('pins TypeScript to an exact version everywhere it is declared', () => {
    for (let name of [
      'apps/web/package.json',
      'packages/pgrst-client/package.json',
      'packages/totp/package.json',
    ]) {
      let range = manifests[name]!.devDependencies?.typescript
      assert.ok(range, `${name} must declare typescript`)
      assert.match(range!, /^\d+\.\d+\.\d+$/, `${name} typescript must be an exact version`)
    }
  })

  it('pins remix to the exact version required by ADR-0002', () => {
    assert.equal(manifests['apps/web/package.json']!.dependencies?.remix, '3.3.0')
  })

  it('bounds the supported Node line rather than declaring an open minimum', () => {
    for (let name of ['root/package.json', 'apps/web/package.json']) {
      let node = manifests[name]!.engines?.node
      assert.ok(node, `${name} must declare engines.node`)
      assert.ok(node!.startsWith('^'), `${name} engines.node must bound the line, got "${node}"`)
    }
  })

  it('configures dependabot with critical framework and driver update guards', () => {
    let dependabotPath = path.join(repoRoot, '.github/dependabot.yml')
    assert.ok(existsSync(dependabotPath), '.github/dependabot.yml must exist')
    let dependabotContent = readFileSync(dependabotPath, 'utf8')
    assert.match(dependabotContent, /dependency-name:\s*"remix"/, 'remix must be guarded against auto-update')
    assert.match(dependabotContent, /dependency-name:\s*"typescript"/, 'typescript must be guarded')
    assert.match(dependabotContent, /dependency-name:\s*"pg"/, 'pg driver must be guarded')
  })

  it('enforces release:check within GitHub Actions CI workflow', () => {
    let ciPath = path.join(repoRoot, '.github/workflows/ci.yml')
    assert.ok(existsSync(ciPath), '.github/workflows/ci.yml must exist')
    let ciContent = readFileSync(ciPath, 'utf8')
    assert.match(ciContent, /npm run release:check/, 'CI workflow must execute release:check')
  })
})
