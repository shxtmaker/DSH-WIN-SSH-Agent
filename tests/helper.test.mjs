import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { root } from '../scripts/runtime.mjs'
const helper = join(root, 'packages/remote/companion/bin/dsh-remote-info.mjs')
function query(env, args = [], key = 'default') {
  return spawnSync(process.execPath, [helper, ...args], { input: JSON.stringify({ protocolVersion: 1, instanceKey: key }) + '\n', encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } })
}
test('the Linux-only helper refuses other platforms', { skip: process.platform === 'linux' }, () => {
  const result = query({})
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'LINUX_REQUIRED\n')
})
test('helper identity output omits the launch credential and rejects unsafe files and keys', { skip: process.platform !== 'linux' }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-companion-helper-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await chmod(home, 0o700)
  await mkdir(join(home, 'remote-workspace'), { mode: 0o700 })
  await mkdir(join(home, 'remote-workspace/run'), { mode: 0o700 })
  const path = join(home, 'remote-workspace/run/default.json')
  const descriptor = { protocolVersion: 1, instanceKey: 'default', instanceId: 'test-instance', bootId: 'test-boot', profile: 'remote-web', workspaceHint: '/test/workspace', port: 3080, launchUrl: 'http://127.0.0.1:3080/?token=test-only-private-credential' }
  await writeFile(path, JSON.stringify(descriptor) + '\n', { mode: 0o600 })
  const env = { DSH_HOME: home, DSH_REMOTE_INSTANCE_KEYS: 'default' }
  const identity = query(env, ['--identity'])
  assert.equal(identity.status, 0, identity.stderr)
  const expected = { ...descriptor }; delete expected.launchUrl
  assert.deepEqual(JSON.parse(identity.stdout), expected)
  assert.equal(query(env, [], 'other').stderr, 'BAD_INPUT\n')
  assert.deepEqual(JSON.parse(query(env).stdout), descriptor)
  await chmod(path, 0o644)
  const unsafe = query(env)
  assert.equal(unsafe.status, 1)
  assert.equal(unsafe.stdout, '')
  assert.equal(unsafe.stderr, 'UNSAFE_FILE\n')
})
