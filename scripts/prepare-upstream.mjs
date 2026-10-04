/** Restore the pinned Harness workspace and copy only this project's plugins. */
import { spawnSync } from 'node:child_process'
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { root, project, workspace } from './runtime.mjs'

const { values, positionals } = parseArgs({ options: { source: { type: 'string' } }, allowPositionals: true })
if (positionals.length > 1) throw new Error('Usage: node scripts/prepare-upstream.mjs [directory] [--source repository]')
const target = workspace(positionals[0])
try {
  await lstat(target)
  throw new Error('Destination already exists; choose a new .build/ directory')
} catch (error) { if (error.code !== 'ENOENT') throw error }
const baseline = JSON.parse(await readFile(join(root, 'source-baseline.json'), 'utf8'))
if (!/^[0-9a-f]{40}$/u.test(baseline.commit)) throw new Error('Invalid pinned commit')

function git(args, capture = false) {
  const result = spawnSync('git', ['-C', target, ...args], { shell: false, windowsHide: true, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args[0]} failed with exit code ${result.status}`)
  return result.stdout?.trim()
}
async function copyTree(source, destination) {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${entry.name}`)
    if (['node_modules', 'lib'].includes(entry.name) || entry.name.endsWith('.tsbuildinfo')) continue
    const from = join(source, entry.name), to = join(destination, entry.name)
    if (entry.isDirectory()) await copyTree(from, to)
    else if (entry.isFile()) await copyFile(from, to)
    else throw new Error(`Unsupported source entry: ${entry.name}`)
  }
}
await mkdir(target, { recursive: true })
git(['init'])
git(['remote', 'add', 'origin', baseline.repository])
git(['fetch', '--depth=1', values.source === undefined ? 'origin' : resolve(values.source), baseline.commit])
git(['checkout', '--detach', 'FETCH_HEAD'])
if (git(['rev-parse', 'HEAD'], true) !== baseline.commit) throw new Error('Pinned source verification failed')
const patch = join(root, 'integration/upstream.patch')
git(['apply', '--check', patch])
git(['apply', patch])
await copyTree(join(root, 'packages/remote'), join(target, 'packages/remote'))
// Package docs use release links in the standalone project and local links in Harness.
for (const [name, upstreamPath] of [
  ['bundle', 'apps/desktop'], ['client', 'packages/client/ui-sidebar-browser'],
]) {
  if (!project.packages.includes(name)) continue
  for (const suffix of ['.md', '.zh.md']) {
    const path = join(target, 'packages/remote', name, `README${suffix}`)
    const remote = `https://github.com/deepseek-ai/deepseek-harness/blob/${baseline.tag}/${upstreamPath}/README${suffix}`
    const local = name === 'bundle' ? `../../../${upstreamPath}/README${suffix}` : `../../client/ui-sidebar-browser/README${suffix}`
    await writeFile(path, (await readFile(path, 'utf8')).replaceAll(remote, local))
  }
}
await writeFile(join(target, '.dsh-split-project.json'), JSON.stringify({ role: project.role, commit: baseline.commit, packages: project.packages }) + '\n')
console.log(`Prepared ${project.project}: ${target} at ${baseline.commit}`)
