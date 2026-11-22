import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename as fsRename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'

import { createTask } from '../src/core/task-store.js'
import { createSoftwarePlan, approveSoftwarePlan } from '../src/core/software-plan.js'
import {
  quarantinePaths,
  restoreQuarantine,
  purgeQuarantine,
} from '../src/core/quarantine.js'

async function exists(target) {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function setup(t, names = ['src/index.js']) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sentinel-quarantine-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = path.join(base, 'project')
  const dataDir = path.join(base, 'data')
  await mkdir(path.join(root, 'dist'), { recursive: true })
  await writeFile(path.join(root, 'dist/app.js'), 'runtime')
  for (const name of names) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await writeFile(path.join(root, name), `content:${name}`)
  }
  const state = await createTask({ dataDir, root, mode: 'software', sessionId: 's' })
  return { base, root, dataDir, state }
}

async function approvedPlan(state, root, quarantine) {
  const plan = await createSoftwarePlan(state, {
    description: 'test quarantine',
    keep: [path.join(root, 'dist')],
    quarantine: quarantine.map((name) => path.join(root, name)),
    verification: {
      kind: 'exit',
      command: { argv: [process.execPath, '-e', 'process.exit(0)'], cwd: root, timeoutMs: 2_000 },
    },
    cloud: { intent: 'none' },
  })
  await approveSoftwarePlan(state, { planId: plan.id, digest: plan.digest })
  return plan
}

test('same-filesystem quarantine preserves content and restores in reverse order', async (t) => {
  const { root, dataDir, state } = await setup(t)
  const plan = await approvedPlan(state, root, ['src'])
  const source = path.join(root, 'src')

  const batch = await quarantinePaths(state, plan)
  assert.equal(batch.status, 'completed')
  assert.equal(batch.entries[0].operation, 'moved')
  assert.equal(await exists(source), false)
  assert.equal(await readFile(batch.entries[0].quarantinePath + '/index.js', 'utf8'), 'content:src/index.js')

  const report = await restoreQuarantine(dataDir, batch.id)
  assert.deepEqual(report.restored, [source])
  assert.equal(await readFile(path.join(source, 'index.js'), 'utf8'), 'content:src/index.js')
})

test('EXDEV fallback copies and verifies before removing the source', async (t) => {
  const { root, state } = await setup(t)
  const plan = await approvedPlan(state, root, ['src/index.js'])
  const source = path.join(root, 'src/index.js')

  const batch = await quarantinePaths(state, plan, {
    rename: async () => {
      throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
    },
  })

  assert.equal(batch.entries[0].method, 'copy')
  assert.equal(await exists(source), false)
  assert.equal(await readFile(batch.entries[0].quarantinePath, 'utf8'), 'content:src/index.js')
  assert.equal(batch.entries[0].fingerprint[source].sha256.length, 64)
})

test('a mid-batch failure rolls back earlier moves', async (t) => {
  const { root, dataDir, state } = await setup(t, ['a.txt', 'b.txt'])
  const plan = await approvedPlan(state, root, ['a.txt', 'b.txt'])
  const first = path.join(root, 'a.txt')
  const second = path.join(root, 'b.txt')

  let error
  try {
    await quarantinePaths(state, plan, {
      rename: async (source, destination) => {
        if (source === second) throw Object.assign(new Error('denied'), { code: 'EACCES' })
        return fsRename(source, destination)
      },
    })
  } catch (caught) {
    error = caught
  }

  assert.equal(error.code, 'QUARANTINE_INCOMPLETE')
  assert.equal(await readFile(first, 'utf8'), 'content:a.txt')
  assert.equal(await readFile(second, 'utf8'), 'content:b.txt')
  const batch = JSON.parse(await readFile(path.join(dataDir, 'quarantine/batches', error.details.batchId, 'batch.json'), 'utf8'))
  assert.equal(batch.status, 'rolled-back')
})

test('a file changed after planning is skipped and left in place', async (t) => {
  const { root, state } = await setup(t)
  const plan = await approvedPlan(state, root, ['src/index.js'])
  const source = path.join(root, 'src/index.js')
  await writeFile(source, 'changed after approval')

  const batch = await quarantinePaths(state, plan)

  assert.equal(batch.entries[0].operation, 'skipped')
  assert.equal(batch.entries[0].reason, 'FILE_CHANGED_AFTER_PLAN')
  assert.equal(await readFile(source, 'utf8'), 'changed after approval')
})

test('symlink replacement is rejected without touching the external target', async (t) => {
  const { base, root, state } = await setup(t)
  const plan = await approvedPlan(state, root, ['src/index.js'])
  const source = path.join(root, 'src/index.js')
  const outside = path.join(base, 'outside.txt')
  await writeFile(outside, 'outside')
  await unlink(source)
  await symlink(outside, source)

  await assert.rejects(quarantinePaths(state, plan), { code: 'QUARANTINE_INCOMPLETE' })
  assert.equal(await readFile(outside, 'utf8'), 'outside')
})

test('quarantine remains recoverable until an independent purge call', async (t) => {
  const { root, dataDir, state } = await setup(t)
  const plan = await approvedPlan(state, root, ['src/index.js'])
  const batch = await quarantinePaths(state, plan)
  const batchDir = path.join(dataDir, 'quarantine/batches', batch.id)

  assert.equal(await exists(batch.entries[0].quarantinePath), true)
  await purgeQuarantine(dataDir, batch.id)
  assert.equal(await exists(batchDir), false)
  assert.equal(await exists(path.join(root, 'src/index.js')), false)
})

test('restore never overwrites an unexpectedly recreated source', async (t) => {
  const { root, dataDir, state } = await setup(t)
  const plan = await approvedPlan(state, root, ['src/index.js'])
  const batch = await quarantinePaths(state, plan)
  const source = path.join(root, 'src/index.js')
  await writeFile(source, 'new user work')

  const report = await restoreQuarantine(dataDir, batch.id)

  assert.equal(report.skipped[0].reason, 'RESTORE_TARGET_EXISTS')
  assert.equal(await readFile(source, 'utf8'), 'new user work')
  assert.equal(await readFile(batch.entries[0].quarantinePath, 'utf8'), 'content:src/index.js')
})
