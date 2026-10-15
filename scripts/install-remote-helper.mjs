#!/usr/bin/env node
/** Install the restricted SSH helper wrapper at the controller's fixed path.
 *
 * Run this on the Linux host that runs the Harness profile. The controller's
 * default helperPath is /usr/local/bin/dsh-remote-info, so that path is
 * preferred: it removes the dependency on a per-profile configuration
 * override that a plugin-manager run can reset. Without permission to write
 * /usr/local/bin the wrapper is installed under the invoking account's
 * ~/.local/bin and the printed helperPath must be configured on the
 * controller.
 */
import { access, constants, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const NAME = 'dsh-remote-info'
const FIXED_DIRECTORY = '/usr/local/bin'
const FALLBACK_DIRECTORY = join(homedir(), '.local/bin')
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

const writable = directory => spawnSync('test', ['-w', directory], { shell: false }).status === 0
const fileIs = async (path, expected) => {
  try { return await readFile(path, 'utf8') === expected } catch { return false }
}

/** Write the wrapper as the invoking account. */
async function writeOwned(path) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing to replace a non-regular file: ${path}`)
    if (info.uid !== process.getuid?.()) throw new Error(`Refusing to replace a file owned by another account: ${path}`)
    if (await fileIs(path, wrapper) && (info.mode & 0o777) === 0o700) return path
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, wrapper, { mode: 0o700 })
  try { await rename(temporary, path) } catch (error) { await unlink(temporary).catch(() => undefined); throw error }
  return path
}

/** Write the wrapper as root through a non-interactive sudo install. */
async function writeAsRoot(path) {
  if (spawnSync('sudo', ['-n', 'true']).status !== 0) throw new Error(`No write permission for ${path}; re-run with an interactive sudo`)
  const temporary = join('/tmp', `${NAME}.${process.pid}.tmp`)
  await writeFile(temporary, wrapper, { mode: 0o600 })
  try {
    const result = spawnSync('sudo', ['-n', 'install', '-o', 'root', '-g', 'root', '-m', '0755', temporary, path], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`sudo install failed: ${result.stderr.trim()}`)
  } finally { await unlink(temporary).catch(() => undefined) }
  return path
}

let installed
let asRoot = false
if (values.path !== undefined) {
  installed = resolve(values.path)
  if (!writable(dirname(installed))) { asRoot = true }
} else if (writable(FIXED_DIRECTORY)) {
  installed = join(FIXED_DIRECTORY, NAME)
} else if (values.sudo && spawnSync('sudo', ['-n', 'true']).status === 0) {
  installed = join(FIXED_DIRECTORY, NAME)
  asRoot = true
} else {
  await mkdir(FALLBACK_DIRECTORY, { recursive: true, mode: 0o700 })
  installed = join(FALLBACK_DIRECTORY, NAME)
  if (values.sudo) console.error('sudo needs a password; installed the per-account path instead')
}
if (asRoot) await writeAsRoot(installed)
else installed = await writeOwned(installed)

const probe = spawnSync(installed, ['--identity'], { input: `{"protocolVersion":1,"instanceKey":"${keys[0]}"}\n`, encoding: 'utf8' })
console.log(`Installed helper: ${installed}`)
console.log(probe.status === 0 ? `Identity: ${probe.stdout.trim()}`
  : `Helper refused the query (exit ${probe.status}): ${probe.stderr.trim()}`)
console.log(`Controller helperPath: ${installed}`)
if (installed !== join(FIXED_DIRECTORY, NAME)) {
  console.log(`The controller default is ${join(FIXED_DIRECTORY, NAME)}; configure this path as a profile override,`)
  console.log('or re-run this script with sudo so the fixed path exists and no override is needed.')
}
