import path from 'node:path'

import { WorkspaceSentinelError } from './errors.js'
import { diffSnapshots, observeCreated, sameFingerprint, snapshotTree } from './evidence.js'
import { containsPath } from './paths.js'
import { assertSoftwareReady } from './software-plan.js'
import { quarantinePaths, restoreQuarantine } from './quarantine.js'
import { verifyTarget } from './process-verify.js'
import { disposeTaskScratch, updateTask, withRootLock } from './task-store.js'
import { appendAudit } from './audit.js'

function isVerificationDebris(relativePath) {
  const normalized = relativePath.toLowerCase()
  const segments = normalized.split('/')
  return segments.some((segment) => ['.cache', 'cache', 'tmp', 'temp', 'coverage'].includes(segment)) ||
    ['.tmp', '.temp', '.log'].some((suffix) => normalized.endsWith(suffix))
}

function isKept(plan, target) {
  return plan.keep.some((kept) => containsPath(path, kept, target))
}

async function quarantineVerificationDebris(state, plan, batch, beforeSnapshot) {
  const afterSnapshot = await snapshotTree(state.root)
  const { created, deleted } = diffSnapshots(beforeSnapshot, afterSnapshot)
  const toolCallId = `verification:${batch.id}`
  const fingerprints = {}

  for (const relative of created) {
    const target = path.join(state.root, relative)
    if (!isVerificationDebris(relative) || isKept(plan, target)) continue
    const fingerprint = afterSnapshot[relative]
    const matchesBaseline = Object.values(state.baseline ?? {})
      .some((expected) => sameFingerprint(expected, fingerprint))
    const matchesDeleted = deleted
      .some((oldPath) => sameFingerprint(beforeSnapshot[oldPath], fingerprint))
    if (matchesBaseline || matchesDeleted) continue
    try {
      const evidence = await observeCreated(state, target, toolCallId)
      fingerprints[target] = evidence.fingerprint
    } catch (error) {
      if (error?.code !== 'PREEXISTING_FILE') throw error
    }
  }

  const targets = Object.keys(fingerprints)
  if (targets.length === 0) return { batchId: null, quarantined: [] }
  const supplemental = await quarantinePaths(state, {
    quarantine: targets,
    fingerprints,
  }, { supplemental: { toolCallId } })
  return {
    batchId: supplemental.id,
    quarantined: supplemental.entries.filter((entry) => entry.operation === 'moved').map((entry) => entry.source),
  }
}

export async function finalizeSoftware(state) {
  assertSoftwareReady(state)
  return withRootLock(state, async () => {
    assertSoftwareReady(state)
    const plan = state.software.pendingPlan
    let batch
    try {
      batch = await quarantinePaths(state, plan)
      await updateTask(state, (current) => {
        current.software.lastBatchId = batch.id
      })
      const beforeVerification = await snapshotTree(state.root)
      await verifyTarget(plan.verification)
      const supplemental = await quarantineVerificationDebris(state, plan, batch, beforeVerification)

      await disposeTaskScratch(state)
      await updateTask(state, (current) => {
        current.status = 'finalized'
        current.software.postBatchId = supplemental.batchId
      })
      await appendAudit(state, {
        action: 'finalize-software',
        path: state.root,
        reason: 'verification passed',
        result: 'finalized',
      })
      const quarantineSkipped = batch.entries
        .filter((entry) => entry.operation === 'skipped')
        .map((entry) => ({ path: entry.source, reason: entry.reason ?? 'UNKNOWN' }))
      return {
        batchId: batch.id,
        kept: plan.keep,
        quarantined: batch.entries.filter((entry) => entry.operation === 'moved').map((entry) => entry.source),
        quarantineSkipped,
        postVerificationQuarantined: supplemental.quarantined,
        verification: 'passed',
      }
    } catch (error) {
      if (batch) {
        try {
          await restoreQuarantine(state.dataDir, batch.id)
          await updateTask(state, (current) => {
            current.status = 'verification-failed'
          })
        } catch (restoreError) {
          throw new WorkspaceSentinelError('VERIFICATION_ROLLBACK_FAILED', 'Verification and rollback both failed', {
            cause: error.message,
            restoreError: restoreError.message,
            batchId: batch.id,
          })
        }
      }
      throw error
    }
  })
}
