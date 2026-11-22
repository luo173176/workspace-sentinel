import { createDshAdapter } from './src/adapters/dsh.js'

export const name = 'workspace-sentinel'

export function apply(ctx, options = {}) {
  const adapter = createDshAdapter(options)
  ctx.on('tools/pre-execute', (exec, next) => adapter.preExecute(exec, next))
  ctx.on('tools/result', (exec, result) => adapter.recordResult(exec, result))
  ctx.on('session/event', (session, event) => adapter.onSessionEvent(session, event))
  ctx.on('session/disposed', (session) => adapter.onDisposed(session))
}

export { createDshAdapter, resolveDshDataDir } from './src/adapters/dsh.js'
