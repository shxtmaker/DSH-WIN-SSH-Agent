/** Linux-only private instance identity and launch-descriptor storage. */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const KEY = /^[A-Za-z0-9_-]{1,64}$/u

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function privateDirectory(path: string, isHome = false): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }) } catch (error) { if (!isMissing(error) && !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error }
  const info = await lstat(path)
  const unsafe = () => new Error(`remote-companion: unsafe private directory: ${path}`)
  // Refuse untrusted paths before changing permissions. A world-writable
  // directory may already contain another user's data and needs manual repair.
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o002) !== 0) {
    throw unsafe()
  }
  // Harness may create DSH_HOME with group write access. Reused private
  // directories may also inherit a readable mode. Remove permissions only.
  const unsafeBits = isHome ? 0o022 : 0o077
  if ((info.mode & unsafeBits) === 0) return
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const opened = await directory.stat()
    if (!opened.isDirectory() || opened.uid !== process.getuid?.() || opened.dev !== info.dev || opened.ino !== info.ino || (opened.mode & 0o002) !== 0) throw unsafe()
    await directory.chmod((opened.mode & 0o777) & ~unsafeBits)
    const current = await lstat(path)
    if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== opened.uid || current.dev !== opened.dev || current.ino !== opened.ino || (current.mode & unsafeBits) !== 0) throw unsafe()
  } finally { await directory.close() }
}

async function privateFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      throw new Error('remote-companion: unsafe private file')
    }
    return true
  } catch (error) { if (isMissing(error)) return false; throw error }
}

/** Credential-bearing descriptor stored only under a private DSH home. */
export interface InstanceDescriptor {
  readonly protocolVersion: 1
  readonly instanceKey: string
  readonly instanceId: string
  readonly bootId: string
  readonly profile: string
  readonly workspaceHint: string
  readonly port: number
  readonly launchUrl: string
}

/** Prepare private directories and load or create one stable instance id. */
export async function instanceStorage(home: string, instanceKey: string): Promise<{
  readonly instanceId: string
  readonly descriptorPath: string
}> {
  if (process.platform !== 'linux' || !KEY.test(instanceKey)) throw new Error('remote-companion: Linux and a valid instance key are required')
  await privateDirectory(home, true)
  const root = join(home, 'remote-workspace')
  await privateDirectory(root)
  const run = join(root, 'run')
  await privateDirectory(run)
  const idPath = join(root, `instance-${instanceKey}.id`)
  if (!await privateFile(idPath)) {
    const file = await open(idPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await file.writeFile(randomUUID() + '\n'); await file.sync() } finally { await file.close() }
  }
  const instanceId = (await readFile(idPath, 'utf8')).trim()
  if (!/^[0-9a-f-]{36}$/u.test(instanceId)) throw new Error('remote-companion: invalid stable instance id')
  return { instanceId, descriptorPath: join(run, `${instanceKey}.json`) }
}

/** Atomically replace only a safe descriptor with a private temporary file. */
export async function writeDescriptor(path: string, value: InstanceDescriptor): Promise<void> {
  await privateFile(path)
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync() } finally { await file.close() }
  try { await rename(temporary, path) } catch (error) { await unlink(temporary); throw error }
}

/** Delete only the file still naming this process's boot generation. */
export async function removeDescriptor(path: string, bootId: string): Promise<void> {
  if (!await privateFile(path)) return
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (typeof value === 'object' && value !== null && 'bootId' in value && value.bootId === bootId) await unlink(path)
}
