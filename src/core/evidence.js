import path from 'node:path'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'

import { WorkspaceSentinelError } from './errors.js'
import {
  assertNoLinkComponents,
  assertNoMountComponents,
  containsPath,
  relativeInside,
  resolveInside,
} from './paths.js'

export async function fingerprintFile(target) {
  const stat = await lstat(target)
  if (!stat.isFile()) {
    throw new WorkspaceSentinelError('FILE_NOT_REGULAR', `Not a regular file: ${target}`, { target })
  }
  const bytes = await readFile(target)
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

export async function snapshotTree(root) {
  const absoluteRoot = path.resolve(root)
  const rootDevice = (await lstat(absoluteRoot)).dev
  const snapshot = {}

  async function walk(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const key = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        const childStat = await lstat(absolute)
        if (childStat.dev !== rootDevice) continue
        await walk(absolute, key)
      } else if (entry.isFile()) {
        snapshot[key] = await fingerprintFile(absolute)
      }
    }
  }

  await walk(absoluteRoot, '')
  return snapshot
}

export function sameFingerprint(left, right) {
  return left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.mode === right.mode &&
    left.sha256 === right.sha256
}

export function diffSnapshots(before, after) {
  const created = []
  const modified = []
  const deleted = []

  for (const key of Object.keys(after)) {
    if (!before[key]) created.push(key)
    else if (!sameFingerprint(before[key], after[key])) modified.push(key)
  }
  for (const key of Object.keys(before)) {
    if (!after[key]) deleted.push(key)
  }

  return {
    created: created.sort(),
    modified: modified.sort(),
    deleted: deleted.sort(),
  }
}

export function classifyPath(state, target) {
  const absoluteTarget = path.resolve(target)
  if (state.scratchDir && containsPath(path, state.scratchDir, absoluteTarget)) {
    return 'plugin-owned'
  }
  if (!containsPath(path, state.root, absoluteTarget)) return 'unknown'

  const key = relativeInside(state.root, absoluteTarget)
  if (state.baseline?.[key]) return 'preexisting'
  const known = state.evidence?.[key]
  if (known?.class === 'preexisting') return 'preexisting'
  if (known?.class === 'agent-created') return 'agent-created'
  return 'unknown'
}

export async function observeCreated(state, target, toolCallId) {
  const absoluteTarget = resolveInside(state.root, target)
  const key = relativeInside(state.root, absoluteTarget)
  const known = state.evidence?.[key]
  if (state.baseline?.[key] || (known && known.class !== 'agent-created')) {
    throw new WorkspaceSentinelError(
      'PREEXISTING_FILE',
      `Cannot mark a preexisting path as newly created: ${absoluteTarget}`,
      { target: absoluteTarget },
    )
  }

  await assertNoLinkComponents(state.root, absoluteTarget)
  await assertNoMountComponents(state.root, absoluteTarget)
  const fingerprint = await fingerprintFile(absoluteTarget)
  const evidence = {
    class: 'agent-created',
    path: absoluteTarget,
    toolCallId,
    fingerprint,
    observedAt: new Date().toISOString(),
  }
  state.evidence[key] = evidence
  return evidence
}
