/**
 * Restricted service management for the Agent helper (B05 read-only path, B06 write actions).
 *
 * A systemctl invocation is always an argument array built from one reviewed registration file:
 * the request contributes an action name from the frozen contract and nothing else. There is no
 * shell, no sudo, no environment override and no caller-supplied unit or path.
 *
 * Write actions are recorded before they run, deduplicated by operation id and serialized per
 * instance, so a lost SSH answer can only be inspected through `operationStatus`.
 */
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { ACTIONS, ControlError, LIMITS } from './control-protocol.mjs'
import {
  HELPER_VERSION, DISCOVERY_VERSIONS, acquireInstanceLock, boundedSummary, pruneReceipts,
  readDescriptor, readInstanceIdentity, readReceipt, readRegistration, requirePrivateHome, writeReceipt,
} from './private-storage.mjs'

/** Time budgets frozen in docs/control-contract.json `control.timeBudgetsMs`. */
export const TIME_BUDGETS = { readOnly: 10_000, tcpProbe: 2_000, serviceCommand: 45_000 }
/** Service states frozen in docs/control-contract.json. */
export const SERVICE_STATES = ['unknown', 'inactive', 'activating', 'active', 'deactivating', 'failed']
/** Management modes frozen in docs/control-contract.json. */
export const CONTROL_MODES = ['systemd-user', 'unsupported', 'unregistered']

const MAX_EXECUTABLE_LENGTH = 256
const SYSTEMCTL_SHOW_PROPERTIES = '--property=LoadState,ActiveState,SubState'
const BUS_FAILURE = /(failed to connect to bus|no medium found|not been booted with systemd|no such file or directory.*bus)/iu

function object(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/** The configured systemctl, or the plain name resolved through PATH; never a request value. */
export function systemctlCommand(env = process.env) {
  const configured = env.DSH_REMOTE_SYSTEMCTL
  if (typeof configured === 'string' && configured.length > 0 && configured.length <= MAX_EXECUTABLE_LENGTH) return configured
  return 'systemctl'
}

async function isExecutable(path) {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the systemctl executable without starting it.
 *
 * @returns {Promise<string | undefined>} undefined when it is not installed or not executable.
 */
export async function resolveSystemctl(env = process.env) {
  const command = systemctlCommand(env)
  if (command.includes('/')) return await isExecutable(command) ? command : undefined
  for (const directory of String(env.PATH ?? '').split(':').filter(Boolean)) {
    if (await isExecutable(join(directory, command))) return command
  }
  return undefined
}

/**
 * The service-command budget, bounded by the frozen 45 second contract value.
 *
 * `DSH_REMOTE_SERVICE_TIMEOUT_MS` only shortens it and exists so a test can exercise the
 * timeout path without waiting; a request can never influence it.
 */
export function serviceCommandBudget(env = process.env) {
  const override = Number.parseInt(String(env.DSH_REMOTE_SERVICE_TIMEOUT_MS ?? ''), 10)
  if (Number.isSafeInteger(override) && override >= 100) return Math.min(override, TIME_BUDGETS.serviceCommand)
  return TIME_BUDGETS.serviceCommand
}

function runSystemctl(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(systemctlCommand(), args, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 65_536,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
    }, (error, stdout, stderr) => {
      const output = typeof stdout === 'string' ? stdout : ''
      const errors = typeof stderr === 'string' ? stderr : ''
      if (error === null || error === undefined) {
        resolve({ spawned: true, exitCode: 0, signal: undefined, timedOut: false, stdout: output, stderr: errors })
        return
      }
      const code = typeof error.code === 'string' ? error.code : undefined
      if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'ENOTDIR') {
        resolve({ spawned: false, exitCode: undefined, signal: undefined, timedOut: false, stdout: output, stderr: errors })
        return
      }
      resolve({
        spawned: true,
        exitCode: typeof error.code === 'number' ? error.code : undefined,
        signal: typeof error.signal === 'string' ? error.signal : undefined,
        timedOut: error.killed === true || code === 'ETIMEDOUT',
        stdout: output,
        stderr: errors,
      })
    })
  })
}

function serviceState(loadState, activeState) {
  if (['not-found', 'masked', 'bad-setting', 'error'].includes(loadState)) return 'unknown'
  switch (activeState) {
    case 'active':
    case 'reloading':
      return 'active'
    case 'inactive':
      return 'inactive'
    case 'activating':
      return 'activating'
    case 'deactivating':
      return 'deactivating'
    case 'failed':
      return 'failed'
    default:
      return 'unknown'
  }
}

function parseProperties(text) {
  const values = {}
  for (const line of String(text).split('\n')) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return values
}

/**
 * Query one unit's state through `systemctl --user show` and map it onto the frozen vocabulary.
 *
 * @throws {ControlError} USER_MANAGER_UNAVAILABLE when systemctl is missing or has no user manager.
 */
export async function queryServiceState(unit, env = process.env) {
  if (!LIMITS.unit.test(unit)) throw new ControlError('CONFIG_REQUIRED', 'the registered unit name is not an allowed service unit')
  if (await resolveSystemctl(env) === undefined) {
    throw new ControlError('USER_MANAGER_UNAVAILABLE', 'systemctl is not installed on this host')
  }
  const result = await runSystemctl(['--user', 'show', unit, SYSTEMCTL_SHOW_PROPERTIES], TIME_BUDGETS.readOnly)
  if (!result.spawned) throw new ControlError('USER_MANAGER_UNAVAILABLE', 'systemctl could not be started')
  if (result.timedOut) throw new ControlError('USER_MANAGER_UNAVAILABLE', 'systemctl did not answer within its budget')
  if (result.signal !== undefined || result.exitCode !== 0) {
    const detail = boundedSummary(result.stderr) || boundedSummary(result.stdout)
    throw new ControlError('USER_MANAGER_UNAVAILABLE', detail === '' ? 'the systemd user manager is unavailable' : detail)
  }
  const values = parseProperties(result.stdout)
  const loadState = values.LoadState ?? 'unknown'
  const activeState = values.ActiveState ?? 'unknown'
  const subState = values.SubState ?? 'unknown'
  const state = serviceState(loadState, activeState)
  return {
    unit,
    loadState: loadState.slice(0, 64),
    activeState: activeState.slice(0, 64),
    subState: subState.slice(0, 64),
    state,
    ...(state === 'unknown' ? { reason: 'the unit state is not conclusive' } : {}),
  }
}

/** A bounded TCP connect attempt against the loopback listener only. */
export function probeLoopbackPort(port, timeoutMs = TIME_BUDGETS.tcpProbe) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      resolve(false)
      return
    }
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    let deadline
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      socket.destroy()
      resolve(value)
    }
    deadline = setTimeout(() => finish(false), timeoutMs + 500)
    deadline.unref?.()
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

function descriptorInstanceId(value) {
  const instanceId = value?.instanceId
  return typeof instanceId === 'string' && instanceId.length > 0 && instanceId.length <= 128 ? instanceId : undefined
}

function descriptorFact(descriptor) {
  const value = descriptor.parsable ? descriptor.value : undefined
  const bootId = typeof value?.bootId === 'string' && value.bootId.length > 0 && value.bootId.length <= 256 ? value.bootId : undefined
  const instanceId = descriptorInstanceId(value)
  return {
    present: descriptor.present === true,
    parsable: descriptor.parsable === true,
    ...(bootId !== undefined ? { bootId } : {}),
    ...(instanceId !== undefined ? { instanceId } : {}),
  }
}

/**
 * The stored launch description's listener, without its credential-bearing launch URL.
 *
 * Explicit host/protocol fields win; otherwise they are derived from launchUrl. Only
 * 127.0.0.1 over http: is inside the supported transport range.
 */
export function descriptorListener(descriptor) {
  const value = descriptor.parsable ? descriptor.value : undefined
  if (object(value) === undefined) return undefined
  let host = typeof value.host === 'string' ? value.host : undefined
  let protocol = typeof value.protocol === 'string' ? value.protocol : undefined
  let port = Number.isInteger(value.port) ? value.port : undefined
  if ((host === undefined || protocol === undefined || port === undefined) && typeof value.launchUrl === 'string') {
    try {
      const url = new URL(value.launchUrl)
      host ??= url.hostname
      protocol ??= url.protocol
      if (port === undefined) {
        const parsed = Number.parseInt(url.port, 10)
        if (Number.isSafeInteger(parsed) && parsed > 0) port = parsed
      }
    } catch { /* an unparsable launch URL simply yields no listener facts */ }
  }
  if (host === undefined || protocol === undefined || port === undefined) return undefined
  if (host.length === 0 || host.length > 128 || protocol.length === 0 || protocol.length > 16) return undefined
  if (port < 1 || port > 65_535) return undefined
  return { host, port, protocol, supported: host === '127.0.0.1' && protocol === 'http:' }
}

/**
 * Registration plus the effective management mode for one instance.
 *
 * A registered unit on a host without a usable systemd user manager reports `unsupported`
 * rather than failing, so `status` stays answerable while the Web process is stopped.
 */
async function serviceFacts(config, instanceKey, env) {
  const registration = await readRegistration(config.home, instanceKey)
  if (!registration.registered) return { registration, mode: 'unregistered' }
  const entry = registration.entry
  if (entry.mode !== 'systemd-user' || entry.unit === undefined) return { registration, mode: 'unsupported' }
  try {
    const service = await queryServiceState(entry.unit, env)
    return { registration, mode: 'systemd-user', service }
  } catch (error) {
    if (error instanceof ControlError && error.code === 'USER_MANAGER_UNAVAILABLE') {
      return {
        registration,
        mode: 'unsupported',
        service: {
          unit: entry.unit, loadState: 'unknown', activeState: 'unknown', subState: 'unknown',
          state: 'unknown', reason: boundedSummary(error.detail) || 'the systemd user manager is unavailable',
        },
      }
    }
    throw error
  }
}

/** `capabilities` payload: helper version, discovery versions, actions and the instance mode. */
export async function capabilitiesPayload(config, instanceKey, env = process.env) {
  await requirePrivateHome(config.home)
  const facts = await serviceFacts(config, instanceKey, env)
  return { helperVersion: HELPER_VERSION, discoveryVersions: [...DISCOVERY_VERSIONS], actions: [...ACTIONS], mode: facts.mode }
}

/** `status` payload: registration, service, descriptor, listener and loopback facts. */
export async function statusPayload(config, instanceKey, env = process.env) {
  await requirePrivateHome(config.home)
  const checkedAt = new Date().toISOString()
  const facts = await serviceFacts(config, instanceKey, env)
  const descriptor = await readDescriptor(config.home, instanceKey)
  const identity = await readInstanceIdentity(config.home, instanceKey)
  const listener = descriptorListener(descriptor)
  const instanceId = identity ?? descriptorInstanceId(descriptor.parsable ? descriptor.value : undefined)
  const loopback = listener?.supported === true
    ? { connectable: await probeLoopbackPort(listener.port, TIME_BUDGETS.tcpProbe), checkedAt: new Date().toISOString() }
    : undefined
  return {
    helperVersion: HELPER_VERSION,
    instanceKey,
    registered: facts.registration.registered === true,
    mode: facts.mode,
    ...(facts.registration.registered ? { registrationRevision: facts.registration.entry.registrationRevision } : {}),
    ...(instanceId !== undefined ? { instanceId } : {}),
    ...(facts.service !== undefined ? { service: facts.service } : {}),
    descriptor: descriptorFact(descriptor),
    ...(listener !== undefined ? { listener } : {}),
    ...(loopback !== undefined ? { loopback } : {}),
    checkedAt,
  }
}

/** `operationStatus`: one stored receipt, never a new action. */
export async function operationStatusPayload(config, instanceKey, operationId) {
  await requirePrivateHome(config.home)
  if (typeof operationId !== 'string' || !LIMITS.operationId.test(operationId)) {
    throw new ControlError('BAD_INPUT', 'invalid operation id')
  }
  const receipt = await readReceipt(config.home, operationId)
  // An absent receipt means the recorded outcome cannot be proven; the contract's NOT_FOUND is
  // outside this helper's frozen local code set, so the request is answered with the
  // semantically equivalent OUTCOME_UNKNOWN instead of duplicating envelope construction.
  if (receipt === undefined) throw new ControlError('OUTCOME_UNKNOWN', 'no receipt is stored for this operation id')
  if (receipt.instanceKey !== instanceKey) throw new ControlError('OUTCOME_UNKNOWN', 'the receipt belongs to another instance')
  return receipt
}

/**
 * Run one registered service action under its 45 second budget.
 *
 * A timeout or a signal death is recorded as outcome-unknown and never retried here; only a
 * conclusive exit code becomes completed or failed.
 */
export async function runServiceAction(action, unit, env = process.env) {
  const result = await runSystemctl(['--user', '--no-ask-password', action, unit], serviceCommandBudget(env))
  if (!result.spawned) throw new ControlError('USER_MANAGER_UNAVAILABLE', 'systemctl could not be started')
  if (result.timedOut) {
    return { outcome: 'outcome-unknown', code: 'OUTCOME_UNKNOWN', summary: 'the service command did not answer within its budget' }
  }
  if (result.signal !== undefined) {
    return { outcome: 'outcome-unknown', code: 'OUTCOME_UNKNOWN', summary: `the service command was terminated by ${result.signal}` }
  }
  if (result.exitCode === 0) {
    const summary = boundedSummary(result.stdout) || boundedSummary(result.stderr)
    return { outcome: 'completed', ...(summary === '' ? {} : { summary }) }
  }
  const detail = boundedSummary(result.stderr) || boundedSummary(result.stdout)
  // The helper's frozen local error vocabulary has no SERVICE_FAILED, so a conclusive
  // non-zero exit is recorded as CONTROL_FAILED and a bus failure as USER_MANAGER_UNAVAILABLE.
  const code = BUS_FAILURE.test(detail) ? 'USER_MANAGER_UNAVAILABLE' : 'CONTROL_FAILED'
  return { outcome: 'failed', code, summary: detail === '' ? `systemctl exited with status ${result.exitCode}` : detail }
}

function receiptResult(existing, request) {
  // Identity is the operation's meaning: the same id may only ever describe the same action on
  // the same instance under the same registration revision. `issuedAt` is a freshness marker,
  // so a re-issued request for the same operation stays idempotent instead of conflicting.
  if (existing.action === request.action && existing.instanceKey === request.instanceKey
    && existing.registrationRevision === request.registrationRevision) return existing
  throw new ControlError('OPERATION_CONFLICT', 'this operation id was already used for different parameters')
}

/** `start` / `stop` / `restart`: one recorded, deduplicated, per-instance serialized action. */
export async function submitServiceAction(config, request, env = process.env) {
  const { action, instanceKey, operationId, issuedAt, registrationRevision, expectedInstanceId } = request
  await requirePrivateHome(config.home)
  const registration = await readRegistration(config.home, instanceKey)
  if (!registration.registered) {
    throw new ControlError('SERVICE_UNREGISTERED', 'this instance is not registered for service management')
  }
  const entry = registration.entry
  if (registrationRevision !== entry.registrationRevision) {
    throw new ControlError('REGISTRATION_STALE', 'the registration changed after this request was built')
  }
  if (entry.mode !== 'systemd-user' || entry.unit === undefined) {
    throw new ControlError('USER_MANAGER_UNAVAILABLE', 'the registered instance does not use a systemd user unit')
  }
  if (expectedInstanceId !== undefined) {
    const identity = await readInstanceIdentity(config.home, instanceKey)
    const descriptor = identity === undefined ? await readDescriptor(config.home, instanceKey) : undefined
    const stored = identity ?? descriptorInstanceId(descriptor?.parsable === true ? descriptor.value : undefined)
    if (stored === undefined || stored !== expectedInstanceId) {
      throw new ControlError('IDENTITY_MISMATCH', 'the expected instance id does not match the stored instance identity')
    }
  }
  // A stored receipt short-circuits before any lock or command: the same operation is replayed
  // as its recorded answer and systemctl is never asked twice.
  const existing = await readReceipt(config.home, operationId)
  if (existing !== undefined) return receiptResult(existing, request)
  const release = await acquireInstanceLock(config.home, instanceKey)
  try {
    const concurrent = await readReceipt(config.home, operationId)
    if (concurrent !== undefined) return receiptResult(concurrent, request)
    if (await resolveSystemctl(env) === undefined) {
      throw new ControlError('USER_MANAGER_UNAVAILABLE', 'systemctl is not installed on this host')
    }
    await pruneReceipts(config.home)
    const pending = await writeReceipt(config.home, {
      operationId, action, instanceKey, issuedAt, recordedAt: new Date().toISOString(),
      registrationRevision, outcome: 'pending',
    })
    const outcome = await runServiceAction(action, entry.unit, env).catch(error => {
      // The pending receipt is already recorded, so a failure to start the command must still
      // terminate that record instead of leaving an operation pending forever.
      if (error instanceof ControlError) return { outcome: 'failed', code: error.code, summary: error.detail }
      throw error
    })
    return await writeReceipt(config.home, {
      ...pending, recordedAt: new Date().toISOString(), outcome: outcome.outcome,
      ...(outcome.code !== undefined ? { code: outcome.code } : {}),
      ...(outcome.summary !== undefined && outcome.summary !== '' ? { summary: outcome.summary } : {}),
    })
  } finally {
    await release()
  }
}

/** Dispatch one already validated control request. */
export async function runControlAction(request, config, env = process.env) {
  switch (request.action) {
    case 'capabilities':
      return await capabilitiesPayload(config, request.instanceKey, env)
    case 'status':
      return await statusPayload(config, request.instanceKey, env)
    case 'operationStatus':
      return await operationStatusPayload(config, request.instanceKey, request.operationId)
    case 'start':
    case 'stop':
    case 'restart':
      return await submitServiceAction(config, request, env)
    default:
      throw new ControlError('BAD_INPUT', 'unsupported control action')
  }
}
