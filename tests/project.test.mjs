import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { root, project } from '../scripts/runtime.mjs'
import { verifyArtifacts } from '../scripts/verify-artifacts.mjs'
import { verifyGitPackage } from '../scripts/verify-git-package.mjs'

test('the Git root is an installable bundle with the verified Companion runtime', async () => {
  await verifyGitPackage()
})

async function gitFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-git-package-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const name of ['package.json', 'cordis.patch.yml', 'runtime', 'dist']) await cp(join(root, name), join(directory, name), { recursive: true })
  return directory
}

test('missing Git bundle metadata and stale runtime are rejected', async t => {
  const directory = await gitFixture(t)
  const path = join(directory, 'package.json')
  const original = await readFile(path, 'utf8')
  const manifest = JSON.parse(original)
  delete manifest.dsh
  await writeFile(path, JSON.stringify(manifest))
  await assert.rejects(verifyGitPackage(directory), /must declare an installable Harness bundle/u)
  await writeFile(path, original)
  await writeFile(join(directory, 'runtime/index.js'), 'stale')
  await assert.rejects(verifyGitPackage(directory), /Stale Git runtime/u)
})

test('the standalone project contains only its own role and installable packages', async () => {
  const result = spawnSync(process.execPath, [join(root, 'scripts/verify-project.mjs')], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  assert.equal((await verifyArtifacts()).length, project.artifacts.length)
})

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), `dsh-${project.role}-artifacts-`))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await cp(join(root, 'dist/remote'), directory, { recursive: true })
  return directory
}
test('a modified installation archive is rejected', async t => {
  const directory = await fixture(t)
  const name = `harness-remote-${project.artifacts[0]}-${project.version}.tgz`
  await writeFile(join(directory, name), 'modified')
  await assert.rejects(verifyArtifacts(directory), /SHA-256 mismatch/u)
})
test('an archive from the other role is rejected', async t => {
  const directory = await fixture(t)
  const other = project.role === 'controller' ? 'companion' : 'controller'
  await writeFile(join(directory, `harness-remote-${other}-${project.version}.tgz`), 'unexpected')
  await assert.rejects(verifyArtifacts(directory), /inventory/u)
})
test('duplicate or missing checksum rows are rejected', async t => {
  const directory = await fixture(t)
  const path = join(directory, 'SHA256SUMS.txt')
  const rows = (await readFile(path, 'utf8')).trim().split(/\r?\n/u)
  await writeFile(path, [...rows, rows[0]].join('\n') + '\n')
  await assert.rejects(verifyArtifacts(directory), /checksum entries/u)
  await writeFile(path, rows.slice(1).join('\n') + '\n')
  await assert.rejects(verifyArtifacts(directory), /checksum entries/u)
})
test('preparation refuses an existing workspace without overwriting its content', async t => {
  await mkdir(join(root, '.build'), { recursive: true })
  const directory = await mkdtemp(join(root, '.build', 'prepare-existing-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const sentinel = join(directory, 'sentinel')
  await writeFile(sentinel, 'preserved')
  const result = spawnSync(process.execPath, [join(root, 'scripts/prepare-upstream.mjs'), directory], { encoding: 'utf8', windowsHide: true })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Destination already exists/u)
  assert.equal(await readFile(sentinel, 'utf8'), 'preserved')
})
