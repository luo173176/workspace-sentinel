import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'

import { createTask } from '../src/core/task-store.js'
import { observeCreated } from '../src/core/evidence.js'
import {
  setArtifactPlan,
  selectArtifactFinal,
  finalizeArtifact,
} from '../src/core/artifact.js'

async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sentinel-artifact-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = path.join(base, 'project')
  const dataDir = path.join(base, 'data')
  await mkdir(root)
  const state = await createTask({ dataDir, root, mode: 'artifact', sessionId: 's' })
  return { base, root, dataDir, state }
}

async function created(state, root, name, content = name) {
  const target = path.join(root, name)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
  await observeCreated(state, target, `tool-${name}`)
  return target
}

test('single final keeps support and permanently deletes only planned intermediates', async (t) => {
  const { root, dataDir, state } = await setup(t)
  const finalPath = await created(state, root, 'final.pptx')
  const support = await created(state, root, 'assets/theme.dat')
  const intermediate = await created(state, root, 'draft.tmp')

  await setArtifactPlan(state, {
    candidates: [{ path: finalPath, support: [support] }],
    intermediates: [intermediate],
  })
  const report = await finalizeArtifact(state)

  assert.equal(await readFile(finalPath, 'utf8'), 'final.pptx')
  assert.equal(await readFile(support, 'utf8'), 'assets/theme.dat')
  await assert.rejects(access(intermediate))
  assert.deepEqual(report.deleted, [intermediate])
  assert.deepEqual(report.kept.sort(), [finalPath, support].sort())
  assert.equal(state.status, 'finalized')
  await assert.rejects(access(path.join(dataDir, 'quarantine')))

  const audit = await readFile(path.join(state.taskDir, 'audit.jsonl'), 'utf8')
  assert.equal(audit.includes('"action":"permanent-delete"'), true)
  assert.equal(audit.includes('"action":"keep-final"'), true)
})

test('multiple candidates wait for user selection then remove the unselected version', async (t) => {
  const { root, state } = await setup(t)
  const first = await created(state, root, 'version-a.pptx')
  const second = await created(state, root, 'version-b.pptx')
  await setArtifactPlan(state, {
    candidates: [{ path: first, support: [] }, { path: second, support: [] }],
    intermediates: [],
  })

  await assert.rejects(finalizeArtifact(state), { code: 'ARTIFACT_SELECTION_REQUIRED' })
  assert.equal(await readFile(first, 'utf8'), 'version-a.pptx')
  assert.equal(await readFile(second, 'utf8'), 'version-b.pptx')
  await assert.rejects(
    selectArtifactFinal(state, { finalPath: first, selectedBy: 'agent' }),
    { code: 'ARTIFACT_SELECTION_REQUIRED' },
  )

  await selectArtifactFinal(state, { finalPath: first, selectedBy: 'user' })
  const report = await finalizeArtifact(state)
  assert.equal(await readFile(first, 'utf8'), 'version-a.pptx')
  await assert.rejects(access(second))
  assert.deepEqual(report.deleted, [second])
})

test('preexisting and unknown files are reported and preserved', async (t) => {
  const { root, state } = await setup(t)
  const preexisting = path.join(root, 'user-source.txt')
  await writeFile(preexisting, 'user work')
  const recreated = await createTask({ dataDir: state.dataDir, root, mode: 'artifact', sessionId: 'other' })
  assert.ok(recreated.baseline['user-source.txt'])

  const finalPath = await created(recreated, root, 'final.pdf')
  const unknown = path.join(root, 'unknown.tmp')
  await writeFile(unknown, 'unknown creator')
  await setArtifactPlan(recreated, {
    candidates: [{ path: finalPath, support: [] }],
    intermediates: [preexisting, unknown],
  })
  const report = await finalizeArtifact(recreated)

  assert.equal(await readFile(preexisting, 'utf8'), 'user work')
  assert.equal(await readFile(unknown, 'utf8'), 'unknown creator')
  assert.equal(report.skipped.find((x) => x.path === preexisting).reason, 'PREEXISTING_FILE')
  assert.equal(report.skipped.find((x) => x.path === unknown).reason, 'UNKNOWN_OWNERSHIP')
})

test('a file changed after planning is skipped rather than deleted', async (t) => {
  const { root, state } = await setup(t)
  const finalPath = await created(state, root, 'final.html')
  const intermediate = await created(state, root, 'scratch.tmp')
  await setArtifactPlan(state, {
    candidates: [{ path: finalPath, support: [] }],
    intermediates: [intermediate],
  })
  await writeFile(intermediate, 'user edited after plan')

  const report = await finalizeArtifact(state)

  assert.equal(report.skipped.find((x) => x.path === intermediate).reason, 'FILE_CHANGED_AFTER_PLAN')
  assert.equal(await readFile(intermediate, 'utf8'), 'user edited after plan')
})

test('protected credential paths are never permanently deleted', async (t) => {
  const { root, state } = await setup(t)
  const finalPath = await created(state, root, 'final.pptx')
  const credential = await created(state, root, '.env', 'TOKEN=secret')
  await setArtifactPlan(state, {
    candidates: [{ path: finalPath, support: [] }],
    intermediates: [credential],
  })

  const report = await finalizeArtifact(state)

  assert.equal(report.skipped.find((x) => x.path === credential).reason, 'PROTECTED_PATH')
  assert.equal(await readFile(credential, 'utf8'), 'TOKEN=secret')
})

test('a symlinked parent rejects the plan without touching its target', async (t) => {
  const { base, root, state } = await setup(t)
  const finalPath = await created(state, root, 'final.pptx')
  const outside = path.join(base, 'outside')
  await mkdir(outside)
  const target = path.join(outside, 'keep.txt')
  await writeFile(target, 'outside data')
  await symlink(outside, path.join(root, 'linked'), 'dir')

  await assert.rejects(setArtifactPlan(state, {
    candidates: [{ path: finalPath, support: [] }],
    intermediates: [path.join(root, 'linked/keep.txt')],
  }), { code: 'PATH_LINK_NOT_ALLOWED' })
  assert.equal(await readFile(target, 'utf8'), 'outside data')
})

test('plugin scratch intermediates are deleted outside the workspace', async (t) => {
  const { root, state } = await setup(t)
  const finalPath = await created(state, root, 'final.pptx')
  const scratchFile = path.join(state.scratchDir, 'render.tmp')
  await writeFile(scratchFile, 'temporary render')
  await setArtifactPlan(state, {
    candidates: [{ path: finalPath, support: [] }],
    intermediates: [scratchFile],
  })

  const report = await finalizeArtifact(state)

  assert.ok(report.deleted.includes(scratchFile))
  await assert.rejects(access(scratchFile))
  assert.equal(await readFile(finalPath, 'utf8'), 'final.pptx')
})
