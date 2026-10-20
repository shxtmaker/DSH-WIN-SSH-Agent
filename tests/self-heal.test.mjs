/** Repair-loop regressions: deleted state must come back without a restart. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startSelfHeal } from '../packages/remote/companion/src/self-heal.ts'

const source = pathToFileURL(join(import.meta.dirname, '../packages/remote/companion/src/self-heal.ts')).href
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test('deleted state is repaired again without overlapping attempts', async () => {
  let present = false
  let repairs = 0
  let running = 0
  let peak = 0
  const stop = startSelfHeal({
    intervalMs: 2,
    ensure: async () => {
      running += 1
      peak = Math.max(peak, running)
      await wait(6)
      running -= 1
      if (!present) { present = true; repairs += 1 }
    },
    onError: () => {},
    isDisposed: () => false,
  })
  try {
    await wait(30)
    assert.equal(present, true)
    assert.ok(repairs >= 1, 'the first attempt must publish')
    present = false
    await wait(30)
    assert.equal(present, true, 'a deleted descriptor must be published again')
    assert.ok(repairs >= 2)
    assert.equal(peak, 1, 'repair attempts must never overlap')
  } finally { stop() }
})

test('a failed repair is reported and later attempts continue', async () => {
  const reported = []
  let attempts = 0
  let recovered = false
  const stop = startSelfHeal({
    intervalMs: 2,
    ensure: async () => {
      attempts += 1
      if (attempts <= 3) throw new Error('remote-companion: Web listener unavailable')
      recovered = true
    },
    onError: error => { reported.push(error.message) },
    isDisposed: () => false,
  })
  try {
    await wait(40)
    assert.equal(recovered, true, 'the loop must keep trying after a failure')
    assert.ok(attempts >= 4)
    assert.deepEqual(reported, Array(3).fill('remote-companion: Web listener unavailable'))
  } finally { stop() }
})

test('a disposed activation stops writing before the timer is cleared', async () => {
  let attempts = 0
  let disposed = false
  const stop = startSelfHeal({ intervalMs: 2, ensure: async () => { attempts += 1 }, onError: () => {}, isDisposed: () => disposed })
  try {
    await wait(20)
    assert.ok(attempts >= 1)
    disposed = true
    const seen = attempts
    await wait(20)
    assert.equal(attempts, seen)
  } finally { stop() }
})

test('the returned disposer stops the loop', async () => {
  let attempts = 0
  const stop = startSelfHeal({ intervalMs: 2, ensure: async () => { attempts += 1 }, onError: () => {}, isDisposed: () => false })
  await wait(20)
  assert.ok(attempts >= 1)
  stop()
  const seen = attempts
  await wait(20)
  assert.equal(attempts, seen)
})

test('an idle repair loop does not keep a short-lived profile load alive', () => {
  const script = `import { startSelfHeal } from ${JSON.stringify(source)}\n`
    + 'startSelfHeal({ intervalMs: 5, ensure: async () => {}, onError: () => {}, isDisposed: () => false })\n'
    + "console.log('scheduled')\n"
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
  assert.match(result.stdout, /scheduled/u)
})
