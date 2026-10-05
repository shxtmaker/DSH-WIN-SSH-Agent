/** Build this role against its pinned Harness workspace and pack installable plugins. */
import { mkdir, readFile, writeFile, readdir, cp, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { root, project, pnpm, workspace } from './runtime.mjs'
import { verifyArtifacts } from './verify-artifacts.mjs'
import { syncGitPackage } from './sync-git-package.mjs'

const { values } = parseArgs({ options: { workspace: { type: 'string' }, 'pack-only': { type: 'boolean', default: false }, offline: { type: 'boolean', default: false } } })
const target = workspace(values.workspace)
const identity = JSON.parse(await readFile(join(target, '.dsh-split-project.json'), 'utf8'))
const baseline = JSON.parse(await readFile(join(root, 'source-baseline.json'), 'utf8'))
if (identity.role !== project.role || identity.commit !== baseline.commit || JSON.stringify(identity.packages) !== JSON.stringify(project.packages)) throw new Error('Prepared workspace belongs to a different project or baseline')
if (!values['pack-only']) {
  pnpm(['install', '--frozen-lockfile', ...(values.offline ? ['--offline'] : [])], target)
  await cp(join(root, 'scripts/build-host.config.mjs'), join(target, 'tsdown.remote.config.mjs'))
  pnpm(['exec', 'tsc', '-b', 'packages/remote/companion/tsconfig.json'], target)
  pnpm(['exec', 'tsdown', '--config', 'tsdown.remote.config.mjs'], target)
}
const output = join(root, 'out/remote')
await mkdir(output, { recursive: true })
const allowed = project.artifacts.map(name => `harness-remote-${name}-${project.version}.tgz`)
for (const name of await readdir(output)) {
  if (name.endsWith('.tgz') && !allowed.includes(name)) throw new Error(`Unexpected existing tarball: ${name}`)
}
for (const name of project.packages) {
  // pnpm pack silently omits missing files, so require the build entry first.
  await lstat(join(target, `packages/remote/${name}/lib/index.js`))
  pnpm(['--dir', `packages/remote/${name}`, 'pack', '--pack-destination', output], target)
}
const sums = []
for (const name of [...allowed].sort()) sums.push(`${createHash('sha256').update(await readFile(join(output, name))).digest('hex')}  ${name}`)
await writeFile(join(output, 'SHA256SUMS.txt'), sums.join('\n') + '\n')
await cp(join(root, 'configs'), join(output, 'configs'), { recursive: true })
await writeFile(join(output, 'README.zh.md'), (await readFile(join(root, 'docs/INSTALL.md'), 'utf8')).replaceAll('../configs/', 'configs/'))
await verifyArtifacts(output)
await syncGitPackage(output)
console.log(`Packed ${project.project}: ${output}`)
