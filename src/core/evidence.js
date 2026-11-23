import path from 'node:path'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'

import { WorkspaceSentinelError } from './errors.js'
import {
  assertNoLinkComponents,
  assertNoMountComponents,
  containsPath,
  relativeInside,
  resolveInside,
} from './paths.js'

// Hash a file in fixed-size chunks so a large file (>= the heap budget) is
// never read into a single Buffer. The digest is byte-identical to hashing the
// whole file at once, so ownership comparisons are unchanged.
export async function fingerprintFile(target) {
  const stat = await lstat(target)
  if (!stat.isFile()) {
    throw new WorkspaceSentinelError('FILE_NOT_REGULAR', `Not a regular file: ${target}`, { target })
  }
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(target)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode,
    sha256: hash.digest('hex'),
  }
}

const DEFAULT_IGNORE = ['.git', 'node_modules']

export async function snapshotTree(root, options = {}) {
  const absoluteRoot = path.resolve(root)
  const rootDevice = (await lstat(absoluteRoot)).dev
  const ignore = new Set(options.ignore ?? DEFAULT_IGNORE)
  const ignoredDirs = options.ignoredDirs
  const snapshot = {}

  async function walk(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const key = prefix ? `${prefix}/${entry.name}` : entry.name
      if (ignore.has(entry.name)) {
        // Record that the ignored directory existed at snapshot time so its
        // contents still classify as preexisting (ownership is not changed by
        // the ignore optimization) without hashing their files.
        if (ignoredDirs && entry.isDirectory()) ignoredDirs.push(key)
        continue
      }
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
  if (Array.isArray(state.baselineIgnoreRoots) &&
      state.baselineIgnoreRoots.some((dir) => key === dir || key.startsWith(`${dir}/`))) {
    return 'preexisting'
  }
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
