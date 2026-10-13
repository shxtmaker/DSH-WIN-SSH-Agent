/** Publish the verified Companion runtime at the Git package's root. */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { root, project } from './runtime.mjs'
import { archiveEntries, verifyArtifacts } from './verify-artifacts.mjs'

/**
 * Helper modules that must ship at the Git package root.
 *
 * The restricted helper imports its own siblings, so publishing only `dsh-remote-info.mjs`
 * produces an installed helper that cannot start. This is an explicit allowlist: a new helper
 * module is not published until it is named here and in the Companion `files` list.
 */
export const HELPER_MODULES = ['dsh-remote-info.mjs', 'control-protocol.mjs', 'private-storage.mjs', 'service-manager.mjs']

/** @returns the Git-package destination for one archive entry, or undefined when not published. */
export function gitDestination(source) {
  if (source.startsWith('package/lib/')) return `runtime/${source.slice('package/lib/'.length)}`
  const helper = /^package\/bin\/([A-Za-z0-9._-]+\.mjs)$/u.exec(source)?.[1]
  if (helper !== undefined && HELPER_MODULES.includes(helper)) return `runtime/bin/${helper}`
  return undefined
}

export async function syncGitPackage(directory = join(root, 'dist/remote')) {
  await verifyArtifacts(directory)
  const archive = archiveEntries(await readFile(join(directory, `harness-remote-companion-${project.version}.tgz`)))
  const companion = JSON.parse(archive.get('package/package.json').toString())
  // The artifact's own manifest must already declare every helper module, otherwise the
  // published Git package would be incomplete even though this loop could copy it.
  for (const helper of HELPER_MODULES) {
    if (!companion.files?.includes(`bin/${helper}`)) {
      throw new Error(`Companion artifact does not declare bin/${helper} in files`)
    }
    if (!archive.has(`package/bin/${helper}`)) {
      throw new Error(`Companion artifact is missing bin/${helper}`)
    }
  }
  for (const [source, bytes] of archive) {
    const destination = gitDestination(source)
    if (!destination) continue
    const path = join(root, destination)
    await mkdir(dirname(path), { recursive: true })
    const mode = destination.includes('/bin/') ? 0o755 : 0o644
    await writeFile(path, bytes, { mode })
    // writeFile only applies `mode` when it creates the file, so an existing runtime file
    // would keep a stale mode. Set it explicitly so an installed helper stays executable.
    await chmod(path, mode)
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
