import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'

import { apply } from '../index.js'
import {
  createTask,
  loadTask,
  updateTask,
} from '../src/core/task-store.js'
import { observeCreated } from '../src/core/evidence.js'
import { setArtifactPlan } from '../src/core/artifact.js'
import { createSoftwarePlan, approveSoftwarePlan } from '../src/core/software-plan.js'

function fakeContext(dataDir) {
  const handlers = new Map()
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
  }
  apply(ctx, dataDir ? { dataDir } : {})
  return { ctx, handlers }
  }

async function workspace(t, mode = 'artifact', prepare = null) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sentinel-dsh-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = path.join(base, 'project')
  const dataDir = path.join(base, 'data')
  await mkdir(root)
  if (prepare) await prepare(root)
  const state = await createTask({ dataDir, root, mode, sessionId: 'dsh-session' })
  return { base, root, dataDir, state }
  }

function toolExec(root, name, args, callId = 'call-1') {
  return {
    name,
    arguments: args,
    callId,
    signal: new AbortController().signal,
    agent: { session: { id: 'dsh-session', header: { cwd: root } } },
  }
  }

const allowNext = async () => ({ kind: 'allow' })

function softwareFinalizeCommand(root) {
  return `node "${path.resolve('src/cli.js')}" finalize --root "${root}"`
  }

test('apply registers only documented generic tool and session events', () => {
  const { handlers } = fakeContext()
  assert.deepEqual([...handlers.keys()].sort(), [
    'session/disposed',
    'session/event',
    'tools/pre-execute',
    'tools/result',
  ])
  assert.deepEqual([...handlers.keys()].filter((event) => event.startsWith('fs/')), [])
  })

test('DSH pre-execute denies direct writes into scratch zones and otherwise delegates', async (t) => {
  const { root, dataDir } = await workspace(t)
  const { handlers } = fakeContext(dataDir)
  const preExecute = handlers.get('tools/pre-execute')

  const denied = await preExecute(toolExec(root, 'write_file', {
    path: path.join(root, 'tmp', 'draft.txt'),
  }), allowNext)
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /scratch/i)

  const allowed = await preExecute(toolExec(root, 'read_file', {
    path: path.join(root, 'README.md'),
  }), allowNext)
  assert.deepEqual(allowed, { kind: 'allow' })
  })

test('software finalize asks for approval only when a plan digest is recorded', async (t) => {
  const { root, dataDir, state } = await workspace(t, 'software', async (target) => {
    await mkdir(path.join(target, 'src'))
    await mkdir(path.join(target, 'dist'))
    await writeFile(path.join(target, 'src', 'index.js'), 'source')
    await writeFile(path.join(target, 'dist', 'app.js'), 'process.exit(0)')
  })

  const reloaded = await loadTask(dataDir, state.id)
  const plan = await createSoftwarePlan(reloaded, {
    description: 'dsh ask',
    keep: [path.join(root, 'dist')],
    quarantine: [path.join(root, 'src')],
    verification: {
      kind: 'exit',
      command: { argv: [process.execPath, path.join(root, 'dist/app.js')], cwd: root, timeoutMs: 1_000 },
    },
    cloud: { intent: 'none' },
  })
  await approveSoftwarePlan(reloaded, { planId: plan.id, digest: plan.digest })

  const { handlers } = fakeContext(dataDir)
  const preExecute = handlers.get('tools/pre-execute')
  const questioned = await preExecute(toolExec(root, 'bash', {
    command: softwareFinalizeCommand(root),
  }), allowNext)
  assert.equal(questioned.kind, 'ask')
  assert.match(questioned.reason, /approved|confirm/i)

  const other = await workspace(t, 'software')
  const { handlers: otherHandlers } = fakeContext(other.dataDir)
  const denied = await otherHandlers.get('tools/pre-execute')(toolExec(other.root, 'bash', {
    command: softwareFinalizeCommand(other.root),
  }), allowNext)
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /approved plan/i)
  })

test('tools/result records evidence for successful direct writes', async (t) => {
  const { root, state, dataDir } = await workspace(t)
  const target = path.join(root, 'output.txt')
  await writeFile(target, 'created')
  const { handlers } = fakeContext(dataDir)

  await handlers.get('tools/result')(toolExec(root, 'write_file', { path: target }, 'call-write'), {
    isError: false,
    content: [],
  })

  const evidence = (await loadTask(state.dataDir, state.id)).evidence
  assert.deepEqual(Object.keys(evidence), ['output.txt'])
  })

test('completed turn finalizes a single selected artifact and deletes its intermediate', async (t) => {
  const { root, state, dataDir } = await workspace(t)
  const final = path.join(root, 'final.pptx')
  const draft = path.join(root, 'draft.tmp')
  await writeFile(final, 'final')
  await writeFile(draft, 'draft')
  await observeCreated(state, final, 'tool-final')
  await observeCreated(state, draft, 'tool-draft')
  await updateTask(state, () => {})
  await setArtifactPlan(state, { candidates: [{ path: final, support: [] }], intermediates: [draft] })

  const { handlers } = fakeContext(dataDir)
  await handlers.get('session/event')(
    { id: 'dsh-session', header: { cwd: root } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  )

  const reloaded = await loadTask(state.dataDir, state.id)
  assert.equal(reloaded.status, 'finalized')
  assert.equal(await readFile(final, 'utf8'), 'final')
  await assert.rejects(readFile(draft))
  })

test('session/disposed removes only the task-owned scratch directory', async (t) => {
  const { root, state, dataDir } = await workspace(t)
  const scratchFile = path.join(state.scratchDir, 'preview.tmp')
  await writeFile(scratchFile, 'scratch')
  const unrelated = path.join(state.dataDir, 'keep.txt')
  await writeFile(unrelated, 'keep')

  const { handlers } = fakeContext(dataDir)
  await handlers.get('session/disposed')({ id: 'dsh-session', header: { cwd: root } })

  await assert.rejects(readFile(scratchFile))
  assert.equal(await readFile(unrelated, 'utf8'), 'keep')
  })

test('artifact finalize passes the DSH software approval gate', async (t) => {
  const { root, state, dataDir } = await workspace(t)
  const final = path.join(root, 'final.pptx')
  await writeFile(final, 'final')
  await observeCreated(state, final, 'tool-final')
  await updateTask(state, () => {})
  await setArtifactPlan(state, { candidates: [{ path: final, support: [] }], intermediates: [] })

  const { handlers } = fakeContext(dataDir)
  const decision = await handlers.get('tools/pre-execute')(toolExec(root, 'bash', {
    command: softwareFinalizeCommand(root),
  }), allowNext)

  assert.deepEqual(decision, { kind: 'allow' })
})
