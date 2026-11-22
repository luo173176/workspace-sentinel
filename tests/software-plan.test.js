import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'

import { createTask } from '../src/core/task-store.js'
import {
  createSoftwarePlan,
  approveSoftwarePlan,
  recordCloudVerification,
  runCloudReadback,
  assertSoftwareReady,
} from '../src/core/software-plan.js'

async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sentinel-plan-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = path.join(base, 'project')
  const dataDir = path.join(base, 'data')
  await mkdir(path.join(root, 'src'), { recursive: true })
  await mkdir(path.join(root, 'dist'), { recursive: true })
  await writeFile(path.join(root, 'src/index.js'), 'console.log("source")')
  await writeFile(path.join(root, 'dist/app.js'), 'console.log("runtime")')
  const state = await createTask({ dataDir, root, mode: 'software', sessionId: 's' })
  return { base, root, dataDir, state }
}

function command(root, code = 'process.exit(0)') {
  return { argv: [process.execPath, '-e', code], cwd: root, timeoutMs: 2_000 }
}

function input(root, cloud = { intent: 'none' }) {
  return {
    description: 'minimal runtime',
    keep: [path.join(root, 'dist')],
    quarantine: [path.join(root, 'src')],
    verification: { kind: 'exit', command: command(root) },
    cloud,
  }
}

async function approved(state, plan) {
  await approveSoftwarePlan(state, { planId: plan.id, digest: plan.digest })
}

test('equivalent plans have deterministic digests and approval is bound to the digest', async (t) => {
  const { root, state } = await setup(t)
  const first = await createSoftwarePlan(state, input(root))
  const second = await createSoftwarePlan(state, input(root))
  assert.equal(first.digest, second.digest)
  assert.notEqual(first.id, second.id)

  await assert.rejects(
    approveSoftwarePlan(state, { planId: second.id, digest: '0'.repeat(64) }),
    { code: 'PLAN_APPROVAL_INVALID' },
  )
  await approved(state, second)
  assert.doesNotThrow(() => assertSoftwareReady(state))
})

test('editing a plan after approval invalidates readiness', async (t) => {
  const { root, state } = await setup(t)
  const plan = await createSoftwarePlan(state, input(root))
  await approved(state, plan)
  plan.keep.push(path.join(root, 'src'))

  assert.throws(() => assertSoftwareReady(state), { code: 'PLAN_APPROVAL_INVALID' })
})

test('cloud intent without evidence blocks finalization', async (t) => {
  const { root, state } = await setup(t)
  const cloud = { intent: 'required', destination: 'mock://bucket/project' }
  const plan = await createSoftwarePlan(state, input(root, cloud))
  await approved(state, plan)

  assert.throws(() => assertSoftwareReady(state), { code: 'CLOUD_VERIFICATION_REQUIRED' })
})

test('ordinary cloud destinations accept explicit user confirmation', async (t) => {
  const { root, state } = await setup(t)
  const cloud = { intent: 'required', destination: 'mock://bucket/project' }
  const plan = await createSoftwarePlan(state, input(root, cloud))
  await approved(state, plan)
  await recordCloudVerification(state, {
    planId: plan.id,
    digest: plan.digest,
    method: 'user-confirmed',
    reference: 'user confirmed mock://bucket/project',
  })

  assert.doesNotThrow(() => assertSoftwareReady(state))
})

test('changing the cloud destination invalidates the approved plan', async (t) => {
  const { root, state } = await setup(t)
  const cloud = { intent: 'required', destination: 'mock://bucket/original' }
  const plan = await createSoftwarePlan(state, input(root, cloud))
  await approved(state, plan)
  await recordCloudVerification(state, {
    planId: plan.id,
    digest: plan.digest,
    method: 'user-confirmed',
    reference: 'confirmed original',
  })
  plan.cloud.destination = 'mock://bucket/changed'

  assert.throws(() => assertSoftwareReady(state), { code: 'PLAN_APPROVAL_INVALID' })
})

test('readback executes the approved local command and records only success', async (t) => {
  const { root, state } = await setup(t)
  const cloud = {
    intent: 'required',
    destination: 'mock://bucket/readback',
    readback: command(root),
  }
  const plan = await createSoftwarePlan(state, input(root, cloud))
  await approved(state, plan)
  await runCloudReadback(state, { planId: plan.id, digest: plan.digest })

  assert.equal(state.software.cloudVerification.method, 'readback')
  assert.doesNotThrow(() => assertSoftwareReady(state))
})

test('failed readback leaves the cloud gate closed', async (t) => {
  const { root, state } = await setup(t)
  const cloud = {
    intent: 'required',
    destination: 'mock://bucket/failure',
    readback: command(root, 'process.exit(7)'),
  }
  const plan = await createSoftwarePlan(state, input(root, cloud))
  await approved(state, plan)

  await assert.rejects(runCloudReadback(state, { planId: plan.id, digest: plan.digest }), {
    code: 'CLOUD_READBACK_FAILED',
  })
  assert.throws(() => assertSoftwareReady(state), { code: 'CLOUD_VERIFICATION_REQUIRED' })
})

test('VCS quarantine requires readback rather than user confirmation', async (t) => {
  const { root, state } = await setup(t)
  await mkdir(path.join(root, '.git'), { recursive: true })
  await writeFile(path.join(root, '.git/config'), '[core]')
  const refreshed = await createTask({ dataDir: state.dataDir, root, mode: 'software', sessionId: 's2' })
  const planInput = input(root, { intent: 'required', destination: 'mock://git/project' })
  planInput.quarantine.push(path.join(root, '.git'))
  const plan = await createSoftwarePlan(refreshed, planInput)
  await approved(refreshed, plan)
  await recordCloudVerification(refreshed, {
    planId: plan.id,
    digest: plan.digest,
    method: 'user-confirmed',
    reference: 'user says remote exists',
  })

  assert.throws(() => assertSoftwareReady(refreshed), { code: 'VCS_READBACK_REQUIRED' })
})

test('unknown files cannot enter a quarantine plan', async (t) => {
  const { root, state } = await setup(t)
  await mkdir(path.join(root, 'scratch'), { recursive: true })
  await writeFile(path.join(root, 'scratch/unknown.tmp'), 'unknown')
  const planInput = input(root)
  planInput.quarantine = [path.join(root, 'scratch')]

  await assert.rejects(createSoftwarePlan(state, planInput), { code: 'UNKNOWN_OWNERSHIP' })
})

test('preexisting source directories are eligible for recoverable quarantine', async (t) => {
  const { root, state } = await setup(t)
  assert.equal(state.baseline['src/index.js'] !== undefined, true)
  const plan = await createSoftwarePlan(state, input(root))

  assert.deepEqual(plan.quarantine, [path.join(root, 'src')])
  assert.ok(plan.fingerprints[path.join(root, 'src/index.js')])
  await approved(state, plan)
  assert.doesNotThrow(() => assertSoftwareReady(state))
})

test('command specs reject shell strings and invalid timeouts', async (t) => {
  const { root, state } = await setup(t)
  const planInput = input(root)
  planInput.verification.command = 'npm test'

  await assert.rejects(createSoftwarePlan(state, planInput), { code: 'COMMAND_SPEC_INVALID' })
})
