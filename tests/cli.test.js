import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'

import { loadTask, updateTask } from '../src/core/task-store.js'
import { observeCreated } from '../src/core/evidence.js'

const CLI = path.resolve('src/cli.js')

async function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: process.cwd() })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (status) => resolve({ status, stdout, stderr }))
  })
  }

async function ok(args) {
  const result = await runCli(args)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.stderr, '')
  const body = JSON.parse(result.stdout)
  assert.equal(body.ok, true)
  return body
  }

async function fail(args, code) {
  const result = await runCli(args)
  assert.notEqual(result.status, 0)
  assert.equal(result.stderr, '')
  const body = JSON.parse(result.stdout)
  assert.equal(body.ok, false)
  assert.equal(body.error.code, code)
  return body
  }

async function workspace(t, precreate = false) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sentinel-cli-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = path.join(base, 'project')
  const dataDir = path.join(base, 'data')
  await mkdir(root)
  if (precreate) {
    await mkdir(path.join(root, 'src'))
    await mkdir(path.join(root, 'dist'))
    await writeFile(path.join(root, 'src/index.js'), 'source')
    await writeFile(path.join(root, 'dist/app.js'), 'process.exit(0)')
  }
  return { base, root, dataDir }
  }

async function started(mode, root, dataDir) {
  const body = await ok(['start', '--data-dir', dataDir, '--root', root, '--mode', mode, '--session', 'cli-test'])
  return loadTask(dataDir, body.taskId)
  }

function writeJson(t, name, value) {
  const target = path.join(t.__workdir, name)
  return writeFile(target, JSON.stringify(value, null, 2)).then(() => target)
  }

async function artifactTask(t) {
  const made = await workspace(t)
  t.__workdir = made.base
  const state = await started('artifact', made.root, made.dataDir)
  const finalPath = path.join(made.root, 'final.pptx')
  const draft = path.join(made.root, 'draft.tmp')
  await writeFile(finalPath, 'final')
  await writeFile(draft, 'draft')
  await observeCreated(state, finalPath, 'tool-final')
  await observeCreated(state, draft, 'tool-draft')
  await updateTask(state, () => {})
  return { ...made, state, finalPath, draft }
  }

test('artifact commands select a single final and permanently delete planned intermediates', async (t) => {
  const { base, state, finalPath, draft } = await artifactTask(t)
  const plan = await writeJson(t, 'artifact.json', {
    candidates: [{ path: finalPath, support: [] }],
    intermediates: [draft],
  })

  await ok(['artifact-plan', '--data-dir', state.dataDir, '--task', state.id, '--file', plan])
  const finalized = await ok(['finalize', '--data-dir', state.dataDir, '--task', state.id])

  assert.deepEqual(finalized.result.deleted, [draft])
  assert.equal(await readFile(finalPath, 'utf8'), 'final')
  await assert.rejects(access(draft))
  assert.equal(base.startsWith('/tmp'), true)
  })

test('multiple candidates require the user selection flag before finalization', async (t) => {
  const { base, root, dataDir } = await workspace(t)
  t.__workdir = base
  const state = await started('artifact', root, dataDir)
  const first = path.join(root, 'a.pptx')
  const second = path.join(root, 'b.pptx')
  await writeFile(first, 'a')
  await writeFile(second, 'b')
  await observeCreated(state, first, 'tool-a')
  await observeCreated(state, second, 'tool-b')
  await updateTask(state, () => {})
  const plan = await writeJson(t, 'multi.json', {
    candidates: [{ path: first, support: [] }, { path: second, support: [] }],
    intermediates: [],
  })
  await ok(['artifact-plan', '--data-dir', dataDir, '--task', state.id, '--file', plan])

  await fail(['finalize', '--data-dir', dataDir, '--task', state.id], 'ARTIFACT_SELECTION_REQUIRED')
  await fail(['select-final', '--data-dir', dataDir, '--task', state.id, '--path', first, '--by', 'agent'], 'ARTIFACT_SELECTION_REQUIRED')
  await ok(['select-final', '--data-dir', dataDir, '--task', state.id, '--path', first, '--by', 'user'])
  const finalized = await ok(['finalize', '--data-dir', dataDir, '--task', state.id])
  assert.deepEqual(finalized.result.deleted, [second])
  assert.equal(await readFile(first, 'utf8'), 'a')
  })

test('software commands enforce plan approval and support restore and purge', async (t) => {
  const { base, root, dataDir } = await workspace(t, true)
  t.__workdir = base
  const state = await started('software', root, dataDir)
  const template = JSON.parse(await readFile(path.resolve('tests/fixtures/software-plan.json'), 'utf8'))
  const planFile = await writeJson(t, 'software.json', JSON.parse(
    JSON.stringify(template).replaceAll('$ROOT', root).replaceAll('$NODE', process.execPath),
  ))

  const planned = await ok(['software-plan', '--data-dir', dataDir, '--task', state.id, '--file', planFile])
  await fail([
    'approve-plan', '--data-dir', dataDir, '--task', state.id,
    '--plan', planned.plan.id, '--digest', '0'.repeat(64),
  ], 'PLAN_APPROVAL_INVALID')
  await ok([
    'approve-plan', '--data-dir', dataDir, '--task', state.id,
    '--plan', planned.plan.id, '--digest', planned.plan.digest,
  ])
  const finalized = await ok(['finalize', '--data-dir', dataDir, '--task', state.id])
  assert.equal(finalized.result.verification, 'passed')
  await assert.rejects(access(path.join(root, 'src/index.js')))

  await ok(['restore', '--data-dir', dataDir, '--batch', finalized.result.batchId])
  assert.equal(await readFile(path.join(root, 'src/index.js'), 'utf8'), 'source')
  await ok(['purge', '--data-dir', dataDir, '--batch', finalized.result.batchId])
  await assert.rejects(access(path.join(dataDir, 'quarantine/batches', finalized.result.batchId)))
  })

test('cloud intent blocks finalization until user verification is recorded', async (t) => {
  const { base, root, dataDir } = await workspace(t, true)
  t.__workdir = base
  const state = await started('software', root, dataDir)
  const input = {
    description: 'cloud gated',
    keep: [path.join(root, 'dist')],
    quarantine: [path.join(root, 'src')],
    verification: {
      kind: 'exit',
      command: { argv: [process.execPath, path.join(root, 'dist/app.js')], cwd: root, timeoutMs: 1_000 },
    },
    cloud: { intent: 'required', destination: 'mock://bucket/cli' },
  }
  const planFile = await writeJson(t, 'cloud.json', input)
  const planned = await ok(['software-plan', '--data-dir', dataDir, '--task', state.id, '--file', planFile])
  await ok(['approve-plan', '--data-dir', dataDir, '--task', state.id, '--plan', planned.plan.id, '--digest', planned.plan.digest])

  await fail(['finalize', '--data-dir', dataDir, '--task', state.id], 'CLOUD_VERIFICATION_REQUIRED')
  await ok([
    'cloud-verified', '--data-dir', dataDir, '--task', state.id, '--plan', planned.plan.id,
    '--digest', planned.plan.digest, '--reference', 'user confirmed mock://bucket/cli',
  ])
  const finalized = await ok(['finalize', '--data-dir', dataDir, '--task', state.id])
  assert.equal(finalized.result.verification, 'passed')
  })

test('cloud readback command records machine verification', async (t) => {
  const { base, root, dataDir } = await workspace(t, true)
  t.__workdir = base
  const state = await started('software', root, dataDir)
  const planFile = await writeJson(t, 'readback.json', {
    description: 'readback',
    keep: [path.join(root, 'dist')],
    quarantine: [path.join(root, 'src')],
    verification: {
      kind: 'exit',
      command: { argv: [process.execPath, path.join(root, 'dist/app.js')], cwd: root, timeoutMs: 1_000 },
    },
    cloud: {
      intent: 'required',
      destination: 'mock://bucket/readback',
      readback: { argv: [process.execPath, '-e', 'process.exit(0)'], cwd: root, timeoutMs: 1_000 },
    },
  })
  const planned = await ok(['software-plan', '--data-dir', dataDir, '--task', state.id, '--file', planFile])
  await ok(['approve-plan', '--data-dir', dataDir, '--task', state.id, '--plan', planned.plan.id, '--digest', planned.plan.digest])
  await ok(['cloud-readback', '--data-dir', dataDir, '--task', state.id, '--plan', planned.plan.id, '--digest', planned.plan.digest])

  const finalized = await ok(['finalize', '--data-dir', dataDir, '--task', state.id])
  assert.equal(finalized.result.verification, 'passed')
  })

test('invalid JSON produces one JSON error object and no stderr', async (t) => {
  const { state, base } = await artifactTask(t)
  const bad = path.join(base, 'bad.json')
  await writeFile(bad, '{not-json')

  const body = await fail(['artifact-plan', '--data-dir', state.dataDir, '--task', state.id, '--file', bad], 'JSON_INVALID')
  assert.equal(typeof body.error.message, 'string')
  })

test('set-mode and status expose the current task summary', async (t) => {
  const { root, dataDir } = await workspace(t)
  const state = await started('audit', root, dataDir)
  await ok(['set-mode', '--data-dir', dataDir, '--task', state.id, '--mode', 'artifact'])
  const status = await ok(['status', '--data-dir', dataDir, '--task', state.id])

  assert.equal(status.task.mode, 'artifact')
  assert.equal(status.task.id, state.id)
  })

test('start does not require a host session id', async (t) => {
  const { root, dataDir } = await workspace(t)
  const startedBody = await ok(['start', '--data-dir', dataDir, '--root', root, '--mode', 'artifact'])

  const state = await loadTask(dataDir, startedBody.taskId)
  assert.equal(state.sessionId, undefined)
})
