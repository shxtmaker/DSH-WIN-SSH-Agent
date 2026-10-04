/** Validate the role-specific tarballs, installation metadata, and SHA-256 manifest. */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { root, project } from './runtime.mjs'

export function archiveEntries(bytes) {
  const tar = gunzipSync(bytes), entries = new Map()
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = header.subarray(0, 100).toString().replace(/\0.*$/u, '')
    const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/u, '').trim(), 8)
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid tar entry')
    if (header[156] === 0 || header[156] === 48) entries.set(name, tar.subarray(offset + 512, offset + 512 + size))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

export async function verifyArtifacts(directory = join(root, 'dist/remote')) {
  const names = project.artifacts.map(name => `harness-remote-${name}-${project.version}.tgz`)
  const actual = (await readdir(directory)).filter(name => name.endsWith('.tgz')).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...names].sort())) throw new Error('Artifact inventory does not match this project')
  const manifestText = (await readFile(join(directory, 'SHA256SUMS.txt'), 'utf8')).trim()
  const rows = manifestText === '' ? [] : manifestText.split(/\r?\n/u)
  if (rows.length !== names.length) throw new Error(`Expected exactly ${names.length} checksum entries`)
  const expected = new Set(names)
  for (const row of rows) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9.-]+\.tgz)$/u.exec(row)
    if (!match || !expected.delete(match[2])) throw new Error('Invalid or duplicate checksum entry')
    const bytes = await readFile(join(directory, match[2]))
    if (createHash('sha256').update(bytes).digest('hex') !== match[1]) throw new Error(`SHA-256 mismatch: ${match[2]}`)
    const entries = archiveEntries(bytes)
    const manifest = JSON.parse(entries.get('package/package.json')?.toString() ?? 'null')
    const packageName = match[2].slice('harness-remote-'.length, -(`-${project.version}.tgz`.length))
    if (manifest?.name !== `@harness-remote/${packageName}` || manifest.version !== project.version) throw new Error(`Package metadata mismatch: ${match[2]}`)
    if (!entries.has('package/lib/index.js') || !entries.has('package/lib/types/index.d.ts')) throw new Error(`Missing runtime or declarations: ${match[2]}`)
    for (const section of ['dependencies', 'peerDependencies']) {
      for (const [dependency, version] of Object.entries(manifest[section] ?? {})) {
        if (/^(workspace:|link:|file:)/u.test(version)) throw new Error(`Unresolved installation dependency: ${dependency}`)
        if (dependency.startsWith('@harness-remote/') && !project.artifacts.includes(dependency.slice('@harness-remote/'.length))) throw new Error(`Cross-project installation dependency: ${dependency}`)
      }
    }
    if (packageName === 'controller' && !['typert.host.js', 'typert.host.d.ts', 'typert.remote-client.js', 'typert.remote-client.d.ts'].every(name => entries.has(`package/lib/${name}`))) throw new Error('Missing controller protocol artifacts')
    if (packageName === 'client' && !entries.has('package/lib/client.js')) throw new Error('Missing Desktop Client bundle')
    if (['workspace', 'companion'].includes(packageName) && !entries.has('package/cordis.patch.yml')) throw new Error('Missing profile patch')
    if (packageName === 'companion' && !entries.has('package/bin/dsh-remote-info.mjs')) throw new Error('Missing restricted SSH helper')
  }
  return names
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  for (const name of await verifyArtifacts(resolve(root, process.argv[2] ?? 'dist/remote'))) console.log(`OK ${name}`)
}
