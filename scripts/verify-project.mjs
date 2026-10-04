/** Reject mixed-role source trees and installation artifacts. */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { root, project } from './runtime.mjs'
import { verifyArtifacts } from './verify-artifacts.mjs'

const roles = {
  controller: { packages: ['bundle', 'client', 'controller'], artifacts: ['client', 'controller', 'workspace'], configs: ['ssh_config.macos.example', 'ssh_config.windows.example'] },
  agent: { packages: ['companion'], artifacts: ['companion'], configs: ['remote-helper.sh.example'] },
}
const expected = roles[project.role]
if (!expected) throw new Error('Unknown project role')
for (const key of ['packages', 'artifacts', 'configs']) {
  if (JSON.stringify([...project[key]].sort()) !== JSON.stringify(expected[key])) throw new Error(`Invalid role ${key}`)
}
const entries = (await readdir(join(root, 'packages/remote'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
if (JSON.stringify(entries) !== JSON.stringify(expected.packages)) throw new Error('Mixed-role source tree')
const configs = (await readdir(join(root, 'configs'))).sort()
if (JSON.stringify(configs) !== JSON.stringify(expected.configs)) throw new Error('Mixed-role configuration files')
const patch = await readFile(join(root, 'integration/upstream.patch'), 'utf8')
for (const match of patch.matchAll(/^\+.*packages\/remote\/([^/ :"]+)/gmu)) {
  if (!expected.packages.includes(match[1])) throw new Error(`Mixed-role build integration: ${match[1]}`)
}
await verifyArtifacts()
console.log(`OK ${project.project}: isolated source, configuration, build integration, and artifacts`)
