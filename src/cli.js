#!/usr/bin/env node
import { readFile } from 'node:fs/promises'

import { WorkspaceSentinelError } from './core/errors.js'
import {
  createTask,
  loadTask,
  setTaskMode,
} from './core/task-store.js'
import {
  setArtifactPlan,
  selectArtifactFinal,
  finalizeArtifact,
} from './core/artifact.js'
import {
  createSoftwarePlan,
  approveSoftwarePlan,
  recordCloudVerification,
  runCloudReadback,
} from './core/software-plan.js'
import { finalizeSoftware } from './core/software.js'
import { restoreQuarantine, purgeQuarantine } from './core/quarantine.js'

const COMMANDS = {
  'start': ['data-dir', 'root', 'mode', 'session'],
  'set-mode': ['data-dir', 'task', 'mode'],
  'status': ['data-dir', 'task'],
  'artifact-plan': ['data-dir', 'task', 'file'],
  'select-final': ['data-dir', 'task', 'path', 'by'],
  'software-plan': ['data-dir', 'task', 'file'],
  'approve-plan': ['data-dir', 'task', 'plan', 'digest'],
  'cloud-verified': ['data-dir', 'task', 'plan', 'digest', 'reference'],
  'cloud-readback': ['data-dir', 'task', 'plan', 'digest'],
  'finalize': ['data-dir', 'task'],
  'restore': ['data-dir', 'batch'],
  'purge': ['data-dir', 'batch'],
}

const REQUIRED_FLAGS = {
  ...COMMANDS,
  'start': ['data-dir', 'root', 'mode'],
}

function usageError(message) {
  throw new WorkspaceSentinelError('CLI_ARGUMENT_INVALID', message)
  }

function parseArguments(argv) {
  const name = argv[0]
  if (!COMMANDS[name]) usageError(`Unknown command: ${name ?? '<missing>'}`)
  const flags = {}
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith('--') || value === undefined) {
      usageError(`Expected --flag value at argument ${index}`)
    }
    const key = flag.slice(2)
    if (!COMMANDS[name].includes(key)) usageError(`Unsupported flag for ${name}: ${flag}`)
    if (Object.hasOwn(flags, key)) usageError(`Duplicate flag: ${flag}`)
    flags[key] = value
  }
  for (const required of REQUIRED_FLAGS[name]) {
    if (!Object.hasOwn(flags, required)) usageError(`Missing --${required}`)
  }
  return { name, flags }
  }

async function readJson(file) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    throw new WorkspaceSentinelError('FILE_READ_FAILED', `Cannot read ${file}`, { cause: error.message })
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new WorkspaceSentinelError('JSON_INVALID', `Invalid JSON in ${file}`, { cause: error.message })
  }
}

function summarizeTask(state) {
  return {
    id: state.id,
    sessionId: state.sessionId,
    root: state.root,
    mode: state.mode,
    status: state.status,
    scratchDir: state.scratchDir,
    baselineFiles: Object.keys(state.baseline ?? {}).length,
    observedFiles: Object.keys(state.evidence ?? {}).length,
    artifact: state.artifact ? {
      candidates: state.artifact.candidates.map((candidate) => candidate.path),
      intermediates: state.artifact.intermediates,
      finalPath: state.artifact.finalPath,
      selectedBy: state.artifact.selectedBy,
    } : null,
    software: state.software?.pendingPlan ? {
      planId: state.software.pendingPlan.id,
      digest: state.software.pendingPlan.digest,
      approvedDigest: state.software.approvedDigest,
      cloudVerification: state.software.cloudVerification?.method ?? null,
      lastBatchId: state.software.lastBatchId ?? null,
    } : null,
  }
}

async function execute({ name, flags }) {
  const dataDir = flags['data-dir']
  const taskId = flags.task

  if (name === 'start') {
    const state = await createTask({
      dataDir,
      root: flags.root,
      mode: flags.mode,
      sessionId: flags.session,
    })
    return { taskId: state.id, task: summarizeTask(state) }
  }
  if (name === 'restore') {
    return { report: await restoreQuarantine(dataDir, flags.batch) }
  }
  if (name === 'purge') {
    await purgeQuarantine(dataDir, flags.batch)
    return { purged: flags.batch }
  }

  const state = await loadTask(dataDir, taskId)
  if (name === 'set-mode') {
    await setTaskMode(state, flags.mode)
    return { taskId: state.id, task: summarizeTask(state) }
  }
  if (name === 'status') return { taskId: state.id, task: summarizeTask(state) }
  if (name === 'artifact-plan') {
    await setArtifactPlan(state, await readJson(flags.file))
    return { taskId: state.id, task: summarizeTask(state) }
  }
  if (name === 'select-final') {
    if (!['user', 'agent'].includes(flags.by)) usageError('--by must be user or agent')
    await selectArtifactFinal(state, { finalPath: flags.path, selectedBy: flags.by })
    return { taskId: state.id, task: summarizeTask(state) }
  }
  if (name === 'software-plan') {
    const plan = await createSoftwarePlan(state, await readJson(flags.file))
    return { taskId: state.id, plan }
  }
  if (name === 'approve-plan') {
    await approveSoftwarePlan(state, { planId: flags.plan, digest: flags.digest })
    return { taskId: state.id, task: summarizeTask(state) }
  }
  if (name === 'cloud-verified') {
    await recordCloudVerification(state, {
      planId: flags.plan,
      digest: flags.digest,
      method: 'user-confirmed',
      reference: flags.reference,
    })
    return { taskId: state.id, task: summarizeTask(state) }
  }
  if (name === 'cloud-readback') {
    await runCloudReadback(state, { planId: flags.plan, digest: flags.digest })
    return { taskId: state.id, task: summarizeTask(state) }
  }
  if (name === 'finalize') {
    if (state.mode === 'artifact') return { taskId: state.id, result: await finalizeArtifact(state) }
    if (state.mode === 'software') return { taskId: state.id, result: await finalizeSoftware(state) }
    throw new WorkspaceSentinelError('TASK_MODE_INVALID', 'Audit mode cannot finalize a workspace')
  }
  throw new WorkspaceSentinelError('CLI_COMMAND_INVALID', `Unimplemented command: ${name}`)
}

try {
  const parsed = parseArguments(process.argv.slice(2))
  const result = await execute(parsed)
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)
} catch (error) {
  const safe = error instanceof WorkspaceSentinelError
    ? error
    : new WorkspaceSentinelError('INTERNAL_ERROR', error.message ?? 'Unknown error')
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: {
      code: safe.code,
      message: safe.message,
      ...(safe.details ? { details: safe.details } : {}),
    },
  })}\n`)
  process.exitCode = 1
}
