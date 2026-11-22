import path from 'node:path'
import { lstat, readdir } from 'node:fs/promises'

import { WorkspaceSentinelError } from './errors.js'

export function containsPath(pathImpl, root, target) {
  const relative = pathImpl.relative(pathImpl.resolve(root), pathImpl.resolve(target))
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${pathImpl.sep}`) &&
    !pathImpl.isAbsolute(relative)
  )
}

export function resolveInside(root, candidate) {
  const absoluteRoot = path.resolve(root)
  const absoluteTarget = path.resolve(absoluteRoot, candidate)
  if (!containsPath(path, absoluteRoot, absoluteTarget)) {
    throw new WorkspaceSentinelError(
      'PATH_OUTSIDE_ROOT',
      `Path escapes the task root: ${candidate}`,
      { root: absoluteRoot, target: absoluteTarget },
    )
  }
  return absoluteTarget
}

export function relativeInside(root, target) {
  const absoluteTarget = resolveInside(root, target)
  return path.relative(path.resolve(root), absoluteTarget).split(path.sep).join('/')
}

export function hasProtectedSegment(root, target, options = {}) {
  const relative = relativeInside(root, target)
  const segments = relative.split('/').filter(Boolean)
  const vcs = new Set(['.git', '.svn', '.hg'])
  const hostState = new Set(['.claude', '.codex', '.dsh', '.superpowers', '.ssh', '.aws'])

  return segments.some((segment) => {
    const lower = segment.toLowerCase()
    if (options.vcs !== false && vcs.has(lower)) return true
    if (hostState.has(lower)) return true
    if (lower === '.env' || lower.startsWith('.env.')) return true
    return ['credentials', 'credentials.json', 'credential.json'].includes(lower)
  })
}

export async function assertNoLinkComponents(root, target) {
  const absoluteRoot = path.resolve(root)
  const absoluteTarget = resolveInside(absoluteRoot, target)
  const relative = path.relative(absoluteRoot, absoluteTarget)
  const segments = relative.split(path.sep).filter(Boolean)
  let current = absoluteRoot

  for (const segment of segments) {
    current = path.join(current, segment)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink()) {
        throw new WorkspaceSentinelError(
          'PATH_LINK_NOT_ALLOWED',
          `Symbolic links are not allowed in cleanup paths: ${current}`,
          { root: absoluteRoot, target: absoluteTarget, link: current },
        )
      }
    } catch (error) {
      if (error?.code === 'ENOENT') break
      throw error
    }
  }
}

export async function assertNoMountComponents(root, target) {
  const absoluteRoot = path.resolve(root)
  const absoluteTarget = resolveInside(absoluteRoot, target)
  const rootStat = await lstat(absoluteRoot)
  const rootDevice = rootStat.dev
  const relative = path.relative(absoluteRoot, absoluteTarget)
  const segments = relative.split(path.sep).filter(Boolean)
  let current = absoluteRoot

  for (const segment of segments) {
    current = path.join(current, segment)
    try {
      const stat = await lstat(current)
      if (stat.isDirectory() && stat.dev !== rootDevice) {
        throw new WorkspaceSentinelError(
          'MOUNT_NOT_ALLOWED',
          `Filesystem mount points are not allowed in cleanup paths: ${current}`,
          { root: absoluteRoot, target: absoluteTarget, mount: current },
        )
      }
    } catch (error) {
      if (error?.code === 'ENOENT') break
      throw error
    }
  }
}

export async function assertTreeNoMounts(root, target) {
  const absoluteRoot = path.resolve(root)
  const absoluteTarget = resolveInside(absoluteRoot, target)
  await assertNoMountComponents(absoluteRoot, absoluteTarget)

  let stat
  try {
    stat = await lstat(absoluteTarget)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  if (!stat.isDirectory()) return
  const device = stat.dev
  for (const entry of await readdir(absoluteTarget, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const child = path.join(absoluteTarget, entry.name)
    let childStat
    try {
      childStat = await lstat(child)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (childStat.isDirectory()) {
      if (childStat.dev !== device) {
        throw new WorkspaceSentinelError(
          'MOUNT_NOT_ALLOWED',
          `Filesystem mount points are not allowed in cleanup trees: ${child}`,
          { root: absoluteRoot, target: absoluteTarget, mount: child },
        )
      }
      await assertTreeNoMounts(absoluteRoot, child)
    }
  }
}
