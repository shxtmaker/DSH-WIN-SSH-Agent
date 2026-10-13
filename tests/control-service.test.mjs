/**
 * B05/B06 — restricted management helper: read-only status and recorded service actions.
 *
 * Runs under plain `node --test`. Every systemctl call goes through a fake executable written
 * into the throwaway fixture, so nothing here touches a real unit, a real user manager, sudo
 * or the live host.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const root = join(import.meta.dirname, '..')
const helper = join(root, 'packages/remote/companion/bin/dsh-remote-info.mjs')
const contract = JSON.parse(await readFile(join(root, 'docs/control-contract.json'), 'utf8'))

const UNIT = 'dsh-remote-web.service'
const SECOND_UNIT = 'dsh-remote-second.service'
const REVISION = 'rev-1'
const INSTANCE_ID = '11111111-2222-3333-4444-555555555555'
const KEY = 'default'
const MAX_RESPONSE_BYTES = contract.control.responseBytesMax
const CREDENTIAL = /(token=|Bearer |password|passwd|secret|api[_-]?key|authorization:|cookie:|BEGIN [A-Z ]*PRIVATE KEY)/iu

const REGISTRATION = 'remote-workspace/control/services.json'
const DESCRIPTOR = 'remote-workspace/run/default.json'
const OPERATIONS = 'remote-workspace/control/operations'
const LOCKS = 'remote-workspace/control/locks'

/** Fake systemctl boundary: records argv verbatim, then answers from the environment. */
const FAKE_SYSTEMCTL = [
  '#!/bin/sh',
  'log="${DSH_TEST_LOG:-/dev/null}"',
  '{',
  '  printf "invocation\\n"',
  '  i=1',
  '  for a in "$@"; do',
  '    printf "argv[%s]=%s\\n" "$i" "$a"',
  '    i=$((i + 1))',
  '  done',
  '} >> "$log"',
  'for a in "$@"; do',
  '  if [ "$a" = "show" ]; then',
  '    printf "%s\\n" "${DSH_TEST_SHOW_LOAD:-LoadState=loaded}"',
  '    printf "%s\\n" "${DSH_TEST_SHOW_ACTIVE:-ActiveState=inactive}"',
  '    printf "%s\\n" "${DSH_TEST_SHOW_SUB:-SubState=dead}"',
  '    if [ -n "${DSH_TEST_SHOW_STDERR:-}" ]; then printf "%s\\n" "$DSH_TEST_SHOW_STDERR" >&2; fi',
  '    exit "${DSH_TEST_SHOW_EXIT:-0}"',
  '  fi',
  'done',
  'if [ -n "${DSH_TEST_SLEEP:-}" ]; then exec sleep "$DSH_TEST_SLEEP"; fi',
  'printf "%s\\n" "${DSH_TEST_STDOUT:-}"',
  'if [ -n "${DSH_TEST_STDERR:-}" ]; then printf "%s\\n" "$DSH_TEST_STDERR" >&2; fi',
  'exit "${DSH_TEST_EXIT:-0}"',
  '',
].join('\n')

function operationId() {
  return `op-${randomUUID().replaceAll('-', '')}`
}

function registrationEntry(overrides = {}) {
  return { mode: 'systemd-user', unit: UNIT, profile: 'web', registrationRevision: REVISION, expectedInstanceId: INSTANCE_ID, ...overrides }
}

async function fixture(t, options = {}) {
  const {
    services = {
      schemaVersion: 1,
      instances: {
        [KEY]: registrationEntry(),
        second: registrationEntry({ unit: SECOND_UNIT }),
      },
    },
    servicesText,
    descriptor,
    identity = INSTANCE_ID,
    systemctl = 'fake',
    env: extraEnv = {},
    mode = 0o700,
  } = options
  const home = await mkdtemp(join(tmpdir(), 'dsh-control-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await chmod(home, 0o700)
  await mkdir(join(home, 'remote-workspace'), { mode: 0o700 })
  await mkdir(join(home, 'remote-workspace/run'), { mode: 0o700 })
  const controlDirectory = join(home, 'remote-workspace/control')
  await mkdir(controlDirectory, { mode: 0o700 })
  // mkdir modes are masked by umask, so the fixture must widen the directory explicitly.
  if (mode !== 0o700) await chmod(controlDirectory, mode)
  if (services !== null || servicesText !== undefined) {
    await writeFile(join(home, REGISTRATION), servicesText ?? `${JSON.stringify(services)}\n`, { mode: 0o600 })
  }
  if (identity !== null) await writeFile(join(home, 'remote-workspace/instance-default.id'), `${identity}\n`, { mode: 0o600 })
  if (descriptor !== undefined) {
    await writeFile(join(home, DESCRIPTOR), typeof descriptor === 'string' ? descriptor : `${JSON.stringify(descriptor)}\n`, { mode: 0o600 })
  }
  const fake = join(home, 'fake-systemctl.sh')
  if (systemctl === 'fake') await writeFile(fake, FAKE_SYSTEMCTL, { mode: 0o700 })
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_REMOTE_INSTANCE_KEYS: `${KEY},second`,
    DSH_TEST_LOG: join(home, 'systemctl.log'),
    ...extraEnv,
  }
  if (systemctl === 'fake') env.DSH_REMOTE_SYSTEMCTL = fake
  if (systemctl === 'missing') env.DSH_REMOTE_SYSTEMCTL = join(home, 'no-such-systemctl')
  if (systemctl === 'path') {
    delete env.DSH_REMOTE_SYSTEMCTL
    const empty = await mkdtemp(join(tmpdir(), 'dsh-empty-path-'))
    t.after(() => rm(empty, { recursive: true, force: true }))
    env.PATH = empty
  }
  return { home, env, fake, log: env.DSH_TEST_LOG, control: value => control(env, value) }
}

function control(env, value) {
  const input = typeof value === 'string' ? value : `${JSON.stringify(value)}\n`
  return spawnSync(process.execPath, [helper, '--control'], { input, encoding: 'utf8', windowsHide: true, env })
}

function envelope(result) {
  assert.equal(result.status, 0, `helper exited ${result.status}: ${result.stderr}`)
  assert.equal(result.stderr, '')
  assert.ok(result.stdout.endsWith('\n'), 'the response must be one terminated line')
  assert.equal(result.stdout.trimEnd().includes('\n'), false, 'the response must be exactly one line')
  assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= MAX_RESPONSE_BYTES, 'the response must stay inside its budget')
  assert.doesNotMatch(result.stdout, CREDENTIAL, 'a control response must never carry credential-looking text')
  const value = JSON.parse(result.stdout)
  assert.equal(value.controlVersion, contract.control.controlVersion)
  return value
}

function success(result) {
  const value = envelope(result)
  assert.equal(value.ok, true, `expected success: ${result.stdout}`)
  return value
}

function failure(result) {
  const value = envelope(result)
  assert.equal(value.ok, false, `expected failure: ${result.stdout}`)
  assert.ok(contract.errorCodes.includes(value.error.code), `undeclared error code ${value.error.code}`)
  assert.equal(typeof value.error.message, 'string')
  return value.error.code
}

function read(action, overrides = {}) {
  return { controlVersion: 1, action, instanceKey: KEY, ...overrides }
}

function write(action, overrides = {}) {
  return { controlVersion: 1, action, instanceKey: KEY, operationId: operationId(), issuedAt: new Date().toISOString(), registrationRevision: REVISION, ...overrides }
}

async function invocations(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const rows = []
  let current
  for (const line of text.split('\n')) {
    if (line === 'invocation') {
      current = []
      rows.push(current)
      continue
    }
    if (current === undefined || line === '') continue
    const index = line.indexOf('=')
    if (index > 0) current.push(line.slice(index + 1))
  }
  return rows
}

const showCalls = rows => rows.filter(argv => argv.includes('show'))
const actionCalls = rows => rows.filter(argv => !argv.includes('show'))

async function receiptFile(home, id, value) {
  await mkdir(join(home, OPERATIONS), { recursive: true, mode: 0o700 })
  await writeFile(join(home, OPERATIONS, `${id}.json`), `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

describe('discovery invocations stay byte-compatible', () => {
  const descriptor = {
    protocolVersion: 1, instanceKey: KEY, instanceId: INSTANCE_ID, bootId: 'boot-1', profile: 'remote-web',
    workspaceHint: '/home/harness/workspace', port: 3080, launchUrl: 'http://127.0.0.1:3080/?token=private-discovery-credential',
  }

  it('answers the full descriptor without an argument and the public identity with --identity', async t => {
    const world = await fixture(t, { descriptor })
    const full = spawnSync(process.execPath, [helper], {
      input: `${JSON.stringify({ protocolVersion: 1, instanceKey: KEY })}\n`, encoding: 'utf8', windowsHide: true, env: world.env,
    })
    assert.equal(full.status, 0, full.stderr)
    assert.equal(full.stderr, '')
    assert.deepEqual(JSON.parse(full.stdout), descriptor)
    const identity = spawnSync(process.execPath, [helper, '--identity'], {
      input: `${JSON.stringify({ protocolVersion: 1, instanceKey: KEY })}\n`, encoding: 'utf8', windowsHide: true, env: world.env,
    })
    assert.equal(identity.status, 0, identity.stderr)
    const expected = { ...descriptor }
    delete expected.launchUrl
    assert.deepEqual(JSON.parse(identity.stdout), expected)
  })

  it('keeps every other argument on the old BAD_INPUT path', async t => {
    const world = await fixture(t, { descriptor })
    const input = `${JSON.stringify({ protocolVersion: 1, instanceKey: KEY })}\n`
    for (const args of [['--other'], ['--identity', 'extra'], ['--control', 'extra'], ['--control', '--identity']]) {
      const result = spawnSync(process.execPath, [helper, ...args], { input, encoding: 'utf8', windowsHide: true, env: world.env })
      assert.equal(result.status, 1, `args ${args.join(' ')} must fail`)
      assert.equal(result.stdout, '')
      assert.equal(result.stderr, 'BAD_INPUT\n')
    }
    const empty = spawnSync(process.execPath, [helper], { input: '', encoding: 'utf8', windowsHide: true, env: world.env })
    assert.equal(empty.status, 1)
    assert.equal(empty.stderr, 'BAD_INPUT\n')
  })
})

describe('capabilities and read-only status', () => {
  it('reports the helper contract and the registered systemd mode', async t => {
    const world = await fixture(t)
    const value = success(world.control(read('capabilities')))
    assert.equal(value.action, 'capabilities')
    assert.equal(typeof value.helperVersion, 'string')
    assert.ok(value.helperVersion.length > 0 && value.helperVersion.length <= 64)
    assert.deepEqual(value.discoveryVersions, [1])
    assert.deepEqual([...value.actions].sort(), [...contract.control.actions].sort())
    assert.equal(value.mode, 'systemd-user')
    assert.equal((await invocations(world.log)).length, 1)
    assert.equal(showCalls(await invocations(world.log)).length, 1)
  })

  it('reports unregistered without touching systemctl', async t => {
    const world = await fixture(t, { services: { schemaVersion: 1, instances: {} } })
    const capabilities = success(world.control(read('capabilities')))
    assert.equal(capabilities.mode, 'unregistered')
    const status = success(world.control(read('status')))
    assert.equal(status.registered, false)
    assert.equal(status.mode, 'unregistered')
    assert.equal(status.service, undefined)
    assert.deepEqual(status.descriptor, { present: false, parsable: false })
    assert.equal(await invocations(world.log).then(rows => rows.length), 0)
    assert.equal(failure(world.control(write('start'))), 'SERVICE_UNREGISTERED')
    assert.equal(await invocations(world.log).then(rows => rows.length), 0)
  })

  it('answers status while the Harness Web process is not running', async t => {
    const world = await fixture(t, { descriptor: undefined, env: { DSH_TEST_SHOW_ACTIVE: 'ActiveState=active', DSH_TEST_SHOW_SUB: 'SubState=running' } })
    const value = success(world.control(read('status')))
    assert.equal(value.instanceKey, KEY)
    assert.equal(value.registered, true)
    assert.equal(value.mode, 'systemd-user')
    assert.equal(value.registrationRevision, REVISION)
    assert.equal(value.instanceId, INSTANCE_ID)
    assert.deepEqual(value.service, { unit: UNIT, loadState: 'loaded', activeState: 'active', subState: 'running', state: 'active' })
    assert.deepEqual(value.descriptor, { present: false, parsable: false })
    assert.equal(value.listener, undefined)
    assert.equal(value.loopback, undefined)
    assert.equal(new Date(value.checkedAt).toISOString(), value.checkedAt)
    const rows = await invocations(world.log)
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0], ['--user', 'show', UNIT, '--property=LoadState,ActiveState,SubState'])
  })

  it('reports the loopback listener and a live connect without leaking the launch URL', async t => {
    const server = createServer(() => {})
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const port = server.address().port
    const world = await fixture(t, {
      descriptor: {
        protocolVersion: 1, instanceKey: KEY, instanceId: INSTANCE_ID, bootId: 'boot-9', profile: 'remote-web',
        workspaceHint: '/home/harness/workspace', port, launchUrl: `http://127.0.0.1:${port}/?token=private-launch-credential`,
      },
    })
    const value = success(world.control(read('status')))
    assert.deepEqual(value.descriptor, { present: true, parsable: true, bootId: 'boot-9', instanceId: INSTANCE_ID })
    assert.deepEqual(value.listener, { host: '127.0.0.1', port, protocol: 'http:', supported: true })
    assert.equal(value.loopback.connectable, true)
    assert.equal(new Date(value.loopback.checkedAt).toISOString(), value.loopback.checkedAt)
    assert.equal(value.instanceId, INSTANCE_ID)
  })

  it('keeps a corrupt descriptor diagnostic only', async t => {
    const world = await fixture(t, { descriptor: '{"protocolVersion":1,' })
    const value = success(world.control(read('status')))
    assert.deepEqual(value.descriptor, { present: true, parsable: false })
    assert.equal(value.mode, 'systemd-user')
  })

  it('refuses an unsafe registration file instead of reading it', async t => {
    const world = await fixture(t)
    await chmod(join(world.home, REGISTRATION), 0o644)
    assert.equal(failure(world.control(read('status'))), 'UNSAFE_FILE')
    assert.equal(failure(world.control(read('capabilities'))), 'UNSAFE_FILE')
    assert.equal(await invocations(world.log).then(rows => rows.length), 0)
  })

  it('refuses a corrupt registration file', async t => {
    const world = await fixture(t, { services: null, servicesText: '{"schemaVersion":2,"instances":{}}\n' })
    assert.equal(failure(world.control(read('status'))), 'CONFIG_REQUIRED')
  })

  it('reports unsupported when systemctl is not installed', async t => {
    const world = await fixture(t, { systemctl: 'missing' })
    const status = success(world.control(read('status')))
    assert.equal(status.mode, 'unsupported')
    assert.equal(status.registered, true)
    assert.equal(status.service.state, 'unknown')
    assert.equal(status.service.unit, UNIT)
    assert.equal(failure(world.control(write('start'))), 'USER_MANAGER_UNAVAILABLE')
    assert.equal(existsSync(world.log), false, 'no systemctl invocation may happen without a binary')
  })

  it('reports unsupported when the default systemctl is not on PATH', async t => {
    const world = await fixture(t, { systemctl: 'path' })
    const status = success(world.control(read('status')))
    assert.equal(status.mode, 'unsupported')
    assert.equal(failure(world.control(write('restart'))), 'USER_MANAGER_UNAVAILABLE')
  })

  it('reports unsupported when the user manager cannot be reached', async t => {
    const world = await fixture(t, {
      env: {
        DSH_TEST_SHOW_EXIT: '1', DSH_TEST_SHOW_STDERR: 'Failed to connect to bus: No such file or directory',
        DSH_TEST_EXIT: '1', DSH_TEST_STDERR: 'Failed to connect to bus: No such file or directory',
      },
    })
    const status = success(world.control(read('status')))
    assert.equal(status.mode, 'unsupported')
    assert.equal(status.service.state, 'unknown')
    assert.match(status.service.reason, /Failed to connect to bus/u)
    const receipt = success(world.control(write('start')))
    assert.equal(receipt.outcome, 'failed')
    assert.equal(receipt.code, 'USER_MANAGER_UNAVAILABLE')
    assert.equal(actionCalls(await invocations(world.log)).length, 1)
  })
})

describe('write actions and operation receipts', () => {
  it('runs exactly one argument-array systemctl command and records the receipt', async t => {
    const world = await fixture(t)
    const request = write('start')
    const value = success(world.control(request))
    assert.equal(value.action, 'start')
    assert.equal(value.operationId, request.operationId)
    assert.equal(value.instanceKey, KEY)
    assert.equal(value.registrationRevision, REVISION)
    assert.equal(value.outcome, 'completed')
    assert.deepEqual(Object.keys(value).sort(), [
      'action', 'controlVersion', 'instanceKey', 'issuedAt', 'ok', 'operationId', 'outcome', 'recordedAt', 'registrationRevision',
    ])
    const rows = await invocations(world.log)
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0], ['--user', '--no-ask-password', 'start', UNIT])
    const stored = JSON.parse(await readFile(join(world.home, OPERATIONS, `${request.operationId}.json`), 'utf8'))
    assert.deepEqual(stored, {
      operationId: request.operationId, action: 'start', instanceKey: KEY, issuedAt: request.issuedAt,
      recordedAt: value.recordedAt, registrationRevision: REVISION, outcome: 'completed',
    })
    const queried = success(world.control(read('operationStatus', { operationId: request.operationId })))
    assert.deepEqual(queried, value)
    assert.equal((await invocations(world.log)).length, 1)
  })

  it('never runs the same operation id twice, even when re-issued', async t => {
    const world = await fixture(t)
    const request = write('restart')
    const first = success(world.control(request))
    const repeated = success(world.control(request))
    assert.deepEqual(repeated, first)
    const reissued = success(world.control({ ...request, issuedAt: new Date().toISOString() }))
    assert.deepEqual(reissued, first)
    const rows = actionCalls(await invocations(world.log))
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0], ['--user', '--no-ask-password', 'restart', UNIT])
  })

  it('rejects a reused operation id with different parameters', async t => {
    const world = await fixture(t)
    const request = write('start')
    success(world.control(request))
    assert.equal(failure(world.control({ ...request, action: 'stop' })), 'OPERATION_CONFLICT')
    assert.equal(failure(world.control({ ...request, instanceKey: 'second' })), 'OPERATION_CONFLICT')
    assert.equal(actionCalls(await invocations(world.log)).length, 1)
  })

  it('rejects a stale registration revision and a mismatched instance id', async t => {
    const world = await fixture(t)
    assert.equal(failure(world.control(write('start', { registrationRevision: 'rev-old' }))), 'REGISTRATION_STALE')
    assert.equal(failure(world.control(write('restart', { expectedInstanceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }))), 'IDENTITY_MISMATCH')
    assert.equal(actionCalls(await invocations(world.log)).length, 0)
    const anonymous = await fixture(t, { identity: null })
    assert.equal(failure(anonymous.control(write('start', { expectedInstanceId: INSTANCE_ID }))), 'IDENTITY_MISMATCH')
    assert.equal(actionCalls(await invocations(anonymous.log)).length, 0)
  })

  it('records a timeout as outcome-unknown after exactly one invocation', async t => {
    const world = await fixture(t, { env: { DSH_TEST_SLEEP: '30', DSH_REMOTE_SERVICE_TIMEOUT_MS: '400' } })
    const request = write('start')
    const value = success(world.control(request))
    assert.equal(value.outcome, 'outcome-unknown')
    assert.equal(value.code, 'OUTCOME_UNKNOWN')
    const rows = await invocations(world.log)
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0], ['--user', '--no-ask-password', 'start', UNIT])
    const stored = JSON.parse(await readFile(join(world.home, OPERATIONS, `${request.operationId}.json`), 'utf8'))
    assert.equal(stored.outcome, 'outcome-unknown')
    const queried = success(world.control(read('operationStatus', { operationId: request.operationId })))
    assert.equal(queried.outcome, 'outcome-unknown')
    assert.equal((await invocations(world.log)).length, 1)
  })

  it('records a conclusive failure with a bounded summary', async t => {
    const world = await fixture(t, { env: { DSH_TEST_EXIT: '1', DSH_TEST_STDERR: 'Failed to start dsh-remote-web.service: Unit not found.' } })
    const request = write('start')
    const value = success(world.control(request))
    assert.equal(value.outcome, 'failed')
    assert.equal(value.code, 'CONTROL_FAILED')
    assert.match(value.summary, /Unit not found/u)
    assert.equal(actionCalls(await invocations(world.log)).length, 1)
  })

  it('reports an unreachable user manager on a write action as failed', async t => {
    const world = await fixture(t, { env: { DSH_TEST_EXIT: '1', DSH_TEST_STDERR: 'Failed to connect to bus: No such file or directory' } })
    const value = success(world.control(write('start')))
    assert.equal(value.outcome, 'failed')
    assert.equal(value.code, 'USER_MANAGER_UNAVAILABLE')
  })

  it('answers an absent receipt with OUTCOME_UNKNOWN and a malformed one with BAD_INPUT', async t => {
    const world = await fixture(t)
    assert.equal(failure(world.control(read('operationStatus', { operationId: operationId() }))), 'OUTCOME_UNKNOWN')
    assert.equal(failure(world.control(read('operationStatus', { operationId: 'short' }))), 'BAD_INPUT')
    assert.equal(actionCalls(await invocations(world.log)).length, 0)
  })

  it('refuses expired and future-dated write requests', async t => {
    const world = await fixture(t)
    const expired = new Date(Date.now() - contract.control.limits.issuedAtMaxAgeMs - 60_000).toISOString()
    const future = new Date(Date.now() + contract.control.limits.issuedAtFutureSkewMs + 60_000).toISOString()
    assert.equal(failure(world.control(write('start', { issuedAt: expired }))), 'OPERATION_EXPIRED')
    assert.equal(failure(world.control(write('start', { issuedAt: future }))), 'BAD_INPUT')
    assert.equal(actionCalls(await invocations(world.log)).length, 0)
  })

  it('serializes one instance and reclaims only a proven dead owner', async t => {
    const world = await fixture(t)
    await mkdir(join(world.home, LOCKS), { recursive: true, mode: 0o700 })
    const lockPath = join(world.home, LOCKS, `${KEY}.lock`)
    await writeFile(lockPath, `${JSON.stringify({ version: 1, instanceKey: KEY, pid: process.pid, startedAt: '2020-01-01T00:00:00.000Z' })}\n`, { mode: 0o600 })
    assert.equal(failure(world.control(write('start'))), 'OPERATION_CONFLICT')
    assert.equal(actionCalls(await invocations(world.log)).length, 0, 'an old lock held by a live process must never be reclaimed by age')
    const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true })
    assert.equal(typeof dead.pid, 'number')
    await writeFile(lockPath, `${JSON.stringify({ version: 1, instanceKey: KEY, pid: dead.pid, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 })
    assert.equal(success(world.control(write('start'))).outcome, 'completed')
    assert.equal(actionCalls(await invocations(world.log)).length, 1)
    assert.equal(existsSync(lockPath), false, 'the lock must be released after the action')
  })

  it('never turns request text or a registration value into a command', async t => {
    const pwned = '/tmp/pwned'
    const before = existsSync(pwned)
    const world = await fixture(t)
    const request = write('start', { unit: 'sshd.service', command: 'touch /tmp/pwned', path: '/etc/shadow', sudo: true })
    assert.equal(success(world.control(request)).outcome, 'completed')
    const rows = actionCalls(await invocations(world.log))
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0], ['--user', '--no-ask-password', 'start', UNIT])
    assert.equal(existsSync(pwned), before, 'a request payload must never reach a shell')
    const hostile = await fixture(t, {
      services: { schemaVersion: 1, instances: { [KEY]: registrationEntry({ unit: 'evil.service; touch /tmp/pwned' }) } },
    })
    assert.equal(failure(hostile.control(read('status'))), 'CONFIG_REQUIRED')
    assert.equal(failure(hostile.control(write('restart'))), 'CONFIG_REQUIRED')
    assert.equal((await invocations(hostile.log)).length, 0)
    assert.equal(existsSync(pwned), before, 'a registration value must never reach a shell')
    assert.equal(failure(world.control(read('status', { instanceKey: 'default; touch /tmp/pwned' }))), 'BAD_INPUT')
    assert.equal(failure(world.control(write('start', { instanceKey: 'default; touch /tmp/pwned' }))), 'BAD_INPUT')
    assert.equal(actionCalls(await invocations(world.log)).length, 1)
  })

  it('prunes only expired terminal receipts and never a pending one', async t => {
    const world = await fixture(t)
    const old = new Date(Date.now() - contract.control.limits.operationReceiptRetentionMs - 60_000).toISOString()
    const now = new Date().toISOString()
    const pending = operationId()
    const expired = operationId()
    const fresh = operationId()
    const base = { action: 'restart', instanceKey: KEY, registrationRevision: REVISION }
    await receiptFile(world.home, pending, { ...base, operationId: pending, issuedAt: old, recordedAt: old, outcome: 'pending' })
    await receiptFile(world.home, expired, { ...base, operationId: expired, issuedAt: old, recordedAt: old, outcome: 'completed' })
    await receiptFile(world.home, fresh, { ...base, operationId: fresh, issuedAt: now, recordedAt: now, outcome: 'failed', code: 'CONTROL_FAILED' })
    for (let index = 0; index < contract.control.limits.operationReceiptsMax + 44; index += 1) {
      const id = `op-cap${String(index).padStart(8, '0')}`
      await receiptFile(world.home, id, { ...base, operationId: id, issuedAt: old, recordedAt: old, outcome: 'completed' })
    }
    const value = success(world.control(write('stop')))
    assert.equal(value.outcome, 'completed')
    const names = (await readdir(join(world.home, OPERATIONS))).filter(name => name.endsWith('.json'))
    assert.ok(names.length <= contract.control.limits.operationReceiptsMax, `receipt count ${names.length} exceeds the cap`)
    assert.ok(names.includes(`${pending}.json`), 'a pending receipt must never be pruned')
    assert.ok(names.includes(`${fresh}.json`), 'an unexpired terminal receipt must be kept')
    assert.equal(names.includes(`${expired}.json`), false, 'an expired terminal receipt may be pruned')
    assert.equal(success(world.control(read('operationStatus', { operationId: pending }))).outcome, 'pending')
  })

  it('never deletes an unexpired receipt to satisfy the count cap', async t => {
    const world = await fixture(t)
    const now = new Date().toISOString()
    const pending = operationId()
    const base = { action: 'restart', instanceKey: KEY, registrationRevision: REVISION }
    await receiptFile(world.home, pending, { ...base, operationId: pending, issuedAt: now, recordedAt: now, outcome: 'pending' })
    const ids = []
    for (let index = 0; index < contract.control.limits.operationReceiptsMax + 1; index += 1) {
      const id = `op-held${String(index).padStart(8, '0')}`
      ids.push(id)
      await receiptFile(world.home, id, { ...base, operationId: id, issuedAt: now, recordedAt: now, outcome: 'completed' })
    }
    assert.equal(success(world.control(write('start'))).outcome, 'completed')
    const names = new Set((await readdir(join(world.home, OPERATIONS))).filter(name => name.endsWith('.json')))
    // The cap yields to the hard rules: only terminal AND expired records may be removed.
    for (const id of [pending, ...ids]) assert.ok(names.has(`${id}.json`), `${id} must be kept`)
  })
})

describe('packaging', () => {
  it('ships every helper module the entry point imports', async () => {
    const bin = join(root, 'packages/remote/companion/bin')
    const manifest = JSON.parse(await readFile(join(root, 'packages/remote/companion/package.json'), 'utf8'))
    const declared = new Set(manifest.files)
    const imports = new Set()
    for (const name of await readdir(bin)) {
      if (!name.endsWith('.mjs')) continue
      const text = await readFile(join(bin, name), 'utf8')
      for (const match of text.matchAll(/from ['"]\.\/([^'"]+)['"]/gu)) imports.add(`bin/${match[1]}`)
      for (const match of text.matchAll(/import\(['"]\.\/([^'"]+)['"]\)/gu)) imports.add(`bin/${match[1]}`)
    }
    assert.deepEqual([...imports].sort(), ['bin/control-protocol.mjs', 'bin/private-storage.mjs', 'bin/service-manager.mjs'])
    for (const name of imports) assert.ok(declared.has(name), `${name} must be listed in the companion package files`)
  })
})

describe('control request framing', () => {
  it('answers malformed input with a bounded BAD_INPUT envelope and exit 0', async t => {
    const world = await fixture(t)
    const cases = [
      'not json\n',
      `${JSON.stringify(read('status'))}`,
      `${JSON.stringify({ ...read('status'), controlVersion: 2 })}\n`,
      `${JSON.stringify(read('shell'))}\n`,
      `${JSON.stringify({ ...read('status'), instanceKey: '../../etc' })}\n`,
      `${JSON.stringify({ ...read('status'), instanceKey: 'other-key' })}\n`,
      `${JSON.stringify(read('status'))}\n${JSON.stringify(read('status'))}\n`,
      `${JSON.stringify({ ...read('status'), pad: 'x'.repeat(5000) })}\n`,
    ]
    for (const input of cases) {
      const result = world.control(input)
      assert.equal(result.status, 0)
      assert.equal(result.stderr, '')
      assert.equal(failure(result), 'BAD_INPUT')
    }
    assert.equal(actionCalls(await invocations(world.log)).length, 0)
    const bare = control({ PATH: process.env.PATH }, 'garbage\n')
    assert.equal(bare.status, 0)
    assert.equal(failure(bare), 'BAD_INPUT')
    assert.equal(failure(control({ PATH: process.env.PATH }, read('status'))), 'CONFIG_REQUIRED')
    assert.equal(failure(control({ PATH: process.env.PATH, DSH_HOME: world.home }, read('status'))), 'CONFIG_REQUIRED')
  })

  it('refuses an unsafe private root', async t => {
    const world = await fixture(t, { mode: 0o755 })
    assert.equal(failure(world.control(read('status'))), 'UNSAFE_PATH')
    assert.equal(failure(world.control(write('start'))), 'UNSAFE_PATH')
    assert.equal(await invocations(world.log).then(rows => rows.length), 0)
  })})
