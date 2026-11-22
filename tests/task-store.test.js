import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'

import { observeCreated } from '../src/core/evidence.js'
import {
  createTask,
  loadTask,
  updateTask,
  setTaskMode,
  withRootLock,
  assertFingerprintCurrent,
  taskScratchPath,
  disposeTaskScratch,
} from '../src/core/task-store.js'

async function setup(t, mode = 'audit') {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sentinel-store-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = path.join(base, 'project')
  const dataDir = path.join(base, 'plugin-data')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(root)
  await writeFile(path.join(root, 'existing.txt'), 'keep')
  const state = await createTask({ dataDir, root, mode, sessionId: 'session-1' })
  return { base, root, dataDir, state }
}

test('createTask persists a reloadable baseline outside the project', async (t) => {
  const { root, dataDir, state } = await setup(t)
  assert.equal(state.mode, 'audit')
  assert.equal(state.sessionId, 'session-1')
  assert.ok(state.baseline['existing.txt'])
  assert.equal(state.root, root)
  assert.ok(!taskScratchPath(state).startsWith(`${root}${path.sep}`))

  const loaded = await loadTask(dataDir, state.id)
  assert.equal(loaded.id, state.id)
  assert.deepEqual(loaded.baseline, state.baseline)
  assert.equal(loaded.statePath.startsWith(`${root}${path.sep}`), false)
})

test('updateTask atomically persists mutations', async (t) => {
  const { dataDir, state } = await setup(t)
  await updateTask(state, (current) => {
    current.status = 'waiting-for-user'
  })

  const loaded = await loadTask(dataDir, state.id)
  assert.equal(loaded.status, 'waiting-for-user')
  const raw = await readFile(state.statePath, 'utf8')
  assert.doesNotThrow(() => JSON.parse(raw))
})

test('invalid task modes are rejected', async (t) => {
  const { dataDir, root } = await setup(t)
  await assert.rejects(
    createTask({ dataDir, root, mode: 'unknown', sessionId: 's' }),
    { code: 'TASK_MODE_INVALID' },
  )
})

test('corrupted state fails closed', async (t) => {
  const { dataDir, state } = await setup(t)
  await writeFile(state.statePath, '{not-json')
  await assert.rejects(loadTask(dataDir, state.id), { code: 'TASK_STATE_CORRUPT' })
})

test('mode transitions preserve baseline and creation evidence', async (t) => {
  const { root, state } = await setup(t)
  const target = path.join(root, 'new-draft.txt')
  await writeFile(target, 'draft')
  await observeCreated(state, target, 'tool-draft')
  const baseline = structuredClone(state.baseline)

  await setTaskMode(state, 'artifact')
  assert.equal(state.mode, 'artifact')
  await setTaskMode(state, 'software')
  assert.equal(state.mode, 'software')
  assert.deepEqual(state.baseline, baseline)
  assert.equal(state.evidence['new-draft.txt'].toolCallId, 'tool-draft')
})

test('scratch disposal removes only plugin-owned scratch', async (t) => {
  const { root, state } = await setup(t, 'artifact')
  const scratch = taskScratchPath(state)
  await writeFile(path.join(scratch, 'draft.tmp'), 'temporary')
  await writeFile(path.join(root, 'final.pptx'), 'final')

  await disposeTaskScratch(state)

  await assert.rejects(access(path.join(scratch, 'draft.tmp')))
  assert.equal(await readFile(path.join(root, 'final.pptx'), 'utf8'), 'final')
})

test('root locks reject concurrent finalization and release afterward', async (t) => {
  const { state } = await setup(t, 'software')
  await withRootLock(state, async () => {
    await assert.rejects(withRootLock(state, async () => {}), { code: 'TASK_ROOT_LOCKED' })
  })
  await withRootLock(state, async () => {})
})

test('assertFingerprintCurrent detects edits after planning', async (t) => {
  const { root, state } = await setup(t, 'artifact')
  const target = path.join(root, 'draft.txt')
  await writeFile(target, 'before')
  await observeCreated(state, target, 'tool-write')

  await assert.doesNotReject(assertFingerprintCurrent(state, target))
  await writeFile(target, 'after')
  await assert.rejects(assertFingerprintCurrent(state, target), { code: 'FILE_CHANGED_AFTER_PLAN' })
})

test('loadTask rejects a task id that escapes the task directory', async (t) => {
  const { base, dataDir, state } = await setup(t)
  const escapedId = '../../escape'
  const escapedDir = path.join(base, 'escape')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(escapedDir)
  const forged = structuredClone(state)
  forged.id = escapedId
  forged.taskDir = escapedDir
  forged.statePath = path.join(escapedDir, 'state.json')
  await writeFile(forged.statePath, `${JSON.stringify(forged)}\n`)

  await assert.rejects(loadTask(dataDir, escapedId), { code: 'TASK_STATE_CORRUPT' })
})

test('loadTask rejects state paths that do not belong to the requested task', async (t) => {
  const { base, dataDir, state } = await setup(t)
  const forged = structuredClone(state)
  forged.dataDir = base
  await writeFile(state.statePath, `${JSON.stringify(forged)}\n`)

  await assert.rejects(loadTask(dataDir, state.id), { code: 'TASK_STATE_CORRUPT' })
})

test('loadTask accepts an equivalent data directory reached through a symlink', async (t) => {
  const { base, dataDir, state } = await setup(t)
  const { symlink } = await import('node:fs/promises')
  const alias = path.join(base, 'data-alias')
  await symlink(dataDir, alias, 'dir')

  const loaded = await loadTask(alias, state.id)
  assert.equal(loaded.id, state.id)
})

test('scratch disposal is safe to repeat after the scratch directory is gone', async (t) => {
  const { state } = await setup(t, 'artifact')
  await disposeTaskScratch(state)
  await assert.doesNotReject(disposeTaskScratch(state))
})
