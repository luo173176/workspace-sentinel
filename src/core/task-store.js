import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'

import { WorkspaceSentinelError } from './errors.js'
import { fingerprintFile, snapshotTree } from './evidence.js'
import { assertNoLinkComponents, assertTreeNoMounts, containsPath, relativeInside } from './paths.js'

const MODES = new Set(['software', 'artifact', 'audit'])
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function assertMode(mode) {
  if (!MODES.has(mode)) {
    throw new WorkspaceSentinelError('TASK_MODE_INVALID', `Unsupported task mode: ${mode}`, { mode })
  }
}

async function persistState(state) {
  const temporary = `${state.statePath}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, state.statePath)
}

export async function createTask({ dataDir, root, mode, sessionId }) {
  assertMode(mode)
  const absoluteRoot = await realpath(root)
  await mkdir(dataDir, { recursive: true })
  const absoluteDataDir = await realpath(dataDir)
  if (containsPath(path, absoluteRoot, absoluteDataDir)) {
    throw new WorkspaceSentinelError(
      'DATA_DIR_INSIDE_ROOT',
      'Plugin data must be stored outside the task root',
      { root: absoluteRoot, dataDir: absoluteDataDir },
    )
  }

  const id = randomUUID()
  const taskDir = path.join(absoluteDataDir, 'tasks', id)
  const scratchDir = path.join(absoluteDataDir, 'scratch', id)
  await mkdir(taskDir, { recursive: true })
  await mkdir(scratchDir, { recursive: true })

  const state = {
    version: 1,
    id,
    sessionId,
    root: absoluteRoot,
    realRoot: absoluteRoot,
    mode,
    status: 'active',
    createdAt: new Date().toISOString(),
    dataDir: absoluteDataDir,
    taskDir,
    statePath: path.join(taskDir, 'state.json'),
    scratchDir,
    baseline: await snapshotTree(absoluteRoot),
    evidence: {},
    artifact: null,
    software: null,
  }
  await persistState(state)
  return state
}

export async function loadTask(dataDir, taskId) {
  let statePath
  try {
    const absoluteDataDir = await realpath(dataDir)
    const expectedTaskDir = path.join(absoluteDataDir, 'tasks', taskId)
    statePath = path.join(expectedTaskDir, 'state.json')
    if (!TASK_ID.test(taskId)) throw new Error('Invalid task ID')
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    if (state.id !== taskId || !state.root || !state.scratchDir ||
        path.resolve(state.dataDir) !== absoluteDataDir ||
        path.resolve(state.taskDir) !== expectedTaskDir ||
        path.resolve(state.scratchDir) !== path.join(absoluteDataDir, 'scratch', taskId) ||
        path.resolve(state.statePath) !== statePath) {
      throw new Error('State paths do not belong to the requested task')
    }
    return state
  } catch (error) {
    throw new WorkspaceSentinelError(
      'TASK_STATE_CORRUPT',
      `Cannot safely load task state: ${taskId}`,
      { taskId, statePath, cause: error.message },
    )
  }
}

export async function updateTask(state, mutator) {
  await mutator(state)
  await persistState(state)
  return state
}

export async function setTaskMode(state, mode) {
  assertMode(mode)
  return updateTask(state, (current) => {
    if (current.mode !== mode) {
      current.mode = mode
      current.artifact = null
      current.software = null
      current.status = 'active'
    }
  })
}

export function taskScratchPath(state) {
  return state.scratchDir
}

export async function disposeTaskScratch(state) {
  const expected = path.join(state.dataDir, 'scratch', state.id)
  if (path.resolve(state.scratchDir) !== path.resolve(expected)) {
    throw new WorkspaceSentinelError('SCRATCH_PATH_INVALID', 'Scratch path does not belong to this task')
  }
  if (containsPath(path, state.root, expected)) {
    throw new WorkspaceSentinelError('SCRATCH_PATH_INVALID', 'Scratch must remain outside the task root')
  }
  await assertNoLinkComponents(state.dataDir, expected)
  await assertTreeNoMounts(state.dataDir, expected)
  await rm(expected, { recursive: true, force: true })
}

export async function withRootLock(state, operation) {
  const locksDir = path.join(state.dataDir, 'locks')
  await mkdir(locksDir, { recursive: true })
  const key = createHash('sha256').update(state.realRoot).digest('hex')
  const lockPath = path.join(locksDir, `${key}.lock`)
  let handle
  try {
    handle = await open(lockPath, 'wx', 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new WorkspaceSentinelError('TASK_ROOT_LOCKED', 'Another task is finalizing this root', {
        root: state.realRoot,
        lockPath,
      })
    }
    throw error
  }

  try {
    await handle.writeFile(JSON.stringify({ taskId: state.id, pid: process.pid, createdAt: new Date().toISOString() }))
    return await operation()
  } finally {
    await handle.close()
    try {
      await unlink(lockPath)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

export async function assertFingerprintCurrent(state, target) {
  const key = relativeInside(state.root, target)
  const expected = state.evidence[key]?.fingerprint ?? state.baseline[key]
  if (!expected) {
    throw new WorkspaceSentinelError('FILE_EVIDENCE_MISSING', `No fingerprint evidence for ${target}`, { target })
  }
  const current = await fingerprintFile(target)
  const unchanged = current.size === expected.size &&
    current.mtimeMs === expected.mtimeMs &&
    current.mode === expected.mode &&
    current.sha256 === expected.sha256
  if (!unchanged) {
    throw new WorkspaceSentinelError(
      'FILE_CHANGED_AFTER_PLAN',
      `File changed after planning: ${target}`,
      { target },
    )
  }
}
