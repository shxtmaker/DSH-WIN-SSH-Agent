/** Exercise the Git package through the same bundle reader used by the Harness manager. */
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { root, pnpm, run } from './runtime.mjs'

const { values } = parseArgs({ options: { harness: { type: 'string' }, installation: { type: 'string' }, spec: { type: 'string' } } })
if (!values.harness && !values.installation) throw new Error('Specify --harness /path/to/built-harness or --installation /path/to/isolated-cli-installation')
const installation = values.installation && resolve(values.installation)
const installedRequire = installation && createRequire(await realpath(join(installation, 'node_modules/@deepseek-ai/dsh/package.json')))
const operations = installedRequire ? installedRequire.resolve('@deepseek-ai/dsh-plugin-manager/operations') : join(resolve(values.harness), 'packages/boot/plugin-manager/lib/types/operations.js')
const appBoot = installedRequire ? installedRequire.resolve('@deepseek-ai/dsh-app-boot') : join(resolve(values.harness), 'packages/boot/app-boot/lib/index.js')
const { bundleManifest } = await import(pathToFileURL(operations).href)
const { bundlePatchPaths, loadOverlayPatches, composeEntries, resolveBundleDir, loadProfileDirectory, createRuntimeResolution, PluginPackages } = await import(pathToFileURL(appBoot).href)
const temporary = await mkdtemp(join(tmpdir(), 'dsh-agent-git-install-'))
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
    const result = spawnSync(process.execPath, [cli, 'plugin', '--profile', 'git-install-check', 'add', spec], {
      cwd: temporary, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, DSH_HOME: join(temporary, 'dsh-home'), DSH_TELEMETRY: '0' },
    })
    console.log(result.stdout)
    if (result.stderr) console.error(result.stderr)
    assert.equal(result.status, 0, result.error?.message ?? result.stderr)
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
  assert.ok((await readFile(entry, 'utf8')).includes('remote-companion: Web must bind loopback'))
  const helper = resolve(directory, manifest.bin['dsh-remote-info'])
  assert.ok((await readFile(helper, 'utf8')).includes('LINUX_REQUIRED'))
  console.log(`PASS Git installation: ${name}; Harness bundle metadata, patch, Companion entry and helper resolve without build scripts`)
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
    let identityRoute
    ctx.provide('profileContext', { home, name: 'web', cwd: temporary })
    ctx.provide('connection', {
      fetch: { register: route => { identityRoute = route; return () => {} } },
      authenticatedUrl: url => `${url}?token=fixture-private-credential`,
    })
    ctx.provide('webServer', { host: '127.0.0.1', port: 3080 })
    const dispose = await plugin.apply(ctx, { instanceKey: 'default' })
    try {
      const descriptorPath = join(home, 'remote-workspace/run/default.json')
      const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'))
      assert.equal((await stat(descriptorPath)).mode & 0o777, 0o600)
      assert.equal((await stat(dirname(descriptorPath))).mode & 0o777, 0o700)
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
      console.log('PASS Linux runtime with fixture services: descriptor publication, native 0700/0600 permissions, identity route and installed helper; private launch credential omitted')
    } finally { await dispose(); await ctx.fiber.dispose() }
    await assert.rejects(readFile(join(home, 'remote-workspace/run/default.json')), { code: 'ENOENT' })
    console.log('PASS Linux runtime disposal: boot descriptor removed')
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
