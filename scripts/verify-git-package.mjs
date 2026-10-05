/** Guard the installable Git root against missing metadata and stale runtime copies. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { root, project } from './runtime.mjs'
import { archiveEntries } from './verify-artifacts.mjs'

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
    const destination = source.startsWith('package/lib/') ? `runtime/${source.slice('package/lib/'.length)}`
      : source === 'package/bin/dsh-remote-info.mjs' ? 'runtime/bin/dsh-remote-info.mjs' : undefined
    if (destination) assert.deepEqual(await readFile(join(directory, destination)), bytes, `Stale Git runtime: ${destination}`)
  }
}
