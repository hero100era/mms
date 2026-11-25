import * as fs from 'node:fs'
import * as path from 'node:path'

// npm hoists workspace dependencies to the repository root. Some Remix CLI
// commands resolve packages from the workspace directory itself, so give
// apps/web a link to the hoisted store when npm has not created one.
let root = path.resolve(import.meta.dirname, '..')
let link = path.join(root, 'apps', 'web', 'node_modules')
let target = path.join('..', '..', 'node_modules')

try {
  let stats = fs.lstatSync(link)
  if (stats.isSymbolicLink() || stats.isDirectory()) process.exit(0)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

fs.symlinkSync(target, link, 'dir')
