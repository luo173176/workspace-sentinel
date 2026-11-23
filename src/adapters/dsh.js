import os from 'node:os'
import path from 'node:path'

import { finalizeArtifact } from '../core/artifact.js'
import { disposeTaskScratch } from '../core/task-store.js'
import {
  findTaskForHook,
  handleHookEvent,
} from './hook-common.js'

const WRITE_TOOLS = new Set(['write', 'write_file', 'create_file'])
const EDIT_TOOLS = new Set(['edit', 'edit_file', 'multi_edit'])
// DSH ships its shell tool as `pwsh` (Windows) / `bash`; keep the others for
// portability so shell evidence is still recorded on any host.
const SHELL_TOOLS = new Set(['bash', 'shell', 'exec', 'run_command', 'terminal', 'cmd', 'pwsh', 'powershell'])

export function resolveDshDataDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.resolve(home, 'workspace-sentinel')
}

// Real DSH `ToolExecution.agent` is `{ readonly id: SessionId }` only — it has
// no `.session` property. Resolve the live Session from the agent's id through
// the injected `ctx.sessions.get(id)` lookup; fall back to `agent.session` so
// the offline unit-test fixtures (which model a richer agent) still work.
function sessionOf(exec, resolveSession) {
  const id = exec?.agent?.id
  if (resolveSession && id) {
    try {
      const session = resolveSession(id)
      if (session) return session
    } catch {
      // fall through to the legacy shape
    }
  }
  return exec?.agent?.session ?? null
}

function sessionCwd(session) {
  return session?.header?.cwd ?? session?.cwd ?? null
}

function normalizeTool(exec) {
  const name = String(exec?.name ?? '').toLowerCase()
  const args = exec?.arguments ?? {}
  if (WRITE_TOOLS.has(name) || EDIT_TOOLS.has(name)) {
    const target = args.file_path ?? args.filePath ?? args.path ?? args.filename
    if (typeof target !== 'string') return null
    return {
      tool_name: WRITE_TOOLS.has(name) ? 'Write' : 'Edit',
      tool_input: { file_path: target },
    }
  }
  if (name === 'apply_patch') {
    const command = args.command ?? args.patch ?? args.input
    return typeof command === 'string'
      ? { tool_name: 'apply_patch', tool_input: { command } }
      : null
  }
  if (SHELL_TOOLS.has(name)) {
    return {
      tool_name: 'Bash',
      tool_input: {
        command: String(args.command ?? args.cmd ?? args.script ?? ''),
      },
    }
  }
  return null
}

function commandTexts(exec) {
  const args = exec?.arguments
  if (typeof args === 'string') return [args]
  if (!args || typeof args !== 'object') return []
  const values = []
  for (const key of ['command', 'cmd', 'script']) {
    if (typeof args[key] === 'string') values.push(args[key])
  }
  if (Array.isArray(args.argv)) values.push(args.argv.join(' '))
  return values
}

function isSoftwareFinalizeInvocation(exec) {
  const name = String(exec?.name ?? '').toLowerCase()
  if (!SHELL_TOOLS.has(name) && name !== 'node') return false
  return commandTexts(exec).some((command) =>
    /src[\\/]cli\.js["']?\s+finalize(?:\s|$)/.test(command) ||
    /workspace-sentinel["']?\s+finalize(?:\s|$)/.test(command))
}

function hookInput(eventName, session, extra) {
  return {
    hook_event_name: eventName,
    cwd: sessionCwd(session),
    ...extra,
  }
}

export function createDshAdapter(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? resolveDshDataDir())
  const resolveSession = typeof options.resolveSession === 'function' ? options.resolveSession : null
  // A completed turn must NOT silently finalize an artifact task. Finalization
  // is a destructive, quarantining step that requires an explicit finalize
  // intent (the plugin CLI `finalize`, which re-verifies every fingerprint).
  // Keep the legacy turn-end auto-finalize only as an explicit opt-in.
  const autoFinalizeOnTurnEnd = options.autoFinalizeOnTurnEnd === true

  async function resolveTask(session) {
    const cwd = sessionCwd(session)
    if (!session || !cwd) return null
    return findTaskForHook(dataDir, { session_id: session.id, cwd })
  }

  async function preExecute(exec, next) {
    const session = sessionOf(exec, resolveSession)
    if (!session) return next()
    const task = await resolveTask(session)
    if (task?.mode === 'software' && isSoftwareFinalizeInvocation(exec)) {
      const approved = task.mode === 'software' && task.software?.approvedDigest &&
        task.software?.pendingPlan?.digest === task.software.approvedDigest
      if (!approved) {
        return {
          kind: 'deny',
          reason: 'Software finalization requires an explicitly approved plan and cloud gate. No matching approval is recorded.',
          info: { name: 'WorkspaceSentinelError', code: 'SOFTWARE_PLAN_APPROVAL_REQUIRED' },
        }
      }
      return {
        kind: 'ask',
        reason: `The approved software plan ${task.software.approvedDigest.slice(0, 12)} is about to quarantine source and verify only runtime files. Confirm finalization.`,
        displayReason: {
          en: 'Confirm software workspace finalization. Source will move to the recoverable quarantine.',
          zh: '确认精简软件工作区。源码将移入可恢复的隔离区。',
        },
      }
    }

    const normalized = normalizeTool(exec)
    if (!task || !normalized) return next()
    const result = await handleHookEvent('codex', hookInput('PreToolUse', session, {
      ...normalized,
      tool_use_id: exec.callId,
    }), { dataDir, state: task })
    const decision = result?.hookSpecificOutput
    if (decision?.permissionDecision === 'deny') {
      return {
        kind: 'deny',
        reason: decision.permissionDecisionReason,
        info: { name: 'WorkspaceSentinelError', code: 'WORKSPACE_WRITE_DENIED' },
      }
    }
    return next()
  }

  async function recordResult(exec, result) {
    if (result?.isError !== false) return
    const session = sessionOf(exec, resolveSession)
    if (!session) return
    const task = await resolveTask(session)
    const normalized = normalizeTool(exec)
    if (!task || !normalized) return
    await handleHookEvent('codex', hookInput('PostToolUse', session, {
      ...normalized,
      tool_use_id: exec.callId,
      tool_response: result,
    }), { dataDir, state: task })
  }

  async function onSessionEvent(session, event) {
    if (!autoFinalizeOnTurnEnd) return
    if (event?.type !== 'turn/end' || event?.data?.reason?.kind !== 'completed') return
    const task = await resolveTask(session)
    if (!task || task.mode !== 'artifact') return
    if (!task.artifact?.finalPath || task.status !== 'ready-to-finalize') return
    await finalizeArtifact(task)
  }

  async function onDisposed(session) {
    const task = await resolveTask(session)
    if (!task) return
    await disposeTaskScratch(task)
  }

  return { preExecute, recordResult, onSessionEvent, onDisposed, dataDir }
}
