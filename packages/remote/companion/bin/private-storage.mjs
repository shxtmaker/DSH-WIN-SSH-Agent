/**
 * Bounded private storage for the restricted management helper (B05/B06).
 *
 * Every path is fixed: the caller contributes only an already validated instance key or
 * operation id, never a path, a unit name or a command. Reads repeat the checks the discovery
 * helper already uses — no symlinks, same uid, private modes (0700 directories, 0600 files)
 * and a hard size bound — so a file another user can read or replace is never trusted.
 *
 * The registration file gates every write action; an unreadable or unsafe registration fails
 * closed. A run descriptor is diagnostic only, so an unsafe descriptor is reported as
 * "present but not parsable" instead of failing the whole status call.
 */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { ControlError, ERROR_CODES, LIMITS } from './control-protocol.mjs'

/** Helper build identity reported by `capabilities` and `status`; overlaps package version. */
export const HELPER_VERSION = '0.2.0-alpha.1'
/** Discovery protocol versions this helper still answers. */
export const DISCOVERY_VERSIONS = [1]

export const WORKSPACE_RELATIVE = 'remote-workspace'
export const CONTROL_RELATIVE = 'remote-workspace/control'
export const RUN_RELATIVE = 'remote-workspace/run'
export const REGISTRATION_FILE = 'services.json'
export const RECEIPTS_DIRECTORY = 'operations'
export const LOCKS_DIRECTORY = 'locks'
export const REGISTRATION_SCHEMA_VERSION = 1

export const MAX_JSON_BYTES = 65_536
export const MAX_IDENTITY_BYTES = 256
export const MAX_SUMMARY_LENGTH = 300

/** Registration modes this helper understands; anything else is a configuration error. */
export const REGISTRATION_MODES = ['systemd-user', 'unsupported']
/** Receipt outcomes, matching docs/control-contract.json. */
export const RECEIPT_OUTCOMES = ['pending', 'completed', 'failed', 'outcome-unknown']
/** Outcomes that no longer change, and may therefore expire. */
export const TERMINAL_RECEIPT_OUTCOMES = ['completed', 'failed', 'outcome-unknown']

const IDENTITY = /^[0-9a-f-]{36}$/u
const LOCK_VERSION = 1

function isMissing(error) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function object(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function owner() {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}

/** Collapse and bound one diagnostic summary; stored receipts never carry free-form dumps. */
export function boundedSummary(value, max = MAX_SUMMARY_LENGTH) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max)
}

/** The helper's own configuration: one absolute private root and one bounded key allowlist. */
export function readHelperConfig(env = process.env) {
  const home = env.DSH_HOME
  const keys = String(env.DSH_REMOTE_INSTANCE_KEYS ?? '').split(',').filter(Boolean)
  if (typeof home !== 'string' || !isAbsolute(home) || keys.length === 0
    || !keys.every(key => LIMITS.instanceKey.test(key))) {
    throw new ControlError('CONFIG_REQUIRED', 'DSH_HOME must be an absolute private root and DSH_REMOTE_INSTANCE_KEYS a bounded allowlist')
  }
  return { home, keys }
}

/**
 * Check one directory without creating or repairing it.
 *
 * @returns {'ok' | 'missing'}
 * @throws {ControlError} UNSAFE_PATH for a symlink, another owner or a permissive mode.
 */
export async function directoryState(path, isHome = false) {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (isMissing(error)) return 'missing'
    throw new ControlError('UNSAFE_PATH', 'private directory cannot be inspected')
  }
  const unsafeBits = isHome ? 0o022 : 0o077
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== owner() || (info.mode & unsafeBits) !== 0) {
    throw new ControlError('UNSAFE_PATH', 'private directory is not owned by this user or is too permissive')
  }
  return 'ok'
}

/**
 * Read one bounded private file.
 *
 * @returns {string | undefined} undefined when the file does not exist.
 * @throws {ControlError} UNSAFE_FILE for a symlink, another owner, a permissive mode or oversize.
 */
export async function readPrivateText(path, maxBytes = MAX_JSON_BYTES) {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw new ControlError('UNSAFE_FILE', 'private file cannot be inspected')
  }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== owner()
    || (info.mode & 0o077) !== 0 || info.size > maxBytes) {
    throw new ControlError('UNSAFE_FILE', 'private file is not private or is too large')
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const text = await file.readFile('utf8')
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new ControlError('UNSAFE_FILE', 'private file is too large')
    return text
  } finally {
    await file.close()
  }
}

async function syncDirectory(path) {
  try {
    const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await directory.sync() } finally { await directory.close() }
  } catch { /* a directory fsync is best effort on every supported filesystem */ }
}

async function writeAtomic(path, text) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await file.writeFile(text)
    await file.sync()
  } finally {
    await file.close()
  }
  try {
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
  await syncDirectory(dirname(path))
}

async function ensurePrivateDirectory(path, parent) {
  if (await directoryState(path) === 'ok') return path
  if (await directoryState(parent) === 'missing') {
    throw new ControlError('CONFIG_REQUIRED', 'the private workspace directory does not exist yet')
  }
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (!isMissing(error) && !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) {
      throw new ControlError('CONTROL_FAILED', 'private directory could not be created')
    }
  }
  if (await directoryState(path) !== 'ok') throw new ControlError('UNSAFE_PATH', 'private directory is not private')
  return path
}

/**
 * Validate the configured private root before any read.
 *
 * @throws {ControlError} CONFIG_REQUIRED when it does not exist, UNSAFE_PATH when it is not private.
 */
export async function requirePrivateHome(home) {
  if (await directoryState(home, true) === 'missing') throw new ControlError('CONFIG_REQUIRED', 'DSH_HOME does not exist')
  return home
}

async function workspace(home) {
  await requirePrivateHome(home)
  const path = join(home, WORKSPACE_RELATIVE)
  if (await directoryState(path) === 'missing') throw new ControlError('CONFIG_REQUIRED', 'the private workspace directory does not exist yet')
  return path
}

/** Validate and create (when needed) one fixed private storage directory. */
export async function ensureStore(home, kind) {
  const base = await workspace(home)
  const control = await ensurePrivateDirectory(join(home, CONTROL_RELATIVE), base)
  const leaf = kind === 'receipts' ? RECEIPTS_DIRECTORY : LOCKS_DIRECTORY
  return await ensurePrivateDirectory(join(control, leaf), control)
}

/**
 * Read the reviewed service registration for one instance.
 *
 * @returns {{ present: boolean, registered: boolean, entry?: object }}
 * @throws {ControlError} CONFIG_REQUIRED for corrupt content, UNSAFE_FILE/UNSAFE_PATH for unsafe files.
 */
export async function readRegistration(home, instanceKey) {
  const control = join(home, CONTROL_RELATIVE)
  const state = await directoryState(control)
  if (state === 'missing') return { present: false, registered: false }
  const text = await readPrivateText(join(control, REGISTRATION_FILE))
  if (text === undefined) return { present: false, registered: false }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new ControlError('CONFIG_REQUIRED', 'the service registration is not valid JSON')
  }
  const row = object(value)
  if (row === undefined || row.schemaVersion !== REGISTRATION_SCHEMA_VERSION || object(row.instances) === undefined) {
    throw new ControlError('CONFIG_REQUIRED', 'the service registration does not match schemaVersion 1')
  }
  const entry = row.instances[instanceKey]
  if (entry === undefined) return { present: true, registered: false }
  return { present: true, registered: true, entry: registrationEntry(entry) }
}

function registrationEntry(value) {
  const row = object(value)
  if (row === undefined) throw new ControlError('CONFIG_REQUIRED', 'the registered instance entry is not an object')
  if (typeof row.mode !== 'string' || !REGISTRATION_MODES.includes(row.mode)) {
    throw new ControlError('CONFIG_REQUIRED', 'the registered instance mode is not supported')
  }
  if (typeof row.registrationRevision !== 'string' || !LIMITS.registrationRevision.test(row.registrationRevision)) {
    throw new ControlError('CONFIG_REQUIRED', 'the registered instance has no bounded registration revision')
  }
  let unit
  if (row.mode === 'systemd-user') {
    if (typeof row.unit !== 'string' || !LIMITS.unit.test(row.unit)) {
      throw new ControlError('CONFIG_REQUIRED', 'the registered unit name is not an allowed service unit')
    }
    unit = row.unit
  } else if (row.unit !== undefined && (typeof row.unit !== 'string' || !LIMITS.unit.test(row.unit))) {
    throw new ControlError('CONFIG_REQUIRED', 'the registered unit name is not an allowed service unit')
  }
  const expectedInstanceId = row.expectedInstanceId
  if (expectedInstanceId !== undefined
    && (typeof expectedInstanceId !== 'string' || !LIMITS.expectedInstanceId.test(expectedInstanceId))) {
    throw new ControlError('CONFIG_REQUIRED', 'the registered expected instance id is not bounded')
  }
  const profile = typeof row.profile === 'string' && row.profile.length <= 64 ? row.profile : undefined
  return { mode: row.mode, unit, profile, registrationRevision: row.registrationRevision, expectedInstanceId }
}

/**
 * Read the private run descriptor of one instance.
 *
 * A missing file is absent; a corrupt or unsafe file is present but not parsable, so `status`
 * stays answerable while the Harness Web process is stopped.
 */
export async function readDescriptor(home, instanceKey) {
  const run = join(home, RUN_RELATIVE)
  if (await directoryState(run) === 'missing') return { present: false, parsable: false }
  const path = join(run, `${instanceKey}.json`)
  let text
  try {
    text = await readPrivateText(path)
  } catch (error) {
    if (error instanceof ControlError) return { present: true, parsable: false }
    throw error
  }
  if (text === undefined) return { present: false, parsable: false }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return { present: true, parsable: false }
  }
  if (object(value) === undefined) return { present: true, parsable: false }
  return { present: true, parsable: true, value }
}

/** The stable instance identity the Companion created; never regenerated or overwritten here. */
export async function readInstanceIdentity(home, instanceKey) {
  const path = join(home, WORKSPACE_RELATIVE, `instance-${instanceKey}.id`)
  let text
  try {
    text = await readPrivateText(path, MAX_IDENTITY_BYTES)
  } catch {
    // An unreadable identity is treated as missing: write actions that carry an expected
    // instance id then fail closed with IDENTITY_MISMATCH instead of skipping the check.
    return undefined
  }
  if (text === undefined) return undefined
  const value = text.trim()
  return IDENTITY.test(value) ? value : undefined
}

function receiptValue(value) {
  const row = object(value)
  if (row === undefined) return undefined
  const operationId = typeof row.operationId === 'string' && LIMITS.operationId.test(row.operationId) ? row.operationId : undefined
  const action = typeof row.action === 'string' && row.action.length <= 32 ? row.action : undefined
  const instanceKey = typeof row.instanceKey === 'string' && LIMITS.instanceKey.test(row.instanceKey) ? row.instanceKey : undefined
  const issuedAt = typeof row.issuedAt === 'string' && row.issuedAt.length > 0 && row.issuedAt.length <= 64 ? row.issuedAt : undefined
  const recordedAt = typeof row.recordedAt === 'string' && row.recordedAt.length > 0 && row.recordedAt.length <= 64 ? row.recordedAt : undefined
  const registrationRevision = typeof row.registrationRevision === 'string' && LIMITS.registrationRevision.test(row.registrationRevision)
    ? row.registrationRevision : undefined
  const outcome = typeof row.outcome === 'string' && RECEIPT_OUTCOMES.includes(row.outcome) ? row.outcome : undefined
  if (operationId === undefined || action === undefined || instanceKey === undefined || issuedAt === undefined
    || recordedAt === undefined || registrationRevision === undefined || outcome === undefined) return undefined
  let code
  if (row.code !== undefined) {
    if (typeof row.code !== 'string' || !ERROR_CODES.has(row.code)) return undefined
    code = row.code
  }
  const summary = row.summary === undefined ? undefined : boundedSummary(row.summary)
  return {
    operationId, action, instanceKey, issuedAt, recordedAt, registrationRevision, outcome,
    ...(code !== undefined ? { code } : {}),
    ...(summary !== undefined && summary.length > 0 ? { summary } : {}),
  }
}

/**
 * Read one stored operation receipt.
 *
 * An unreadable or corrupt receipt fails closed instead of being treated as absent: a missing
 * receipt is what allows a write action to run, so it must never be inferred from a file we
 * could not trust.
 */
export async function readReceipt(home, operationId) {
  if (typeof operationId !== 'string' || !LIMITS.operationId.test(operationId)) {
    throw new ControlError('BAD_INPUT', 'invalid operation id')
  }
  const directory = join(home, CONTROL_RELATIVE, RECEIPTS_DIRECTORY)
  if (await directoryState(directory) === 'missing') return undefined
  const path = join(directory, `${operationId}.json`)
  const text = await readPrivateText(path)
  if (text === undefined) return undefined
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new ControlError('CONTROL_FAILED', 'the stored operation receipt is not valid JSON')
  }
  const receipt = receiptValue(value)
  if (receipt === undefined) throw new ControlError('CONTROL_FAILED', 'the stored operation receipt has an unexpected shape')
  return receipt
}

/** Atomically replace one receipt through a private temporary file in the same directory. */
export async function writeReceipt(home, receipt) {
  const validated = receiptValue(receipt)
  if (validated === undefined) throw new ControlError('CONTROL_FAILED', 'refusing to store an invalid operation receipt')
  const directory = await ensureStore(home, 'receipts')
  await writeAtomic(join(directory, `${validated.operationId}.json`), `${JSON.stringify(validated)}\n`)
  return validated
}

async function listReceiptFiles(home) {
  const directory = join(home, CONTROL_RELATIVE, RECEIPTS_DIRECTORY)
  if (await directoryState(directory) === 'missing') return []
  let names
  try {
    names = await readdir(directory)
  } catch {
    throw new ControlError('CONTROL_FAILED', 'operation receipts could not be listed')
  }
  const entries = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const operationId = name.slice(0, -'.json'.length)
    if (!LIMITS.operationId.test(operationId)) continue
    let receipt
    try {
      receipt = await readReceipt(home, operationId)
    } catch {
      // Never delete a receipt we cannot parse; it is simply not prunable.
      continue
    }
    if (receipt !== undefined) entries.push({ receipt, path: join(directory, name) })
  }
  return entries
}

/** Every readable receipt, newest last; corrupt files are left in place and omitted. */
export async function listReceipts(home) {
  return (await listReceiptFiles(home)).map(entry => entry.receipt)
}

/**
 * Prune receipts that may be pruned: terminal and older than the retention window.
 *
 * The 256 receipt cap is enforced through that same rule and never by deleting a record that
 * is still pending or not yet expired: evidence of an unfinished operation is only ever
 * removed once it has a terminal outcome and has aged out.
 */
export async function pruneReceipts(home, now = Date.now()) {
  const entries = await listReceiptFiles(home)
  let removed = 0
  for (const entry of entries) {
    const recordedAt = Date.parse(entry.receipt.recordedAt)
    const expired = TERMINAL_RECEIPT_OUTCOMES.includes(entry.receipt.outcome)
      && Number.isFinite(recordedAt) && now - recordedAt > LIMITS.receiptRetentionMs
    if (!expired) continue
    await unlink(entry.path).catch(() => {})
    removed += 1
  }
  return { removed, kept: entries.length - removed }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM' ? true : false
  }
}

async function lockOwner(path) {
  const text = await readPrivateText(path)
  if (text === undefined) return undefined
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  const row = object(value)
  if (row === undefined || row.version !== LOCK_VERSION || typeof row.instanceKey !== 'string') return undefined
  return { pid: row.pid, instanceKey: row.instanceKey }
}

async function releaseInstanceLock(path) {
  try {
    const text = await readPrivateText(path)
    if (text === undefined) return
    const value = JSON.parse(text)
    const row = object(value)
    if (row === undefined || row.pid !== process.pid) return
    await unlink(path)
  } catch { /* leaving a lock behind is safer than deleting another process's lock */ }
}

/**
 * Take the per-instance write mutex.
 *
 * A lock whose recorded pid is still alive is never reclaimed, whatever its age. Only a lock
 * proven to belong to a dead process is removed, and a lock that cannot be verified at all
 * stays in place and is reported as a conflict.
 *
 * @returns {Promise<() => Promise<void>>} the release function.
 */
export async function acquireInstanceLock(home, instanceKey) {
  const directory = await ensureStore(home, 'locks')
  const path = join(directory, `${instanceKey}.lock`)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        await file.writeFile(`${JSON.stringify({ version: LOCK_VERSION, instanceKey, pid: process.pid, startedAt: new Date().toISOString() })}\n`)
        await file.sync()
      } finally {
        await file.close()
      }
      await syncDirectory(directory)
      return async () => { await releaseInstanceLock(path) }
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) {
        throw new ControlError('CONTROL_FAILED', 'the instance lock could not be created')
      }
    }
    const lock = await lockOwner(path)
    if (lock === undefined) {
      if (await readPrivateText(path) === undefined) continue
      throw new ControlError('OPERATION_CONFLICT', 'an existing instance lock cannot be verified; inspect it before removing it')
    }
    if (processAlive(lock.pid) === true) {
      throw new ControlError('OPERATION_CONFLICT', 'another service operation already holds this instance lock')
    }
    try {
      await unlink(path)
    } catch (error) {
      if (!isMissing(error)) throw new ControlError('CONTROL_FAILED', 'a stale instance lock could not be reclaimed')
    }
  }
  throw new ControlError('OPERATION_CONFLICT', 'the instance lock could not be acquired')
}
