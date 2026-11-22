import path from 'node:path'
import { unlink } from 'node:fs/promises'

import { WorkspaceSentinelError } from './errors.js'
import { fingerprintFile, classifyPath } from './evidence.js'
import { assertNoLinkComponents, assertNoMountComponents, containsPath, hasProtectedSegment, resolveInside } from './paths.js'
import {
  assertFingerprintCurrent,
  disposeTaskScratch,
  updateTask,
  withRootLock,
} from './task-store.js'
import { appendAudit } from './audit.js'

function assertArtifactMode(state) {
  if (state.mode !== 'artifact') {
    throw new WorkspaceSentinelError('TASK_MODE_INVALID', 'Artifact finalization requires artifact mode')
  }
}

function workspacePath(state, target) {
  return resolveInside(state.root, target)
}

function intermediatePath(state, target) {
  if (containsPath(path, state.scratchDir, path.resolve(target))) {
    return resolveInside(state.scratchDir, target)
  }
  return workspacePath(state, target)
}

async function checkLinks(state, target) {
  const root = containsPath(path, state.scratchDir, target) ? state.scratchDir : state.root
  await assertNoLinkComponents(root, target)
  await assertNoMountComponents(root, target)
}

function sameFingerprint(left, right) {
  return left && right &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.mode === right.mode &&
    left.sha256 === right.sha256
}

export async function setArtifactPlan(state, { candidates, intermediates }) {
  assertArtifactMode(state)
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new WorkspaceSentinelError('ARTIFACT_CANDIDATES_REQUIRED', 'At least one final candidate is required')
  }

  const normalizedCandidates = []
  const fingerprints = {}
  const seen = new Set()

  async function register(target) {
    if (seen.has(target)) return
    seen.add(target)
    await checkLinks(state, target)
    fingerprints[target] = await fingerprintFile(target)
  }

  for (const candidate of candidates) {
    const candidatePath = workspacePath(state, candidate.path)
    const support = (candidate.support ?? []).map((item) => workspacePath(state, item))
    await register(candidatePath)
    for (const item of support) await register(item)
    normalizedCandidates.push({ path: candidatePath, support })
  }

  const normalizedIntermediates = []
  for (const item of intermediates ?? []) {
    const target = intermediatePath(state, item)
    await register(target)
    normalizedIntermediates.push(target)
  }

  await updateTask(state, (current) => {
    current.artifact = {
      candidates: normalizedCandidates,
      intermediates: [...new Set(normalizedIntermediates)],
      finalPath: normalizedCandidates.length === 1 ? normalizedCandidates[0].path : null,
      selectedBy: normalizedCandidates.length === 1 ? 'agent' : null,
      fingerprints,
    }
    current.status = normalizedCandidates.length === 1 ? 'ready-to-finalize' : 'waiting-for-user-selection'
  })
  return state
}

export async function selectArtifactFinal(state, { finalPath, selectedBy }) {
  assertArtifactMode(state)
  if (!state.artifact) {
    throw new WorkspaceSentinelError('ARTIFACT_CANDIDATES_REQUIRED', 'Register candidates before selection')
  }
  const candidates = state.artifact.candidates
  if (candidates.length > 1 && selectedBy !== 'user') {
    throw new WorkspaceSentinelError('ARTIFACT_SELECTION_REQUIRED', 'The user must choose between final candidates')
  }
  const selected = workspacePath(state, finalPath)
  if (!candidates.some((candidate) => candidate.path === selected)) {
    throw new WorkspaceSentinelError('ARTIFACT_FINAL_NOT_REGISTERED', 'Selected path is not a registered candidate')
  }

  await updateTask(state, (current) => {
    current.artifact.finalPath = selected
    current.artifact.selectedBy = selectedBy
    const unselected = candidates
      .map((candidate) => candidate.path)
      .filter((candidate) => candidate !== selected)
    current.artifact.intermediates = [...new Set([...current.artifact.intermediates, ...unselected])]
    current.status = 'ready-to-finalize'
  })
  return state
}

async function skip(report, state, target, reason) {
  report.skipped.push({ path: target, reason })
  await appendAudit(state, {
    action: 'skip-permanent-delete',
    path: target,
    reason,
    evidenceClass: classifyPath(state, target),
    result: 'kept',
  })
}

export async function finalizeArtifact(state) {
  assertArtifactMode(state)
  if (!state.artifact?.finalPath) {
    throw new WorkspaceSentinelError('ARTIFACT_SELECTION_REQUIRED', 'A final artifact must be selected first')
  }

  return withRootLock(state, async () => {
    const { artifact } = state
    const selected = artifact.candidates.find((candidate) => candidate.path === artifact.finalPath)
    if (!selected) {
      throw new WorkspaceSentinelError('ARTIFACT_FINAL_NOT_REGISTERED', 'Final selection is not registered')
    }
    const protectedFinals = new Set([selected.path, ...selected.support])
    const report = { deleted: [], kept: [], skipped: [] }

    for (const target of protectedFinals) {
      report.kept.push(target)
      await appendAudit(state, {
        action: 'keep-final',
        path: target,
        reason: 'selected final or required support',
        result: 'kept',
      })
    }

    for (const target of [...new Set(artifact.intermediates)].sort()) {
      if (protectedFinals.has(target)) continue
      const evidenceClass = classifyPath(state, target)
      if (evidenceClass === 'preexisting') {
        await skip(report, state, target, 'PREEXISTING_FILE')
        continue
      }
      if (evidenceClass === 'unknown') {
        await skip(report, state, target, 'UNKNOWN_OWNERSHIP')
        continue
      }
      const inScratch = evidenceClass === 'plugin-owned'
      if (!inScratch && hasProtectedSegment(state.root, target)) {
        await skip(report, state, target, 'PROTECTED_PATH')
        continue
      }

      try {
        await checkLinks(state, target)
        if (!inScratch) await assertFingerprintCurrent(state, target)
        const expected = artifact.fingerprints[target]
        const current = await fingerprintFile(target)
        if (!sameFingerprint(expected, current)) {
          await skip(report, state, target, 'FILE_CHANGED_AFTER_PLAN')
          continue
        }
        await unlink(target)
        report.deleted.push(target)
        await appendAudit(state, {
          action: 'permanent-delete',
          path: target,
          reason: 'current-task intermediate',
          evidenceClass,
          result: 'deleted',
        })
      } catch (error) {
        if (error?.code === 'PATH_LINK_NOT_ALLOWED') {
          await skip(report, state, target, 'LINK_NOT_ALLOWED')
        } else if (error?.code === 'FILE_CHANGED_AFTER_PLAN') {
          await skip(report, state, target, 'FILE_CHANGED_AFTER_PLAN')
        } else if (error?.code === 'ENOENT') {
          await skip(report, state, target, 'FILE_MISSING')
        } else {
          throw error
        }
      }
    }

    await disposeTaskScratch(state)
    await appendAudit(state, {
      action: 'delete-scratch',
      path: state.scratchDir,
      reason: 'plugin-owned task scratch',
      evidenceClass: 'plugin-owned',
      result: 'deleted',
    })
    await updateTask(state, (current) => {
      current.status = 'finalized'
    })
    return report
  })
}
