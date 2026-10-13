/**
 * Management protocol schema for the restricted Agent helper.
 *
 * The helper is invoked as `<fixed absolute path> --control`. It accepts one line of JSON on
 * stdin and answers one line of bounded JSON on stdout. Nothing in this module turns caller
 * input into a command, a unit name, a path or a shell string: the only accepted variables are
 * an allowlisted instance key, a bounded operation id, a registration revision and an optional
 * expected instance id.
 *
 * This file is mirrored in DSH-WIN-SSH-Controller as
 * packages/remote/controller/src/service-client.ts; the shared shape is frozen in
 * docs/control-contract.json, which is byte-identical in both repositories.
 */

/** Fixed management contract version, deliberately separate from discovery's protocolVersion 1. */
export const CONTROL_VERSION = 1

export const READ_ACTIONS = ['capabilities', 'status', 'operationStatus']
export const WRITE_ACTIONS = ['start', 'stop', 'restart']
export const ACTIONS = [...READ_ACTIONS, ...WRITE_ACTIONS]

export const LIMITS = {
  requestBytes: 4096,
  responseBytes: 65536,
  helperVersion: 64,
  operationId: /^[A-Za-z0-9_-]{8,64}$/,
  instanceKey: /^[A-Za-z0-9_-]{1,64}$/,
  registrationRevision: /^[A-Za-z0-9_-]{1,64}$/,
  expectedInstanceId: /^[A-Za-z0-9_-]{1,128}$/,
  unit: /^[A-Za-z0-9@._-]{1,128}\.service$/,
  issuedAtMaxAgeMs: 86_400_000,
  issuedAtFutureSkewMs: 300_000,
  receiptRetentionMs: 604_800_000,
  receiptsMax: 256,
}

/** Stable error codes this helper may report; every other failure collapses to CONTROL_FAILED. */
export const ERROR_CODES = new Set([
  'BAD_INPUT', 'CONFIG_REQUIRED', 'UNSAFE_PATH', 'UNSAFE_FILE', 'LINUX_REQUIRED',
  'CONTROL_UNSUPPORTED', 'CONTROL_FAILED', 'SERVICE_UNREGISTERED', 'USER_MANAGER_UNAVAILABLE',
  'REGISTRATION_STALE', 'IDENTITY_MISMATCH', 'OPERATION_CONFLICT', 'OPERATION_EXPIRED',
  'OUTCOME_UNKNOWN', 'DESCRIPTOR_MISSING', 'DESCRIPTOR_INVALID',
])

/** A failure that already carries a stable code; anything else becomes CONTROL_FAILED. */
export class ControlError extends Error {
  /** @param {string} code @param {string} [message] */
  constructor(code, message = '') {
    super(ERROR_CODES.has(code) ? code : 'CONTROL_FAILED')
    this.code = ERROR_CODES.has(code) ? code : 'CONTROL_FAILED'
    this.detail = String(message).replace(/\s+/gu, ' ').trim().slice(0, 300)
  }
}

function object(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/**
 * Validate one control request line.
 *
 * @param {string} input - the complete stdin text, including its trailing newline.
 * @returns {{ action: string, instanceKey: string, operationId?: string, issuedAt?: string,
 *   registrationRevision?: string, expectedInstanceId?: string }}
 * @throws {ControlError} with BAD_INPUT for any structural problem.
 */
export function parseControlRequest(input) {
  if (Buffer.byteLength(input, 'utf8') > LIMITS.requestBytes) throw new ControlError('BAD_INPUT')
  if (!input.endsWith('\n') || input.slice(0, -1).includes('\n')) throw new ControlError('BAD_INPUT')
  let value
  try { value = JSON.parse(input) } catch { throw new ControlError('BAD_INPUT') }
  const row = object(value)
  if (row === undefined || row.controlVersion !== CONTROL_VERSION) throw new ControlError('BAD_INPUT')
  if (typeof row.action !== 'string' || !ACTIONS.includes(row.action)) throw new ControlError('BAD_INPUT')
  if (typeof row.instanceKey !== 'string' || !LIMITS.instanceKey.test(row.instanceKey)) throw new ControlError('BAD_INPUT')
  if (WRITE_ACTIONS.includes(row.action)) {
    if (typeof row.operationId !== 'string' || !LIMITS.operationId.test(row.operationId)) throw new ControlError('BAD_INPUT')
    if (typeof row.issuedAt !== 'string') throw new ControlError('BAD_INPUT')
    const issuedAt = Date.parse(row.issuedAt)
    if (Number.isNaN(issuedAt)) throw new ControlError('BAD_INPUT')
    const age = Date.now() - issuedAt
    if (age > LIMITS.issuedAtMaxAgeMs) throw new ControlError('OPERATION_EXPIRED')
    if (age < -LIMITS.issuedAtFutureSkewMs) throw new ControlError('BAD_INPUT')
    if (typeof row.registrationRevision !== 'string' || !LIMITS.registrationRevision.test(row.registrationRevision)) {
      throw new ControlError('BAD_INPUT')
    }
    if (row.expectedInstanceId !== undefined
      && (typeof row.expectedInstanceId !== 'string' || !LIMITS.expectedInstanceId.test(row.expectedInstanceId))) {
      throw new ControlError('BAD_INPUT')
    }
    return {
      action: row.action, instanceKey: row.instanceKey, operationId: row.operationId,
      issuedAt: new Date(issuedAt).toISOString(), registrationRevision: row.registrationRevision,
      ...(row.expectedInstanceId !== undefined ? { expectedInstanceId: row.expectedInstanceId } : {}),
    }
  }
  if (row.action === 'operationStatus') {
    if (typeof row.operationId !== 'string' || !LIMITS.operationId.test(row.operationId)) throw new ControlError('BAD_INPUT')
    return { action: row.action, instanceKey: row.instanceKey, operationId: row.operationId }
  }
  return { action: row.action, instanceKey: row.instanceKey }
}

/** @returns one bounded success line; throws CONTROL_FAILED when the payload cannot be encoded. */
export function controlOk(action, payload) {
  const line = `${JSON.stringify({ controlVersion: CONTROL_VERSION, action, ok: true, ...payload })}\n`
  if (Buffer.byteLength(line, 'utf8') > LIMITS.responseBytes) throw new ControlError('CONTROL_FAILED', 'response too large')
  return line
}

/** @returns one bounded failure line carrying only a fixed code and a redacted summary. */
export function controlError(action, code, detail = '') {
  const safe = ERROR_CODES.has(code) ? code : 'CONTROL_FAILED'
  const message = String(detail).replace(/\s+/gu, ' ').trim().slice(0, 300)
  return `${JSON.stringify({ controlVersion: CONTROL_VERSION, action, ok: false, error: { code: safe, message } })}\n`
}

/** The action named by a request that could not be parsed, for error envelopes only. */
export function safeAction(input) {
  try {
    const row = object(JSON.parse(input))
    if (row !== undefined && typeof row.action === 'string' && ACTIONS.includes(row.action)) return row.action
  } catch { /* the request was not JSON */ }
  return 'status'
}
