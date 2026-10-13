#!/usr/bin/env node
// Linux helper. The caller supplies only an allowlisted instance key on stdin.
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { ControlError, LIMITS, controlError, controlOk, parseControlRequest, safeAction } from './control-protocol.mjs'
import { readHelperConfig } from './private-storage.mjs'
import { runControlAction } from './service-manager.mjs'

function fail(code) { process.stderr.write(`${code}\n`); process.exitCode = 1 }
async function safeDirectory(path, isHome = false) {
  const info = await lstat(path)
  const unsafeBits = isHome ? 0o022 : 0o077
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & unsafeBits) !== 0) throw Error('UNSAFE_PATH')
}
async function readRequest(limit) {
  let input = ''
  for await (const chunk of process.stdin) {
    input += chunk.toString('utf8')
    if (Buffer.byteLength(input) > limit) throw Error('BAD_INPUT')
  }
  return input
}
async function discovery(identityOnly) {
  const home = process.env.DSH_HOME
  const allowed = (process.env.DSH_REMOTE_INSTANCE_KEYS ?? '').split(',').filter(Boolean)
  if (!home || !isAbsolute(home) || allowed.length === 0 || !allowed.every(key => /^[A-Za-z0-9_-]{1,64}$/.test(key))) throw Error('CONFIG_REQUIRED')
  const input = await readRequest(4096)
  if (!input.endsWith('\n') || input.trimEnd().includes('\n')) throw Error('BAD_INPUT')
  const request = JSON.parse(input)
  if (request.protocolVersion !== 1 || typeof request.instanceKey !== 'string'
    || !allowed.includes(request.instanceKey)) throw Error('BAD_INPUT')
  const root = join(home, 'remote-workspace')
  const run = join(root, 'run')
  await safeDirectory(home, true); await safeDirectory(root); await safeDirectory(run)
  const path = join(run, `${request.instanceKey}.json`)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || info.size > 65_536) throw Error('UNSAFE_FILE')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let text
  try { text = await file.readFile('utf8') } finally { await file.close() }
  const value = JSON.parse(text)
  if (value.protocolVersion !== 1 || value.instanceKey !== request.instanceKey
    || typeof value.instanceId !== 'string' || typeof value.bootId !== 'string'
    || typeof value.profile !== 'string' || typeof value.workspaceHint !== 'string'
    || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
    || typeof value.launchUrl !== 'string') throw Error('BAD_DESCRIPTOR')
  const output = JSON.stringify(identityOnly ? {
    protocolVersion: value.protocolVersion, instanceKey: value.instanceKey,
    instanceId: value.instanceId, bootId: value.bootId, profile: value.profile,
    workspaceHint: value.workspaceHint, port: value.port,
  } : value) + '\n'
  if (Buffer.byteLength(output) > 65_536) throw Error('BAD_DESCRIPTOR')
  process.stdout.write(output)
}
/**
 * The management path: one request line in, one bounded JSON line out, always exit 0.
 *
 * A structured failure envelope — never a non-zero exit — is what keeps a new helper
 * distinguishable from an old one, whose `--control` answer is a plain BAD_INPUT on stderr.
 */
async function control() {
  let action = 'status'
  try {
    const input = await readRequest(LIMITS.requestBytes)
    action = safeAction(input)
    if (process.platform !== 'linux') throw new ControlError('LINUX_REQUIRED', 'the management helper requires Linux')
    const request = parseControlRequest(input)
    action = request.action
    const config = readHelperConfig(process.env)
    if (!config.keys.includes(request.instanceKey)) throw new ControlError('BAD_INPUT', 'the instance key is not allowlisted')
    process.stdout.write(controlOk(request.action, await runControlAction(request, config, process.env)))
  } catch (error) {
    const code = error instanceof ControlError ? error.code
      : error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'CONTROL_FAILED'
    const detail = error instanceof ControlError ? error.detail : ''
    try { process.stdout.write(controlError(action, code, detail)) } catch { process.exitCode = 1 }
  }
}
async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--control') {
    await control()
    return
  }
  if (process.platform !== 'linux') throw Error('LINUX_REQUIRED')
  const identityOnly = process.argv.length === 3 && process.argv[2] === '--identity'
  if (process.argv.length > 3 || (process.argv.length === 3 && !identityOnly)) throw Error('BAD_INPUT')
  await discovery(identityOnly)
}
await main().catch(error => { fail(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'INFO_FAILED') })
