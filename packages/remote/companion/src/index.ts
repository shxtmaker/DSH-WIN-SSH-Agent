/** Remote Linux instance discovery and authenticated identity route. */
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-cmdline'
import { descriptorMatches, instanceStorage, removeDescriptor, writeDescriptor, type InstanceDescriptor } from './private-files.ts'
import { startSelfHeal } from './self-heal.ts'

/** Milliseconds between descriptor repairs. A plugin reload or a plugin-manager
 * run against the same profile disposes this activation and deletes the file,
 * and the replacement activation only republishes when it reaches readiness. */
export const REPAIR_INTERVAL_MS = 5_000

/** Configuration shared with the fixed-path info helper's instance-key allowlist. */
export interface Config {
  /** Allowlisted identifier shared by the descriptor and restricted helper. */
  readonly instanceKey: string
}

/** Required Host services. */
export const inject = ['connection', 'webServer']
/** Validated remote instance key. */
export const Config: z<Config> = z.object({ instanceKey: z.string().required() })

/**
 * Register an authenticated identity route and keep this boot's private
 * descriptor present for as long as the process runs: publish at activation,
 * publish again on application readiness, and repair any later removal or
 * replacement from another activation. The restricted helper reads only this
 * file, so a missing descriptor makes every connection attempt fail until the
 * running Web process is restarted when no repair loop exists.
 */
export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const { instanceKey } = config
  const home = ctx.profileContext.home
  const storage = await instanceStorage(home, instanceKey)
  const bootId = randomUUID()
  const profile = ctx.profileContext.name
  const workspaceHint = ctx.profileContext.cwd
  const identity = { protocolVersion: 1 as const, instanceKey, instanceId: storage.instanceId,
    bootId, profile, workspaceHint, version: getDshRuntimeVersion(), capabilities: ['web', 'remote.mux'] }
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/remote-workspace/identity', methods: ['GET'], requestBody: 'buffered',
    fetch: () => Promise.resolve(new Response(JSON.stringify(identity), {
      status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })),
  }), 'remote-companion: authenticated identity')
  let disposed = false
  let reported = ''
  const report = (error: unknown): void => {
    // A missing listener during startup repeats every interval; report each
    // distinct failure once and report again after successful publication.
    const message = error instanceof Error ? error.message : String(error)
    if (message === reported) return
    reported = message
    ctx.logger.warn(`remote-companion: descriptor repair failed: ${message}`)
  }
  const publish = async (): Promise<void> => {
    // Repair the private directories on every attempt: a later umask or a
    // reused directory must not leave the helper reading an unsafe path.
    const current = await instanceStorage(home, instanceKey)
    if (ctx.webServer.host !== '127.0.0.1') throw new Error(`remote-companion: Web must bind loopback, not ${ctx.webServer.host}`)
    const port = ctx.webServer.port
    if (!Number.isInteger(port) || port < 1) throw new Error('remote-companion: Web listener unavailable')
    if (await descriptorMatches(current.descriptorPath, { bootId, instanceId: current.instanceId, port })) return
    const descriptor: InstanceDescriptor = { protocolVersion: 1, instanceKey,
      instanceId: current.instanceId, bootId, profile, workspaceHint, port,
      launchUrl: ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(port)}/`),
    }
    await writeDescriptor(current.descriptorPath, descriptor)
    reported = ''
  }
  const ready = ctx.get('appReady')
  if (ready === undefined) await publish()
  else {
    // The listener is often already available before readiness, and another
    // activation may have deleted the descriptor in the meantime. This attempt
    // stays quiet: the readiness hook and the repair loop report failures.
    await publish().catch(() => undefined)
    ctx.effect(() => ready.onReady(() => { void publish().catch(report) }), 'remote-companion: publish on application readiness')
  }
  const stop = startSelfHeal({ intervalMs: REPAIR_INTERVAL_MS, ensure: publish, onError: report, isDisposed: () => disposed })
  ctx.effect(() => stop, 'remote-companion: descriptor repair loop')
  return async () => {
    disposed = true
    stop()
    await removeDescriptor(storage.descriptorPath, bootId)
  }
}
