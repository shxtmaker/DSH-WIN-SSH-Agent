/** Exercise the Git package through the same bundle reader used by the Harness manager. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { root, pnpm, run } from './runtime.mjs'

const { values } = parseArgs({ options: { harness: { type: 'string' }, installation: { type: 'string' }, spec: { type: 'string' }, 'previous-spec': { type: 'string' } } })
if (!values.harness && !values.installation) throw new Error('Specify --harness /path/to/built-harness or --installation /path/to/isolated-cli-installation')
if (values['previous-spec'] && !values.installation) throw new Error('--previous-spec requires --installation')
const installation = values.installation && resolve(values.installation)
const installedRequire = installation && createRequire(await realpath(join(installation, 'node_modules/@deepseek-ai/dsh/package.json')))
const operations = installedRequire ? installedRequire.resolve('@deepseek-ai/dsh-plugin-manager/operations') : join(resolve(values.harness), 'packages/boot/plugin-manager/lib/types/operations.js')
const appBoot = installedRequire ? installedRequire.resolve('@deepseek-ai/dsh-app-boot') : join(resolve(values.harness), 'packages/boot/app-boot/lib/index.js')
const { bundleManifest } = await import(pathToFileURL(operations).href)
const { bundlePatchPaths, loadOverlayPatches, composeEntries, resolveBundleDir, loadProfileDirectory, createRuntimeResolution, PluginPackages } = await import(pathToFileURL(appBoot).href)
const temporary = await mkdtemp(join(tmpdir(), 'dsh-agent-git-install-'))
/** Poll for a value a repair loop publishes asynchronously. */
async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value !== undefined) return value
    if (Date.now() > deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}
try {
  let spec = values.spec
  if (!spec) {
    const repository = join(temporary, 'repository')
    await mkdir(repository)
    const tracked = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true })
    assert.equal(tracked.status, 0, tracked.stderr)
    for (const file of new Set(tracked.stdout.split('\0').filter(Boolean))) {
      const destination = join(repository, file)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(join(root, file), destination)
    }
    run('git', ['init', '--initial-branch=main'], repository)
    run('git', ['add', '.'], repository)
    run('git', ['-c', 'user.name=Installation Test', '-c', 'user.email=test@localhost', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Installation fixture'], repository)
    spec = `git+${pathToFileURL(repository).href}#main`
  }
  const profile = installation ? join(temporary, 'dsh-home/profiles/git-install-check') : join(temporary, 'profile')
  if (installation) {
    const cli = join(dirname(await realpath(join(installation, 'node_modules/@deepseek-ai/dsh/package.json'))), 'lib/bin.js')
    function add(specification) {
      const result = spawnSync(process.execPath, [cli, 'plugin', '--profile', 'git-install-check', 'add', specification], {
        cwd: temporary, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, DSH_HOME: join(temporary, 'dsh-home'), DSH_TELEMETRY: '0' },
      })
      console.log(result.stdout)
      if (result.stderr) console.error(result.stderr)
      assert.equal(result.status, 0, result.error?.message ?? result.stderr)
    }
    if (values['previous-spec']) {
      add(values['previous-spec'])
      const oldEntry = createRequire(join(profile, 'package.json')).resolve('dsh-win-ssh-agent-source')
      const oldRuntime = await readFile(oldEntry, 'utf8')
      assert.ok(oldRuntime.includes('throw new Error("remote-companion: unsafe private directory")'), 'Upgrade fixture must begin with the original directory check')
      await writeFile(join(profile, 'upgrade-preservation-fixture.txt'), 'preserve existing profile data\n')
    }
    add(spec)
    if (values['previous-spec']) {
      const freshEntry = createRequire(join(profile, 'package.json')).resolve('dsh-win-ssh-agent-source')
      const expected = createHash('sha256').update(await readFile(join(root, 'runtime/index.js'))).digest('hex')
      const actual = createHash('sha256').update(await readFile(freshEntry)).digest('hex')
      assert.equal(actual, expected, 'Pinned update must install the repaired runtime bytes')
      assert.equal(await readFile(join(profile, 'upgrade-preservation-fixture.txt'), 'utf8'), 'preserve existing profile data\n')
      console.log(`PASS existing-profile pinned Git update: repaired runtime SHA-256 ${actual}; profile data preserved`)
    }
  } else {
    await mkdir(profile)
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'agent-installation-test', private: true, type: 'module' }) + '\n')
    pnpm(['add', spec, '--ignore-scripts', '--config.auto-install-peers=false'], profile)
  }
  const installed = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  const names = Object.keys(installed.dependencies)
  assert.equal(names.length, 1, 'The isolated profile must contain exactly the requested Git package')
  const name = names[0]
  if (installation) assert.ok(installed.dsh.profile.bundles.includes(name), 'CLI must select the installed bundle in the profile')
  const manifest = bundleManifest(name, profile, join(profile, 'package.json'))
  assert.ok(manifest, 'not-bundle: 这个包没有声明组合包，不能作为插件管理')
  const directory = resolveBundleDir('dsh', name, join(profile, 'package.json'), profile)
  const patches = bundlePatchPaths(directory, manifest.dsh.bundle).flatMap(file => loadOverlayPatches('dsh', file))
  const rows = composeEntries([patches])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'remote-workspace-companion')
  assert.equal(rows[0].config.instanceKey, 'default')
  const require = createRequire(join(profile, 'package.json'))
  const entry = require.resolve(rows[0].name)
  const entrySource = await readFile(entry, 'utf8')
  assert.ok(entrySource.includes('remote-companion: Web must bind loopback'))
  assert.ok(entrySource.includes('descriptor repair'), 'Runtime must carry the descriptor repair loop')
  const helper = resolve(directory, manifest.bin['dsh-remote-info'])
  assert.ok((await readFile(helper, 'utf8')).includes('LINUX_REQUIRED'))
  console.log(`PASS ${spec.startsWith('file:') ? 'standalone' : 'Git'} installation: ${name}; Harness bundle metadata, patch, Companion entry and helper resolve without build scripts`)
  if (process.platform === 'linux') {
    const runtimeRequire = installedRequire ?? createRequire(entry)
    const { Context } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/cordis')).href)
    const ctx = new Context()
    if (installation) {
      const anchor = await realpath(join(installation, 'node_modules/@deepseek-ai/dsh/package.json'))
      const loaded = loadProfileDirectory('dsh', profile, anchor)
      const resolution = await createRuntimeResolution({ installAnchor: anchor, profile: loaded, home: join(temporary, 'dsh-home') })
      await ctx.plugin(PluginPackages, { resolution })
    }
    const plugin = await import(pathToFileURL(entry).href)
    const home = join(temporary, 'native-home')
    await mkdir(home)
    await chmod(home, 0o775)
    await mkdir(join(home, 'remote-workspace'))
    await chmod(join(home, 'remote-workspace'), 0o755)
    for (const [listener, error] of [
      [{ host: '127.0.0.1', port: undefined, protocol: 'http:' }, /Web listener unavailable/u],
      [{ host: '127.0.0.1', port: 0, protocol: 'http:' }, /Web listener unavailable/u],
      [{ host: '127.0.0.1', port: 3080, protocol: 'https:' }, /UNSUPPORTED_WEB_TRANSPORT/u],
      [{ host: '::1', port: 3080, protocol: 'http:' }, /Web must bind loopback/u],
    ]) {
      const rejected = new Context()
      rejected.provide('profileContext', { home, name: 'web', cwd: temporary })
      rejected.provide('connection', {
        fetch: { register: () => () => {} },
        authenticatedUrl: () => { throw new Error('Unsupported listener must not mint a launch URL') },
      })
      rejected.provide('webServer', listener)
      try {
        await assert.rejects(plugin.apply(rejected, { instanceKey: 'default' }), error)
        await assert.rejects(readFile(join(home, 'remote-workspace/run/default.json')), { code: 'ENOENT' })
      } finally { await rejected.fiber.dispose() }
    }
    console.log('PASS listener compatibility: unbound port, zero port, TLS and IPv6 never publish a descriptor')
    let identityRoute
    ctx.provide('profileContext', { home, name: 'web', cwd: temporary })
    ctx.provide('connection', {
      fetch: { register: route => { identityRoute = route; return () => {} } },
      authenticatedUrl: url => `${url}?token=fixture-private-credential`,
    })
    ctx.provide('webServer', { host: '127.0.0.1', port: 3080, protocol: 'http:' })
    const dispose = await plugin.apply(ctx, { instanceKey: 'default' })
    try {
      const descriptorPath = join(home, 'remote-workspace/run/default.json')
      const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'))
      assert.equal((await stat(descriptorPath)).mode & 0o777, 0o600)
      assert.equal((await stat(dirname(descriptorPath))).mode & 0o777, 0o700)
      assert.equal((await stat(home)).mode & 0o777, 0o755)
      assert.equal((await stat(join(home, 'remote-workspace'))).mode & 0o777, 0o700)
      assert.equal(descriptor.profile, 'web')
      assert.equal(descriptor.workspaceHint, temporary)
      assert.equal(descriptor.port, 3080)
      const identity = spawnSync(process.execPath, [helper, '--identity'], {
        input: '{"protocolVersion":1,"instanceKey":"default"}\n', encoding: 'utf8',
        env: { ...process.env, DSH_HOME: home, DSH_REMOTE_INSTANCE_KEYS: 'default' },
      })
      assert.equal(identity.status, 0, identity.stderr)
      const reported = JSON.parse(identity.stdout)
      assert.equal(reported.instanceId, descriptor.instanceId)
      assert.equal(reported.bootId, descriptor.bootId)
      assert.equal(reported.launchUrl, undefined)
      assert.ok(!identity.stdout.includes('fixture-private-credential'))
      assert.equal(identityRoute.path, '/api/remote-workspace/identity')
      assert.equal((await (await identityRoute.fetch()).json()).instanceId, descriptor.instanceId)
      console.log('PASS Linux runtime with fixture services: owned 0775 home and reused 0755 subtree repaired, descriptor publication, native 0700/0600 permissions, identity route and installed helper; private launch credential omitted')
      // A plugin reload or a plugin-manager run deletes the descriptor while the
      // Web process keeps running, which used to disable every later connection
      // until an operator restarted the service.
      await rm(descriptorPath)
      await assert.rejects(readFile(descriptorPath), { code: 'ENOENT' })
      const refused = spawnSync(process.execPath, [helper, '--identity'], {
        input: '{"protocolVersion":1,"instanceKey":"default"}\n', encoding: 'utf8',
        env: { ...process.env, DSH_HOME: home, DSH_REMOTE_INSTANCE_KEYS: 'default' },
      })
      assert.equal(refused.stderr.trim(), 'INFO_FAILED', 'A deleted descriptor must be reported as INFO_FAILED before repair')
      const restored = await waitFor(async () => {
        try { return JSON.parse(await readFile(descriptorPath, 'utf8')) } catch { return undefined }
      }, 20_000)
      assert.ok(restored, 'The repair loop must republish a deleted descriptor while the process keeps running')
      assert.equal(restored.bootId, descriptor.bootId)
      assert.equal(restored.instanceId, descriptor.instanceId)
      assert.equal((await stat(descriptorPath)).mode & 0o777, 0o600)
      const healed = spawnSync(process.execPath, [helper, '--identity'], {
        input: '{"protocolVersion":1,"instanceKey":"default"}\n', encoding: 'utf8',
        env: { ...process.env, DSH_HOME: home, DSH_REMOTE_INSTANCE_KEYS: 'default' },
      })
      assert.equal(healed.status, 0, healed.stderr)
      assert.equal(JSON.parse(healed.stdout).bootId, descriptor.bootId)
      console.log('PASS Linux runtime repair loop: a descriptor deleted after publication is republished with the same boot, 0600 permissions and a working helper query')
    } finally { await dispose(); await ctx.fiber.dispose() }
    await assert.rejects(readFile(join(home, 'remote-workspace/run/default.json')), { code: 'ENOENT' })
    console.log('PASS Linux runtime disposal: boot descriptor removed')
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
