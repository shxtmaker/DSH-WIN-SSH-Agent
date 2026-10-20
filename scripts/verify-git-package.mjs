/** Guard the installable Git root against missing metadata and stale runtime copies. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { root, project } from './runtime.mjs'
import { archiveEntries } from './verify-artifacts.mjs'
import { HELPER_MODULES, gitDestination } from './sync-git-package.mjs'

export async function verifyGitPackage(directory = root) {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml', 'Git root must declare an installable Harness bundle')
  const patch = await readFile(join(directory, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes(`name: '${manifest.name}'`), 'Bundle must resolve its own Companion module')
  assert.ok(patch.includes('id: remote-workspace-companion'))
  assert.equal(manifest.main, 'runtime/index.js')
  assert.equal(manifest.types, 'runtime/types/index.d.ts')
  assert.equal(manifest.bin?.['dsh-remote-info'], 'runtime/bin/dsh-remote-info.mjs')
  assert.equal(manifest.exports?.['.']?.default, './runtime/index.js')
  assert.equal(manifest.exports?.['.']?.types, './runtime/types/index.d.ts')
  assert.equal(manifest.exports?.['./cordis.patch.yml'], './cordis.patch.yml')
  assert.equal(manifest.exports?.['./package.json'], './package.json')
  assert.deepEqual(manifest.files, ['runtime', 'cordis.patch.yml'])
  for (const name of ['prepare', 'preinstall', 'install', 'postinstall']) assert.equal(manifest.scripts?.[name], undefined, 'Git installation must not rebuild Harness')
  const entries = archiveEntries(await readFile(join(directory, `dist/remote/harness-remote-companion-${project.version}.tgz`)))
  const companion = JSON.parse(entries.get('package/package.json').toString())
  for (const section of ['dependencies', 'peerDependencies']) assert.deepEqual(manifest[section], companion[section], `Git package ${section} must match the verified Companion`)
  for (const [source, bytes] of entries) {
    const destination = gitDestination(source)
    if (destination) assert.ok((await readFile(join(directory, destination))).equals(bytes), `Stale Git runtime: ${destination}`)
  }
  // Every helper module the artifact declares must also exist at the Git package root,
  // otherwise an installed helper cannot import its own siblings.
  for (const helper of HELPER_MODULES) {
    assert.ok(companion.files?.includes(`bin/${helper}`), `Companion artifact must declare bin/${helper}`)
    assert.ok(entries.has(`package/bin/${helper}`), `Companion artifact must contain bin/${helper}`)
    const installed = await readFile(join(directory, `runtime/bin/${helper}`))
    assert.ok(installed.equals(entries.get(`package/bin/${helper}`)), `Missing or stale Git helper module: ${helper}`)
  }
}
