import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'

import { createTask } from '../src/core/task-store.js'
import { createSoftwarePlan, approveSoftwarePlan } from '../src/core/software-plan.js'
import { finalizeSoftware } from '../src/core/software.js'

const fixture = (name) => path.resolve(`tests/fixtures/${name}`)

async function setup(t, runtimeCode = 'process.exit(0)') {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sentinel-software-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = path.join(base, 'project')
  const dataDir = path.join(base, 'data')
  await mkdir(path.join(root, 'src'), { recursive: true })
  await mkdir(path.join(root, 'dist'), { recursive: true })
  await writeFile(path.join(root, 'src/index.js'), 'source')
  await writeFile(path.join(root, 'dist/app.js'), runtimeCode)
  await writeFile(path.join(root, 'note.txt'), 'user note')
  const state = await createTask({ dataDir, root, mode: 'software', sessionId: 's' })
  return { base, root, dataDir, state }
}

async function planFor(state, root, verification) {
  const plan = await createSoftwarePlan(state, {
    description: 'test finalization',
    keep: [path.join(root, 'dist')],
    quarantine: [path.join(root, 'src')],
    verification: verification ?? {
      kind: 'exit',
      command: {
        argv: [process.execPath, path.join(root, 'dist/app.js')],
        cwd: root,
        timeoutMs: 1_000,
      },
    },
    cloud: { intent: 'none' },
  })
  await approveSoftwarePlan(state, { planId: plan.id, digest: plan.digest })
  return plan
}

test('successful finalization quarantines source and preserves the runtime', async (t) => {
  const { root, state } = await setup(t)
  await planFor(state, root)

  const report = await finalizeSoftware(state)

  assert.equal(report.verification, 'passed')
  assert.deepEqual(report.kept, [path.join(root, 'dist')])
  assert.deepEqual(report.quarantined, [path.join(root, 'src')])
  assert.equal(await readFile(path.join(root, 'dist/app.js'), 'utf8'), 'process.exit(0)')
  await assert.rejects(access(path.join(root, 'src/index.js')))
  assert.equal(state.status, 'finalized')
})

test('failed verification restores every quarantined source file', async (t) => {
  const { root, dataDir, state } = await setup(t, 'process.exit(1)')
  await planFor(state, root)

  await assert.rejects(finalizeSoftware(state), { code: 'VERIFICATION_FAILED' })

  assert.equal(await readFile(path.join(root, 'src/index.js'), 'utf8'), 'source')
  const batch = JSON.parse(await readFile(path.join(dataDir, 'quarantine/batches', state.software.lastBatchId, 'batch.json'), 'utf8'))
  assert.equal(batch.status, 'restored')
  assert.notEqual(state.status, 'finalized')
})

test('readiness timeout restores quarantine and reports the timeout', async (t) => {
  const { root, state } = await setup(t)
  const pidFile = path.join(root, 'owned.pid')
  const readyFile = path.join(root, 'never.ready')
  await planFor(state, root, {
    kind: 'long-running',
    start: {
      argv: [process.execPath, fixture('verify-server.js'), pidFile, readyFile, 'no'],
      cwd: root,
      timeoutMs: 250,
    },
    ready: {
      argv: [process.execPath, fixture('verify-ready.js'), readyFile],
      cwd: root,
      timeoutMs: 50,
    },
  })

  await assert.rejects(finalizeSoftware(state), { code: 'VERIFICATION_TIMEOUT' })
  assert.equal(await readFile(path.join(root, 'src/index.js'), 'utf8'), 'source')
})

test('verification debris is quarantined while unrelated new files remain', async (t) => {
  const { root, state } = await setup(t, [
    "import { writeFileSync } from 'node:fs'",
    "writeFileSync('run-cache.tmp', 'cache')",
    "writeFileSync('notes.dat', 'notes')",
    'process.exit(0)',
  ].join('\n'))
  await planFor(state, root)

  const report = await finalizeSoftware(state)

  assert.deepEqual(report.postVerificationQuarantined, [path.join(root, 'run-cache.tmp')])
  await assert.rejects(access(path.join(root, 'run-cache.tmp')))
  assert.equal(await readFile(path.join(root, 'notes.dat'), 'utf8'), 'notes')
})

test('changed quarantine entries are skipped and reported in the finalization result', async (t) => {
  const { root, state } = await setup(t)
  await planFor(state, root)
  await writeFile(path.join(root, 'src/index.js'), 'changed after approval')

  const report = await finalizeSoftware(state)

  assert.equal(report.verification, 'passed')
  assert.deepEqual(report.quarantineSkipped, [
    { path: path.join(root, 'src'), reason: 'FILE_CHANGED_AFTER_PLAN' },
  ])
  assert.equal(await readFile(path.join(root, 'src/index.js'), 'utf8'), 'changed after approval')
})

test('verification renaming a preexisting file never quarantines the moved content', async (t) => {
  const { root, state } = await setup(t, [
    "import { renameSync } from 'node:fs'",
    "renameSync('note.txt', 'run-cache.tmp')",
    'process.exit(0)',
  ].join('\n'))
  await planFor(state, root)

  const report = await finalizeSoftware(state)

  assert.deepEqual(report.postVerificationQuarantined, [])
  assert.equal(await readFile(path.join(root, 'run-cache.tmp'), 'utf8'), 'user note')
})
