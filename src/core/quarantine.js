import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename as fsRename,
  rm,
  utimes,
  writeFile,
  rename,
} from 'node:fs/promises'

import { WorkspaceSentinelError } from './errors.js'
import { fingerprintFile, snapshotTree } from './evidence.js'
import { containsPath, hasProtectedSegment, relativeInside } from './paths.js'
import { assertNoLinkComponents, assertNoMountComponents } from './paths.js'
import { appendAudit } from './audit.js'
import { assertSoftwareReady } from './software-plan.js'

function assertBatchId(batchId) {
  if (!/^[a-f0-9-]{36}$/.test(batchId)) {
    throw new WorkspaceSentinelError('QUARANTINE_BATCH_INVALID', 'Invalid quarantine batch ID')
  }
}

function batchDirectory(dataDir, batchId) {
  assertBatchId(batchId)
  return path.join(path.resolve(dataDir), 'quarantine', 'batches', batchId)
}

async function exists(target) {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function persistBatch(batch) {
  const temporary = `${batch.journalPath}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(batch, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, batch.journalPath)
}

async function loadBatch(dataDir, batchId) {
  const directory = batchDirectory(dataDir, batchId)
  const batch = JSON.parse(await readFile(path.join(directory, 'batch.json'), 'utf8'))
  batch.dataDir = path.resolve(dataDir)
  return batch
}

async function auditBatch(batch, entry) {
  await appendAudit({ id: batch.taskId, taskDir: batch.taskDir }, entry)
}

async function assertTreeNoLinks(root, target) {
  await assertNoLinkComponents(root, target)
  await assertNoMountComponents(root, target)
  const stat = await lstat(target)
  if (stat.isSymbolicLink()) {
    throw new WorkspaceSentinelError('PATH_LINK_NOT_ALLOWED', `Link encountered: ${target}`)
  }
  if (!stat.isDirectory()) return
  for (const entry of await readdir(target)) {
    await assertTreeNoLinks(root, path.join(target, entry))
  }
}

async function copyTree(source, destination) {
  const stat = await lstat(source)
  if (stat.isSymbolicLink()) {
    throw new WorkspaceSentinelError('PATH_LINK_NOT_ALLOWED', `Cannot copy a link: ${source}`)
  }
  if (stat.isDirectory()) {
    await mkdir(destination, { mode: stat.mode, recursive: true })
    for (const entry of await readdir(source)) {
      await copyTree(path.join(source, entry), path.join(destination, entry))
    }
    await chmod(destination, stat.mode)
    await utimes(destination, stat.atime, stat.mtime)
  } else if (stat.isFile()) {
    await copyFile(source, destination)
    await chmod(destination, stat.mode)
    await utimes(destination, stat.atime, stat.mtime)
  } else {
    throw new WorkspaceSentinelError('FILE_NOT_REGULAR', `Unsupported file type: ${source}`)
  }
}

async function snapshotAny(target) {
  const stat = await lstat(target)
  if (stat.isFile()) return { '': await fingerprintFile(target) }
  return snapshotTree(target)
}

async function verifyCopy(source, destination) {
  const [left, right] = await Promise.all([snapshotAny(source), snapshotAny(destination)])
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (JSON.stringify(leftKeys) !== JSON.stringify(rightKeys)) {
    throw new WorkspaceSentinelError('COPY_VERIFICATION_FAILED', 'Copied file sets differ')
  }
  for (const key of leftKeys) {
    if (left[key].sha256 !== right[key].sha256 || left[key].mode !== right[key].mode) {
      throw new WorkspaceSentinelError('COPY_VERIFICATION_FAILED', `Copy verification failed for ${key}`)
    }
  }
}

async function moveWithFallback(source, destination, renameOperation) {
  await mkdir(path.dirname(destination), { recursive: true })
  try {
    await renameOperation(source, destination)
    return 'rename'
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      await copyTree(source, temporary)
      await verifyCopy(source, temporary)
      await fsRename(temporary, destination)
      await rm(source, { recursive: true, force: false })
      return 'copy'
    } finally {
      if (await exists(temporary)) await rm(temporary, { recursive: true, force: true })
    }
  }
}

function fingerprintsForTarget(plan, target) {
  return Object.fromEntries(Object.entries(plan.fingerprints)
    .filter(([file]) => containsPath(path, target, file)))
}

async function fingerprintsCurrent(fingerprints) {
  for (const [target, expected] of Object.entries(fingerprints)) {
    const current = await fingerprintFile(target)
    if (current.size !== expected.size || current.mtimeMs !== expected.mtimeMs ||
        current.mode !== expected.mode || current.sha256 !== expected.sha256) return false
  }
  return true
}

async function rollbackInternal(batch, renameOperation) {
  for (const entry of [...batch.entries].reverse()) {
    if (!['pending', 'moved'].includes(entry.operation)) continue
    if (!(await exists(entry.quarantinePath))) {
      if (entry.operation === 'pending') entry.operation = 'skipped'
      continue
    }
    if (await exists(entry.source)) {
      batch.status = 'rollback-failed'
      await persistBatch(batch)
      throw new WorkspaceSentinelError('RESTORE_TARGET_EXISTS', `Cannot restore over ${entry.source}`)
    }
    await assertNoLinkComponents(batch.root, entry.source)
    await moveWithFallback(entry.quarantinePath, entry.source, renameOperation)
    entry.operation = 'restored'
    await persistBatch(batch)
  }
  batch.status = 'rolled-back'
  await persistBatch(batch)
  await auditBatch(batch, {
    action: 'rollback-quarantine',
    path: batch.root,
    reason: 'quarantine incomplete',
    result: 'rolled-back',
  })
}

export async function quarantinePaths(state, plan, dependencies = {}) {
  if (dependencies.supplemental) {
    for (const source of plan.quarantine) {
      const evidence = state.evidence[relativeInside(state.root, source)]
      if (!evidence || evidence.toolCallId !== dependencies.supplemental.toolCallId) {
        throw new WorkspaceSentinelError(
          'SUPPLEMENTAL_EVIDENCE_INVALID',
          `Supplemental quarantine lacks verification ownership: ${source}`,
        )
      }
    }
  } else {
    assertSoftwareReady(state)
    if (state.software.pendingPlan.digest !== plan.digest) {
      throw new WorkspaceSentinelError('PLAN_APPROVAL_INVALID', 'Quarantine plan is not the approved plan')
    }
  }
  const renameOperation = dependencies.rename ?? fsRename
  const id = randomUUID()
  const directory = batchDirectory(state.dataDir, id)
  await mkdir(directory, { recursive: true })
  const batch = {
    id,
    taskId: state.id,
    taskDir: state.taskDir,
    dataDir: state.dataDir,
    root: state.root,
    status: 'in-progress',
    createdAt: new Date().toISOString(),
    journalPath: path.join(directory, 'batch.json'),
    entries: [],
  }
  await persistBatch(batch)

  try {
    for (const source of plan.quarantine) {
      const relative = relativeInside(state.root, source)
      const entry = {
        source,
        quarantinePath: path.join(directory, 'files', relative),
        fingerprint: fingerprintsForTarget(plan, source),
        operation: 'pending',
      }
      batch.entries.push(entry)
      await persistBatch(batch)

      await assertTreeNoLinks(state.root, source)
      if (hasProtectedSegment(state.root, source, { vcs: false })) {
        throw new WorkspaceSentinelError('PROTECTED_PATH', `Protected path: ${source}`)
      }
      if (!(await fingerprintsCurrent(entry.fingerprint))) {
        entry.operation = 'skipped'
        entry.reason = 'FILE_CHANGED_AFTER_PLAN'
        await persistBatch(batch)
        await auditBatch(batch, {
          action: 'skip-quarantine',
          path: source,
          reason: entry.reason,
          result: 'kept',
        })
        continue
      }

      entry.method = await moveWithFallback(source, entry.quarantinePath, renameOperation)
      entry.operation = 'moved'
      await persistBatch(batch)
      await auditBatch(batch, {
        action: 'quarantine',
        path: source,
        reason: 'approved software finalization',
        result: entry.method,
      })
    }
    batch.status = 'completed'
    await persistBatch(batch)
    return batch
  } catch (error) {
    batch.status = 'rolling-back'
    await persistBatch(batch)
    try {
      await rollbackInternal(batch, renameOperation)
    } catch (rollbackError) {
      throw new WorkspaceSentinelError('QUARANTINE_INCOMPLETE', 'Quarantine and rollback both failed', {
        batchId: id,
        cause: error.message,
        rollbackError: rollbackError.message,
      })
    }
    throw new WorkspaceSentinelError('QUARANTINE_INCOMPLETE', 'Quarantine failed and was rolled back', {
      batchId: id,
      cause: error.message,
    })
  }
}

export async function rollbackQuarantine(batch) {
  await rollbackInternal(batch, fsRename)
}

export async function restoreQuarantine(dataDir, batchId) {
  const batch = await loadBatch(dataDir, batchId)
  const report = { restored: [], skipped: [] }

  for (const entry of [...batch.entries].reverse()) {
    if (entry.operation !== 'moved') continue
    if (await exists(entry.source)) {
      const reason = 'RESTORE_TARGET_EXISTS'
      entry.operation = 'restore-skipped'
      entry.reason = reason
      report.skipped.push({ path: entry.source, reason })
      await persistBatch(batch)
      await auditBatch(batch, { action: 'restore', path: entry.source, reason, result: 'skipped' })
      continue
    }
    if (!(await exists(entry.quarantinePath))) {
      const reason = 'QUARANTINE_MISSING'
      entry.operation = 'restore-skipped'
      entry.reason = reason
      report.skipped.push({ path: entry.source, reason })
      await persistBatch(batch)
      continue
    }
    await assertNoLinkComponents(batch.root, entry.source)
    await moveWithFallback(entry.quarantinePath, entry.source, fsRename)
    entry.operation = 'restored'
    report.restored.push(entry.source)
    await persistBatch(batch)
    await auditBatch(batch, { action: 'restore', path: entry.source, reason: 'user requested', result: 'restored' })
  }

  batch.status = report.skipped.length > 0 ? 'partially-restored' : 'restored'
  await persistBatch(batch)
  return report
}

export async function purgeQuarantine(dataDir, batchId) {
  const directory = batchDirectory(dataDir, batchId)
  const batch = await loadBatch(dataDir, batchId)
  if (['in-progress', 'rolling-back'].includes(batch.status)) {
    throw new WorkspaceSentinelError('QUARANTINE_BATCH_ACTIVE', 'An active batch cannot be purged')
  }
  await auditBatch(batch, {
    action: 'purge-quarantine',
    path: directory,
    reason: 'independent explicit user command',
    result: 'purged',
  })
  await rm(directory, { recursive: true, force: false })
}
