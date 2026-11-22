import path from 'node:path'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'

import {
  diffSnapshots,
  observeCreated,
  sameFingerprint,
  snapshotTree,
} from '../core/evidence.js'
import {
  containsPath,
  relativeInside,
} from '../core/paths.js'
import {
  disposeTaskScratch,
  loadTask,
  updateTask,
} from '../core/task-store.js'

const SCRATCH_SEGMENTS = new Set(['tmp', 'temp', 'scratch', 'debug'])
const SCRATCH_SUFFIXES = ['.tmp', '.temp', '.log']
const ACTIVE_STATUSES = new Set([
  'active',
  'waiting-for-user-selection',
  'ready-to-finalize',
  'waiting-for-plan-approval',
  'plan-approved',
])

export function classifyAfterMissingShellDiff() {
  return 'unknown'
}

export function resolvePluginDataDir(host, dependencies = {}) {
  if (dependencies.dataDir) return path.resolve(dependencies.dataDir)
  const names = host === 'claude'
    ? ['CLAUDE_PLUGIN_DATA', 'PLUGIN_DATA']
    : ['PLUGIN_DATA', 'CLAUDE_PLUGIN_DATA']
  for (const name of names) {
    if (process.env[name]) return path.resolve(process.env[name])
  }
  return null
}

async function listTasks(dataDir) {
  if (!dataDir) return []
  let entries
  try {
    entries = await readdir(path.join(dataDir, 'tasks'), { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const tasks = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const state = await loadTask(dataDir, entry.name)
      if (ACTIVE_STATUSES.has(state.status)) tasks.push(state)
    } catch {
      // A corrupt task must fail closed and must not affect another task.
    }
  }
  return tasks
}

export async function findTaskForHook(dataDir, input) {
  const tasks = await listTasks(dataDir)
  if (tasks.length === 0) return null
  const cwd = path.resolve(input.cwd ?? process.cwd())
  const exact = tasks
    .filter((task) => task.sessionId === input.session_id && containsPath(path, task.root, cwd))
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
  if (exact.length > 0) return exact.at(-1)
  const rooted = tasks
    .filter((task) => containsPath(path, task.root, cwd))
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
  return rooted.length === 1 ? rooted[0] : null
}

function sessionContext() {
  return [
    'Workspace Sentinel is available.',
    'For any software-building or content-artifact task, invoke the workspace-sentinel Skill before creating files.',
    'Write temporary files only to the task scratchDir returned by the start command, and use the CLI cleanup protocol instead of rm or manual deletion.',
  ].join(' ')
}

function contextResult(host, eventName, text) {
  if (host === 'codex') {
    return {
      hookSpecificOutput: { hookEventName: eventName, additionalContext: text },
    }
  }
  return {
    hookSpecificOutput: { hookEventName: eventName, additionalContext: text },
  }
}

function denyResult(host, reason) {
  if (host === 'codex') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
}

function patchPaths(command) {
  const paths = []
  const pattern = /^\*\*\* (?:Add|Update) File: (.+)$/gm
  for (const match of command.matchAll(pattern)) paths.push(match[1].trim())
  return paths
}

function directWritePaths(input) {
  const tool = String(input.tool_name ?? '')
  const toolInput = input.tool_input ?? {}
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const target = toolInput.file_path ?? toolInput.notebook_path
    return typeof target === 'string' ? [target] : []
  }
  if (tool === 'apply_patch' && typeof toolInput.command === 'string') {
    return patchPaths(toolInput.command)
  }
  return []
}

function absoluteTargets(state, input, candidates) {
  return candidates
    .map((candidate) => path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(input.cwd ?? state.root, candidate))
    .filter((target) => containsPath(path, state.root, target))
}

function isDeclaredKeep(state, target) {
  const targets = []
  if (state.artifact) {
    if (state.artifact.finalPath) targets.push(state.artifact.finalPath)
    for (const candidate of state.artifact.candidates ?? []) {
      targets.push(candidate.path, ...(candidate.support ?? []))
    }
  }
  for (const kept of state.software?.pendingPlan?.keep ?? []) targets.push(kept)
  return targets.some((declared) =>
    path.resolve(declared) === target || containsPath(path, declared, target))
}

function isScratchPath(state, target) {
  if (isDeclaredKeep(state, target)) return false
  const relative = relativeInside(state.root, target)
  const segments = relative.split('/').filter(Boolean)
  if (segments.length > 1 && SCRATCH_SEGMENTS.has(segments[0].toLowerCase())) return true
  return SCRATCH_SUFFIXES.some((suffix) => relative.toLowerCase().endsWith(suffix))
}

function pendingPath(state, toolCallId) {
  const hash = createHash('sha256').update(String(toolCallId ?? '')).digest('hex').slice(0, 24)
  return path.join(state.taskDir, 'pending', `${hash}.json`)
}

async function saveShellSnapshot(state, toolCallId) {
  const target = pendingPath(state, toolCallId)
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify({
    toolCallId,
    snapshot: await snapshotTree(state.root),
  }), { mode: 0o600 })
  await rename(temporary, target)
}

async function recordPath(state, target, toolCallId) {
  const key = relativeInside(state.root, target)
  if (state.baseline?.[key]) return false
  const known = state.evidence?.[key]
  if (known && known.class !== 'agent-created') return false
  try {
    await observeCreated(state, target, toolCallId)
    return true
  } catch (error) {
    if (['PREEXISTING_FILE', 'ENOENT', 'PATH_LINK_NOT_ALLOWED'].includes(error?.code)) return false
    throw error
  }
}

function matchingDeletedFingerprint(prior, after, fingerprint) {
  return Object.entries(prior).find(([key, old]) =>
    !after[key] && sameFingerprint(old, fingerprint))?.[0] ?? null
}

function matchingBaselineFingerprint(baseline, fingerprint) {
  return Object.entries(baseline ?? {}).find(([, old]) => sameFingerprint(old, fingerprint))?.[0] ?? null
}

async function recordShellPath(state, key, prior, after, toolCallId) {
  if (state.baseline?.[key]) return false
  const known = state.evidence?.[key]
  if (known && known.class !== 'agent-created') return false
  const fingerprint = after[key]
  if (!fingerprint) return false
  const movedFrom = matchingDeletedFingerprint(prior, after, fingerprint) ??
    matchingBaselineFingerprint(state.baseline, fingerprint)
  if (movedFrom) {
    state.evidence[key] = {
      class: 'preexisting',
      path: path.join(state.root, key),
      toolCallId,
      fingerprint,
      movedFrom,
      observedAt: new Date().toISOString(),
    }
    return true
  }
  return recordPath(state, path.join(state.root, key), toolCallId)
}

async function recordShellDiff(state, input) {
  const pending = pendingPath(state, input.tool_use_id)
  let prior
  try {
    prior = JSON.parse(await readFile(pending, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  try {
    const after = await snapshotTree(state.root)
    const difference = diffSnapshots(prior.snapshot ?? {}, after)
    let changed = false
    for (const key of [...difference.created, ...difference.modified]) {
      if (await recordShellPath(state, key, prior.snapshot ?? {}, after, input.tool_use_id)) changed = true
    }
    if (changed) await updateTask(state, () => {})
    return changed
  } finally {
    await unlink(pending).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
  }
}

async function stopReminder(state, input) {
  if (input.stop_hook_active === true) return {}
  if (state.artifact) {
    const artifact = state.artifact
    if (artifact.candidates.length > 1 && !artifact.finalPath && !artifact.selectionPrompted) {
      await updateTask(state, (current) => {
        current.artifact.selectionPrompted = true
      })
      return {
        decision: 'block',
        reason: 'Multiple final candidates are registered. Ask the user to choose which version to keep, record their choice with select-final --by user, then finalize. Do not delete or finalize before the user chooses.',
      }
    }
    if (artifact.finalPath && state.status !== 'finalized' && !artifact.finalizePrompted) {
      await updateTask(state, (current) => {
        current.artifact.finalizePrompted = true
      })
      return {
        decision: 'block',
        reason: 'The final artifact is selected but task finalization has not run. Run the finalize command, report kept/deleted/skipped files, then finish the response.',
      }
    }
  }
  return {}
}

export async function handleHookEvent(host, input, dependencies = {}) {
  if (!['codex', 'claude'].includes(host)) {
    throw new Error(`Unsupported hook host: ${host}`)
  }
  const dataDir = resolvePluginDataDir(host, dependencies)
  const eventName = input.hook_event_name

  if (eventName === 'SessionStart') {
    return contextResult(host, 'SessionStart', sessionContext())
  }
  if (eventName === 'UserPromptSubmit') {
    return contextResult(host, 'UserPromptSubmit', sessionContext())
  }

  const state = dependencies.state ?? await findTaskForHook(dataDir, input)
  if (!state) return {}

  if (eventName === 'PreToolUse') {
    if (input.tool_name === 'Bash') {
      await saveShellSnapshot(state, input.tool_use_id)
      return contextResult(
        host,
        'PreToolUse',
        `Bash writes are observable only when a before/after snapshot is available. Prefer ${state.scratchDir} for temporary output; files whose creation cannot be attributed stay unknown and are never deleted.`,
      )
    }
    const targets = absoluteTargets(state, input, directWritePaths(input))
    const blocked = targets.find((target) => isScratchPath(state, target))
    if (blocked) {
      return denyResult(host,
        `Direct writes to temporary or scratch paths are disabled. Write inside the task scratch directory (${state.scratchDir}) or register the file as a final/support/keep path.`)
    }
    return {}
  }

  if (eventName === 'PostToolUse') {
    if (input.tool_name === 'Bash') {
      await recordShellDiff(state, input)
      return {}
    }
    let changed = false
    for (const target of absoluteTargets(state, input, directWritePaths(input))) {
      if (await recordPath(state, target, input.tool_use_id)) changed = true
    }
    if (changed) await updateTask(state, () => {})
    return {}
  }

  if (eventName === 'Stop') {
    return stopReminder(state, input)
  }

  if (eventName === 'SessionEnd' && host === 'claude') {
    const tasks = await listTasks(dataDir)
    const exact = tasks.filter((candidate) => candidate.sessionId === input.session_id)
    if (exact.length > 0) {
      for (const task of exact) await disposeTaskScratch(task)
    } else {
      const task = await findTaskForHook(dataDir, input)
      if (task) await disposeTaskScratch(task)
    }
    return {}
  }

  return {}
}

export async function runHookEntry(host) {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let input
  try {
    input = raw.trim() ? JSON.parse(raw) : {}
  } catch {
    process.stdout.write(`${JSON.stringify({ systemMessage: 'Workspace Sentinel ignored malformed hook JSON.' })}\n`)
    return
  }
  try {
    const result = await handleHookEvent(host, input)
    if (result && Object.keys(result).length > 0) {
      process.stdout.write(`${JSON.stringify(result)}\n`)
    }
  } catch (error) {
    const code = error?.code ?? 'HOOK_FAILED'
    process.stdout.write(`${JSON.stringify({
      systemMessage: `Workspace Sentinel hook failed safely (${code}). No cleanup was performed.`,
    })}\n`)
  }
}
