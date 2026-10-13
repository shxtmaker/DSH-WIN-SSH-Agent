/**
 * B04 — the Agent half of the frozen management contract.
 *
 * Runs under plain `node --test` and imports the real protocol module the helper uses.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ACTIONS, CONTROL_VERSION, ControlError, ERROR_CODES, LIMITS, READ_ACTIONS, WRITE_ACTIONS,
  controlError, controlOk, parseControlRequest, safeAction }
  from '../packages/remote/companion/bin/control-protocol.mjs'

const contract = JSON.parse(await readFile(join(import.meta.dirname, '../docs/control-contract.json'), 'utf8'))

const OP = 'op-0123456789abcdef'
const NOW = '2026-10-13T00:00:00.000Z'
const line = value => `${JSON.stringify(value)}\n`

describe('control protocol schema', () => {
  it('matches the frozen contract version and action set', () => {
    assert.equal(CONTROL_VERSION, contract.control.controlVersion)
    assert.deepEqual([...ACTIONS].sort(), [...contract.control.actions].sort())
    assert.deepEqual([...WRITE_ACTIONS].sort(), [...contract.control.writeActions].sort())
    assert.deepEqual([...READ_ACTIONS].sort(), [...contract.control.readOnlyActions].sort())
  })

  it('keeps every stable error code inside the frozen vocabulary', () => {
    const declared = new Set(contract.errorCodes)
    for (const code of ERROR_CODES) assert.ok(declared.has(code), `agent code missing from contract: ${code}`)
    assert.ok(ERROR_CODES.has('BAD_INPUT'))
    assert.ok(ERROR_CODES.has('SERVICE_UNREGISTERED'))
  })

  it('keeps discovery protocol 1 separate from the management version', () => {
    assert.equal(contract.discovery.protocolVersion, 1)
    assert.equal(CONTROL_VERSION, 1)
    // The two protocols share a numeric value on purpose but never share a field name or a
    // request shape, so neither side can be confused for the other.
    assert.ok(contract.discovery.requestFields.includes('protocolVersion'))
    assert.equal(contract.discovery.requestFields.includes('controlVersion'), false)
    assert.ok(contract.control.requestFields.status.includes('controlVersion'))
    assert.equal(contract.control.requestFields.status.includes('protocolVersion'), false)
    assert.ok(contract.control.invocation.includes('--control'))
    assert.equal(contract.discovery.invocation.includes('--control'), false)
    assert.equal(contract.discovery.identityInvocation.includes('--control'), false)
  })

  it('parses every declared read action', () => {
    assert.deepEqual(parseControlRequest(line({ controlVersion: 1, action: 'capabilities', instanceKey: 'default' })),
      { action: 'capabilities', instanceKey: 'default' })
    assert.deepEqual(parseControlRequest(line({ controlVersion: 1, action: 'status', instanceKey: 'default' })),
      { action: 'status', instanceKey: 'default' })
    assert.deepEqual(parseControlRequest(line({ controlVersion: 1, action: 'operationStatus', instanceKey: 'default', operationId: OP })),
      { action: 'operationStatus', instanceKey: 'default', operationId: OP })
  })

  it('parses a write action only with a fresh id, revision and matching fields', () => {
    const parsed = parseControlRequest(line({
      controlVersion: 1, action: 'restart', instanceKey: 'default', operationId: OP,
      issuedAt: new Date().toISOString(), registrationRevision: 'rev-1', expectedInstanceId: 'inst-1',
    }))
    assert.equal(parsed.action, 'restart')
    assert.equal(parsed.registrationRevision, 'rev-1')
    assert.equal(parsed.expectedInstanceId, 'inst-1')
    assert.equal(parsed.command, undefined)
    assert.equal(parsed.unit, undefined)
    assert.equal(parsed.path, undefined)
  })

  it('rejects arbitrary commands, unit names, paths and shell text', () => {
    const base = { controlVersion: 1, action: 'restart', instanceKey: 'default', operationId: OP,
      issuedAt: new Date().toISOString(), registrationRevision: 'rev-1' }
    // Extra fields are never read into the result, so they cannot become an argument.
    const parsed = parseControlRequest(line({ ...base, command: 'rm -rf /', unit: 'sshd.service', path: '/etc/shadow', sudo: true }))
    assert.deepEqual(Object.keys(parsed).sort(), ['action', 'instanceKey', 'issuedAt', 'operationId', 'registrationRevision'])
    // A shell-looking operation id is refused outright.
    assert.throws(() => parseControlRequest(line({ ...base, operationId: 'x; rm -rf /' })), /BAD_INPUT/u)
    // A non-allowlisted instance key is refused.
    assert.throws(() => parseControlRequest(line({ ...base, instanceKey: '../../etc' })), /BAD_INPUT/u)
    assert.throws(() => parseControlRequest(line({ ...base, registrationRevision: 'rev 1' })), /BAD_INPUT/u)
    assert.throws(() => parseControlRequest(line({ ...base, expectedInstanceId: 'inst/1' })), /BAD_INPUT/u)
  })

  it('rejects malformed framing and unknown versions or actions', () => {
    assert.throws(() => parseControlRequest('{"controlVersion":1,"action":"status","instanceKey":"default"}'), /BAD_INPUT/u)
    assert.throws(() => parseControlRequest(line({ controlVersion: 2, action: 'status', instanceKey: 'default' })), /BAD_INPUT/u)
    assert.throws(() => parseControlRequest(line({ controlVersion: 1, action: 'shell', instanceKey: 'default' })), /BAD_INPUT/u)
    assert.throws(() => parseControlRequest('not json\n'), /BAD_INPUT/u)
    assert.throws(() => parseControlRequest(`${JSON.stringify({ controlVersion: 1, action: 'status', instanceKey: 'default', pad: 'x'.repeat(5000) })}\n`), /BAD_INPUT/u)
    assert.throws(() => parseControlRequest(`${line({ controlVersion: 1, action: 'status', instanceKey: 'default' })}${line({ controlVersion: 1, action: 'status', instanceKey: 'default' })}`), /BAD_INPUT/u)
  })

  it('refuses a stale or future-dated write request', () => {
    const base = { controlVersion: 1, action: 'start', instanceKey: 'default', operationId: OP, registrationRevision: 'rev-1' }
    const stale = new Date(Date.now() - LIMITS.issuedAtMaxAgeMs - 60_000).toISOString()
    const future = new Date(Date.now() + LIMITS.issuedAtFutureSkewMs + 60_000).toISOString()
    assert.throws(() => parseControlRequest(line({ ...base, issuedAt: stale })), /OPERATION_EXPIRED/u)
    assert.throws(() => parseControlRequest(line({ ...base, issuedAt: future })), /BAD_INPUT/u)
    assert.throws(() => parseControlRequest(line({ ...base, issuedAt: 'not a date' })), /BAD_INPUT/u)
  })

  it('bounds every response line and never leaks a non-contract code', () => {
    const ok = controlOk('status', { helperVersion: '0.2.0-alpha.1' })
    assert.ok(Buffer.byteLength(ok, 'utf8') <= LIMITS.responseBytes)
    assert.equal(JSON.parse(ok).ok, true)
    const bad = controlError('status', 'NOT_A_REAL_CODE', 'token=abcdef should be dropped')
    const parsed = JSON.parse(bad)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.error.code, 'CONTROL_FAILED')
    assert.throws(() => controlOk('status', { blob: 'x'.repeat(LIMITS.responseBytes) }), /CONTROL_FAILED/u)
    assert.equal(JSON.parse(controlError('status', 'BAD_INPUT')).error.code, 'BAD_INPUT')
  })

  it('recovers only a declared action name for an unparsable request', () => {
    assert.equal(safeAction(line({ action: 'restart' })), 'restart')
    assert.equal(safeAction(line({ action: 'shell' })), 'status')
    assert.equal(safeAction('garbage'), 'status')
  })

  it('carries a stable code and no stack detail on ControlError', () => {
    const error = new ControlError('SERVICE_UNREGISTERED', 'unit is not registered')
    assert.equal(error.code, 'SERVICE_UNREGISTERED')
    assert.equal(error.detail, 'unit is not registered')
    assert.equal(new ControlError('nonsense').code, 'CONTROL_FAILED')
  })
})
