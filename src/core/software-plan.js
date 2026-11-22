import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, readdir } from 'node:fs/promises'

import { WorkspaceSentinelError } from './errors.js'
import { minimalEnvironment, terminateChild } from './child-process.js'
import { classifyPath, fingerprintFile } from './evidence.js'
import {
  assertNoLinkComponents,
  assertNoMountComponents,
  containsPath,
  hasProtectedSegment,
  relativeInside,
  resolveInside,
} from './paths.js'
import { updateTask } from './task-store.js'

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

function digestPlan(plan) {
  const { id, createdAt, digest, ...content } = plan
  return createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex')
}

function assertSoftwareMode(state) {
  if (state.mode !== 'software') {
    throw new WorkspaceSentinelError('TASK_MODE_INVALID', 'Software planning requires software mode')
  }
}

function normalizeCommand(state, spec) {
  if (!spec || !Array.isArray(spec.argv) || spec.argv.length === 0 ||
      spec.argv.some((part) => typeof part !== 'string' || part.length === 0) ||
      !Number.isInteger(spec.timeoutMs) || spec.timeoutMs <= 0) {
    throw new WorkspaceSentinelError('COMMAND_SPEC_INVALID', 'Commands require argv and a positive timeout')
  }
  return {
    argv: [...spec.argv],
    cwd: resolveInside(state.root, spec.cwd ?? state.root),
    timeoutMs: spec.timeoutMs,
  }
}

function normalizeVerification(state, verification) {
  if (verification?.kind === 'exit') {
    return { kind: 'exit', command: normalizeCommand(state, verification.command) }
  }
  if (verification?.kind === 'long-running') {
    return {
      kind: 'long-running',
      start: normalizeCommand(state, verification.start),
      ready: normalizeCommand(state, verification.ready),
    }
  }
  throw new WorkspaceSentinelError('COMMAND_SPEC_INVALID', 'Unsupported verification specification')
}

function normalizeCloud(state, cloud) {
  if (cloud?.intent === 'none') return { intent: 'none' }
  if (cloud?.intent !== 'required' || typeof cloud.destination !== 'string' || !cloud.destination) {
    throw new WorkspaceSentinelError('CLOUD_DESTINATION_REQUIRED', 'Cloud intent requires a destination')
  }
  return {
    intent: 'required',
    destination: cloud.destination,
    ...(cloud.readback ? { readback: normalizeCommand(state, cloud.readback) } : {}),
  }
}

function hasVcsSegment(state, target) {
  return relativeInside(state.root, target)
    .split('/')
    .some((segment) => ['.git', '.svn', '.hg'].includes(segment.toLowerCase()))
}

async function collectQuarantineFiles(state, target, files) {
  await assertNoLinkComponents(state.root, target)
  await assertNoMountComponents(state.root, target)
  if (hasProtectedSegment(state.root, target, { vcs: false })) {
    throw new WorkspaceSentinelError('PROTECTED_PATH', `Protected path cannot be quarantined: ${target}`)
  }

  const stat = await lstat(target)
  if (stat.isSymbolicLink()) {
    throw new WorkspaceSentinelError('PATH_LINK_NOT_ALLOWED', `Links cannot be quarantined: ${target}`)
  }
  if (stat.isDirectory()) {
    const entries = await readdir(target)
    for (const entry of entries.sort()) {
      await collectQuarantineFiles(state, path.join(target, entry), files)
    }
    return
  }
  if (!stat.isFile()) {
    throw new WorkspaceSentinelError('FILE_NOT_REGULAR', `Unsupported quarantine entry: ${target}`)
  }
  const evidenceClass = classifyPath(state, target)
  if (evidenceClass === 'unknown') {
    throw new WorkspaceSentinelError('UNKNOWN_OWNERSHIP', `Unknown file cannot be quarantined: ${target}`)
  }
  files[target] = await fingerprintFile(target)
}

function assertNoOverlap(keep, quarantine) {
  for (const kept of keep) {
    for (const removed of quarantine) {
      if (containsPath(path, kept, removed) || containsPath(path, removed, kept)) {
        throw new WorkspaceSentinelError('PLAN_PATH_OVERLAP', 'Keep and quarantine paths must not overlap')
      }
    }
  }
}

export async function createSoftwarePlan(state, input) {
  assertSoftwareMode(state)
  const keep = [...new Set((input.keep ?? []).map((target) => resolveInside(state.root, target)))].sort()
  const quarantine = [...new Set((input.quarantine ?? []).map((target) => resolveInside(state.root, target)))].sort()
  if (keep.length === 0) {
    throw new WorkspaceSentinelError('KEEP_SET_REQUIRED', 'At least one runtime keep path is required')
  }
  if (quarantine.some((target) => path.resolve(target) === path.resolve(state.root))) {
    throw new WorkspaceSentinelError('PATH_ROOT_DELETE', 'The task root itself cannot be quarantined')
  }
  assertNoOverlap(keep, quarantine)

  for (const target of keep) {
    await assertNoLinkComponents(state.root, target)
    await lstat(target)
  }

  const fingerprints = {}
  for (const target of quarantine) await collectQuarantineFiles(state, target, fingerprints)
  if (quarantine.length > 0 && Object.keys(fingerprints).length === 0) {
    throw new WorkspaceSentinelError('UNKNOWN_OWNERSHIP', 'Empty directories have no safe quarantine evidence')
  }

  const plan = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    root: state.realRoot,
    description: String(input.description ?? ''),
    keep,
    quarantine,
    verification: normalizeVerification(state, input.verification),
    cloud: normalizeCloud(state, input.cloud),
    includesVcs: quarantine.some((target) => hasVcsSegment(state, target)),
    fingerprints,
  }
  plan.digest = digestPlan(plan)
  await updateTask(state, (current) => {
    current.software = {
      pendingPlan: plan,
      approvedPlanId: null,
      approvedDigest: null,
      approvedAt: null,
      cloudVerification: null,
    }
    current.status = 'waiting-for-plan-approval'
  })
  return plan
}

function assertApproved(state) {
  const software = state.software
  const plan = software?.pendingPlan
  if (!plan || software.approvedPlanId !== plan.id ||
      software.approvedDigest !== plan.digest || digestPlan(plan) !== plan.digest) {
    throw new WorkspaceSentinelError('PLAN_APPROVAL_INVALID', 'The current software plan is not approved')
  }
  return plan
}

export async function approveSoftwarePlan(state, { planId, digest }) {
  assertSoftwareMode(state)
  const plan = state.software?.pendingPlan
  if (!plan || plan.id !== planId || plan.digest !== digest || digestPlan(plan) !== digest) {
    throw new WorkspaceSentinelError('PLAN_APPROVAL_INVALID', 'Approval does not match the current plan')
  }
  await updateTask(state, (current) => {
    current.software.approvedPlanId = planId
    current.software.approvedDigest = digest
    current.software.approvedAt = new Date().toISOString()
    current.software.cloudVerification = null
    current.status = 'plan-approved'
  })
  return state
}

export async function recordCloudVerification(state, evidence) {
  const plan = assertApproved(state)
  if (plan.cloud.intent !== 'required') {
    throw new WorkspaceSentinelError('CLOUD_VERIFICATION_NOT_REQUIRED', 'This plan has no cloud destination')
  }
  if (evidence.planId !== plan.id || evidence.digest !== plan.digest || evidence.method !== 'user-confirmed') {
    throw new WorkspaceSentinelError('CLOUD_VERIFICATION_INVALID', 'User confirmation must match the approved plan')
  }
  await updateTask(state, (current) => {
    current.software.cloudVerification = {
      method: 'user-confirmed',
      reference: String(evidence.reference ?? ''),
      destination: plan.cloud.destination,
      digest: plan.digest,
      verifiedAt: new Date().toISOString(),
    }
  })
  return state
}

async function executeReadback(command) {
  await new Promise((resolve, reject) => {
    const child = spawn(command.argv[0], command.argv.slice(1), {
      cwd: command.cwd,
      env: minimalEnvironment(),
      shell: false,
      stdio: 'ignore',
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      terminateChild(child).catch(() => {})
    }, command.timeoutMs)

    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new WorkspaceSentinelError('CLOUD_READBACK_FAILED', 'Cloud readback could not start', {
        cause: error.message,
      }))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new WorkspaceSentinelError('CLOUD_READBACK_TIMEOUT', 'Cloud readback timed out'))
      } else if (code !== 0) {
        reject(new WorkspaceSentinelError('CLOUD_READBACK_FAILED', `Cloud readback exited with ${code}`))
      } else {
        resolve()
      }
    })
  })
}

export async function runCloudReadback(state, { planId, digest }) {
  const plan = assertApproved(state)
  if (plan.id !== planId || plan.digest !== digest || !plan.cloud.readback) {
    throw new WorkspaceSentinelError('CLOUD_VERIFICATION_INVALID', 'No matching approved readback command')
  }
  await executeReadback(plan.cloud.readback)
  await updateTask(state, (current) => {
    current.software.cloudVerification = {
      method: 'readback',
      reference: plan.cloud.destination,
      destination: plan.cloud.destination,
      digest: plan.digest,
      verifiedAt: new Date().toISOString(),
    }
  })
  return state
}

export function assertSoftwareReady(state) {
  const plan = assertApproved(state)
  if (plan.cloud.intent === 'required') {
    const verification = state.software.cloudVerification
    if (!verification || verification.digest !== plan.digest ||
        verification.destination !== plan.cloud.destination) {
      throw new WorkspaceSentinelError('CLOUD_VERIFICATION_REQUIRED', 'Cloud saving has not been verified')
    }
    if (plan.includesVcs && verification.method !== 'readback') {
      throw new WorkspaceSentinelError('VCS_READBACK_REQUIRED', 'VCS quarantine requires remote readback')
    }
  }
}
