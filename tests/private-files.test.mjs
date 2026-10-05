import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { instanceStorage, writeDescriptor } from '../packages/remote/companion/src/private-files.ts'

const linux = process.platform === 'linux'
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-private-files-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  return base
}
const mode = async path => (await lstat(path)).mode & 0o777

test('activation repairs an owned group-writable DSH home and preserves stable identity', { skip: !linux }, async t => {
  const home = await fixture(t)
  await chmod(home, 0o775)
  const storage = await instanceStorage(home, 'default')
  assert.equal(await mode(home), 0o755)
  assert.equal(await mode(join(home, 'remote-workspace')), 0o700)
  assert.equal(await mode(join(home, 'remote-workspace/run')), 0o700)
  assert.equal(await mode(join(home, 'remote-workspace/instance-default.id')), 0o600)
  assert.equal((await instanceStorage(home, 'default')).instanceId, storage.instanceId)
  await writeDescriptor(storage.descriptorPath, { protocolVersion: 1, instanceKey: 'default', instanceId: storage.instanceId, bootId: 'fixture', profile: 'web', workspaceHint: '/fixture', port: 3080, launchUrl: 'http://127.0.0.1:3080/?token=fixture-only' })
  assert.equal(await mode(storage.descriptorPath), 0o600)
  assert.equal(JSON.parse(await readFile(storage.descriptorPath, 'utf8')).instanceId, storage.instanceId)
})

test('activation tightens reused private directories without changing a readable DSH home', { skip: !linux }, async t => {
  const home = await fixture(t)
  await chmod(home, 0o755)
  await mkdir(join(home, 'remote-workspace'), { mode: 0o755 })
  await mkdir(join(home, 'remote-workspace/run'), { mode: 0o755 })
  await chmod(join(home, 'remote-workspace'), 0o775)
  await instanceStorage(home, 'default')
  assert.equal(await mode(home), 0o755)
  assert.equal(await mode(join(home, 'remote-workspace')), 0o700)
  assert.equal(await mode(join(home, 'remote-workspace/run')), 0o700)
})

test('activation refuses symlinks without changing their target', { skip: !linux }, async t => {
  const base = await fixture(t)
  const target = join(base, 'target')
  await mkdir(target, { mode: 0o755 })
  const home = join(base, 'home')
  await symlink(target, home)
  await assert.rejects(instanceStorage(home, 'default'), /unsafe private directory/)
  await symlink(target, join(base, 'remote-workspace'))
  await assert.rejects(instanceStorage(base, 'default'), /unsafe private directory/)
  assert.equal(await mode(target), 0o755)
})

test('activation refuses world-writable directories and insecure existing identity files', { skip: !linux }, async t => {
  const home = await fixture(t)
  await chmod(home, 0o777)
  await assert.rejects(instanceStorage(home, 'default'), /unsafe private directory/)
  assert.equal(await mode(home), 0o777)
  await chmod(home, 0o700)
  await instanceStorage(home, 'default')
  const id = join(home, 'remote-workspace/instance-default.id')
  await chmod(id, 0o644)
  await assert.rejects(instanceStorage(home, 'default'), /unsafe private file/)
  assert.equal(await mode(id), 0o644)
})

test('activation refuses a directory owned by another user without changing its mode', { skip: !linux || process.getuid?.() !== 0 }, async t => {
  const home = await fixture(t)
  await chmod(home, 0o775)
  await chown(home, 1, 1)
  await assert.rejects(instanceStorage(home, 'default'), /unsafe private directory/)
  assert.equal(await mode(home), 0o775)
  assert.equal((await lstat(home)).uid, 1)
})
