#!/usr/bin/env node
/** Install the restricted SSH helper wrapper at the controller's fixed path.
 *
 * Run this on the Linux host that runs the Harness profile, either as the
 * Harness account or through sudo. The controller's default helperPath is
 * /usr/local/bin/dsh-remote-info, so that path is preferred: it removes the
 * dependency on a per-profile configuration override that a plugin-manager run
 * can reset. Without permission to write /usr/local/bin the wrapper is
 * installed under the Harness account's ~/.local/bin and the printed helperPath
 * must be configured on the controller.
 *
 * The wrapper always runs as the Harness account, so a system path is written
 * root:root 0755 and an account path is written account-owned 0700.
 * Verification always queries the helper as the Harness account, never as root:
 * the helper refuses a DSH_HOME owned by another uid.
 */
import { access, chown, constants, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const NAME = 'dsh-remote-info'
const FIXED_DIRECTORY = '/usr/local/bin'
const PACKAGE_RELATIVE = join('node_modules/dsh-win-ssh-agent-source/runtime/bin/dsh-remote-info.mjs')

const { values } = parseArgs({ options: {
  home: { type: 'string' }, profile: { type: 'string', default: 'web' }, keys: { type: 'string', default: 'default' },
  path: { type: 'string' }, 'package-helper': { type: 'string' }, node: { type: 'string' }, sudo: { type: 'boolean', default: false },
} })

if (process.platform !== 'linux') throw new Error('The restricted helper is Linux-only; run this script on the controlled host')
const home = values.home ?? process.env.DSH_HOME
if (home === undefined || !isAbsolute(home)) throw new Error('Set DSH_HOME or pass --home <absolute DSH home>')
const keys = values.keys.split(',').filter(Boolean)
if (keys.length === 0 || !keys.every(key => /^[A-Za-z0-9_-]{1,64}$/u.test(key))) throw new Error('--keys must be a comma-separated list of instance keys')
const helper = values['package-helper'] ?? join(home, 'profiles', values.profile, PACKAGE_RELATIVE)
await access(helper, constants.R_OK).catch(() => { throw new Error(`Installed helper not found: ${helper}`) })
const node = values.node ?? process.execPath
if (!isAbsolute(node)) throw new Error('--node must be an absolute path')

const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const wrapper = `#!/bin/sh
# Installed by DSH-WIN-SSH-Agent: one approved entry point for the controller's fixed helperPath.
set -eu
export DSH_HOME=${quote(home)}
export DSH_REMOTE_INSTANCE_KEYS=${quote(keys.join(','))}
exec ${quote(node)} ${quote(helper)} "$@"
`

const homeInfo = await lstat(home)
const account = accountOf(homeInfo.uid)
const currentUid = process.getuid?.() ?? account.uid
const isRoot = currentUid === 0
const inside = (path, directory) => directory !== '/' && path.startsWith(`${directory.replace(/\/+$/u, '')}/`)
const writable = directory => spawnSync('test', ['-w', directory], { shell: false }).status === 0
const sudoReady = () => spawnSync('sudo', ['-n', 'true'], { shell: false }).status === 0
const runuser = await access('/usr/sbin/runuser', constants.X_OK).then(() => '/usr/sbin/runuser', () => 'runuser')

let target
if (values.path !== undefined) target = resolve(values.path)
else if (writable(FIXED_DIRECTORY) || (values.sudo && sudoReady())) target = join(FIXED_DIRECTORY, NAME)
else {
  const directory = join(account.home, '.local/bin')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  target = join(directory, NAME)
  if (values.sudo) console.error('sudo needs no-password access; installing the per-account path instead')
}
const accountPath = inside(target, account.home)
const owner = accountPath ? account.uid : 0
const group = accountPath ? account.gid : 0
const mode = accountPath ? 0o700 : 0o755

if (!await installed(target, owner, mode)) {
  const useSudo = !isRoot && (!writable(dirname(target)) || owner !== currentUid)
  const temporary = useSudo ? join('/tmp', `${NAME}.${process.pid}.tmp`) : `${target}.${process.pid}.tmp`
  await writeFile(temporary, wrapper, { mode })
  try {
    if (useSudo) {
      if (!sudoReady()) throw new Error(`No permission to install ${target} as uid ${owner}; re-run the same command with sudo`)
      const result = spawnSync('sudo', ['-n', 'install', '-o', String(owner), '-g', String(group), '-m', mode.toString(8), temporary, target], { encoding: 'utf8' })
      if (result.status !== 0) throw new Error(`sudo install failed: ${result.stderr.trim()}`)
    } else {
      await rename(temporary, target)
      if (isRoot && (owner !== 0 || group !== 0)) await chown(target, owner, group)
      else if (!isRoot && owner !== currentUid) console.error(`Note: ${target} stays owned by uid ${currentUid}; system ownership needs sudo`)
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

const input = `{"protocolVersion":1,"instanceKey":"${keys[0]}"}\n`
const options = { input, encoding: 'utf8' }
const probe = currentUid === account.uid ? spawnSync(target, ['--identity'], options)
  : isRoot ? spawnSync(runuser, ['-u', account.name, '--', target, '--identity'], options)
    : sudoReady() ? spawnSync('sudo', ['-n', '-u', account.name, '--', target, '--identity'], options)
      : undefined

const info = await lstat(target)
console.log(`Installed helper: ${target}`)
console.log(`Owner and mode: ${info.uid}:${info.gid} ${(info.mode & 0o777).toString(8).padStart(3, '0')} for Harness account ${account.name} (uid ${account.uid})`)
if (probe === undefined) console.log(`Verification skipped: cannot run a command as ${account.name}; verify with: ${target} --identity`)
else if (probe.status === 0) console.log(`Identity: ${probe.stdout.trim()}`)
else console.error(`Helper refused the query as ${account.name} (exit ${probe.status}): ${probe.stderr.trim()}`)
console.log(`Controller helperPath: ${target}`)
if (!accountPath && target !== join(FIXED_DIRECTORY, NAME)) {
  console.log(`The controller default is ${join(FIXED_DIRECTORY, NAME)}; configure this path as a profile override`)
}
if (probe !== undefined && probe.status !== 0) process.exitCode = 1

/** True when the wrapper file already carries the requested owner, mode and content. */
async function installed(path, uid, mode) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing to replace a non-regular file: ${path}`)
    return info.uid === uid && (info.mode & 0o777) === mode && await readFile(path, 'utf8') === wrapper
  } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

/** Resolve the account that owns DSH_HOME; the wrapper and helper must run as it. */
function accountOf(uid) {
  const row = spawnSync('getent', ['passwd', String(uid)], { encoding: 'utf8' }).stdout?.trim()
  const fields = row?.split(':')
  const name = fields?.[0]
  const directory = fields?.[5]
  if (name === undefined || directory === undefined || !directory.startsWith('/')) {
    throw new Error(`Cannot resolve the account that owns ${home}; pass a DSH_HOME owned by the Harness account`)
  }
  const gid = Number(fields[3])
  return { name, uid, gid: Number.isInteger(gid) ? gid : uid, home: directory }
}
