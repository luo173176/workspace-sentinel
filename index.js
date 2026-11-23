import { createDshAdapter } from './src/adapters/dsh.js'

export const name = 'workspace-sentinel'

export function apply(ctx, options = {}) {
  // DSH only exposes a SessionId on a tool execution's agent; resolve the live
  // Session through ctx.sessions.get(id) (resolved lazily at call time so the
  // service is present whenever the first tool runs).
  const resolveSession = (id) => {
    if (!id) return null
    try {
      const service = (typeof ctx.get === 'function' ? ctx.get('sessions') : undefined) ?? ctx.sessions
      return service?.get?.(id) ?? null
    } catch {
      return null
    }
  }
  const adapter = createDshAdapter({ ...options, resolveSession })
  ctx.on('tools/pre-execute', (exec, next) => adapter.preExecute(exec, next))
  ctx.on('tools/result', (exec, result) => adapter.recordResult(exec, result))
  ctx.on('session/event', (session, event) => adapter.onSessionEvent(session, event))
  ctx.on('session/disposed', (session) => adapter.onDisposed(session))
}

export { createDshAdapter, resolveDshDataDir } from './src/adapters/dsh.js'
