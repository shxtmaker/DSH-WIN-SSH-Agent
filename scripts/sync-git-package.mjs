/** Publish the verified Companion runtime at the Git package's root. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { root, project } from './runtime.mjs'
import { archiveEntries, verifyArtifacts } from './verify-artifacts.mjs'

export async function syncGitPackage(directory = join(root, 'dist/remote')) {
  await verifyArtifacts(directory)
  const archive = archiveEntries(await readFile(join(directory, `harness-remote-companion-${project.version}.tgz`)))
  const companion = JSON.parse(archive.get('package/package.json').toString())
  for (const [source, bytes] of archive) {
    const destination = source.startsWith('package/lib/') ? `runtime/${source.slice('package/lib/'.length)}`
      : source === 'package/bin/dsh-remote-info.mjs' ? 'runtime/bin/dsh-remote-info.mjs' : undefined
    if (!destination) continue
    const path = join(root, destination)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes, { mode: destination.includes('/bin/') ? 0o755 : 0o644 })
  }
  const path = join(root, 'package.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  Object.assign(manifest, {
    main: 'runtime/index.js', types: 'runtime/types/index.d.ts',
    bin: { 'dsh-remote-info': 'runtime/bin/dsh-remote-info.mjs' },
    exports: {
      '.': { types: './runtime/types/index.d.ts', default: './runtime/index.js' },
      './cordis.patch.yml': './cordis.patch.yml', './package.json': './package.json',
    },
    files: ['runtime', 'cordis.patch.yml'],
    dependencies: companion.dependencies, peerDependencies: companion.peerDependencies,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(join(root, 'cordis.patch.yml'), `- insert:\n    - id: remote-workspace-companion\n      name: '${manifest.name}'\n      config:\n        instanceKey: default\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === join(root, 'scripts/sync-git-package.mjs')) {
  await syncGitPackage(resolve(root, process.argv[2] ?? 'dist/remote'))
  console.log('OK Git package runtime synchronized from verified Companion artifact')
}
