/** Remote Linux instance discovery and authenticated identity route. */
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-cmdline'
import { instanceStorage, removeDescriptor, writeDescriptor, type InstanceDescriptor } from './private-files.ts'

/** Configuration shared with the fixed-path info helper's instance-key allowlist. */
export interface Config {
  /** Allowlisted identifier shared by the descriptor and restricted helper. */
  readonly instanceKey: string
}

/** Required Host services. */
export const inject = ['connection', 'webServer']
/** Validated remote instance key. */
export const Config: z<Config> = z.object({ instanceKey: z.string().required() })

/** Register an authenticated identity route and publish this boot's private descriptor after readiness. */
export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const { instanceKey } = config
  const storage = await instanceStorage(ctx.profileContext.home, instanceKey)
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
  const publish = async (): Promise<void> => {
    if (ctx.webServer.host !== '127.0.0.1') throw new Error('remote-companion: Web must bind loopback')
    const port = ctx.webServer.port
    if (!Number.isInteger(port) || port < 1) throw new Error('remote-companion: Web listener unavailable')
    const descriptor: InstanceDescriptor = { protocolVersion: 1, instanceKey,
      instanceId: storage.instanceId, bootId, profile, workspaceHint, port,
      launchUrl: ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(port)}/`),
    }
    await writeDescriptor(storage.descriptorPath, descriptor)
  }
  const ready = ctx.get('appReady')
  if (ready === undefined) await publish()
  else ctx.effect(() => ready.onReady(() => { void publish().catch(() => { ctx.logger.error('remote-companion: descriptor publication failed') }) }),
    'remote-companion: publish on application readiness')
  return async () => { await removeDescriptor(storage.descriptorPath, bootId) }
}
