import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, mkdir, writeFile, symlink, lstat } from 'node:fs/promises'

import { WorkspaceSentinelError } from '../src/core/errors.js'
import {
  containsPath,
  resolveInside,
  relativeInside,
  assertNoLinkComponents,
  assertNoMountComponents,
  assertTreeNoMounts,
  hasProtectedSegment,
} from '../src/core/paths.js'

test('WorkspaceSentinelError exposes stable error details', () => {
  const error = new WorkspaceSentinelError('TEST_CODE', 'broken', { path: '/tmp/x' })
  assert.equal(error.code, 'TEST_CODE')
  assert.deepEqual(error.details, { path: '/tmp/x' })
  assert.equal(error.name, 'WorkspaceSentinelError')
})

test('containsPath accepts a child but rejects a sibling with the same prefix', () => {
  assert.equal(containsPath(path, '/work/app', '/work/app/dist'), true)
  assert.equal(containsPath(path, '/work/app', '/work/app'), true)
  assert.equal(containsPath(path, '/work/app', '/work/app2'), false)
})

test('Windows containment handles drive case and UNC roots', () => {
  assert.equal(containsPath(path.win32, 'C:\\Work\\App', 'c:\\work\\app\\dist'), true)
  assert.equal(containsPath(path.win32, 'C:\\Work\\App', 'D:\\Work\\App\\dist'), false)
  assert.equal(containsPath(path.win32, '\\\\server\\share\\root', '\\\\server\\share\\root\\a'), true)
  assert.equal(containsPath(path.win32, '\\\\server\\share\\root', '\\\\server\\other\\root\\a'), false)
})

test('resolveInside returns normalized descendants and rejects escapes', () => {
  const root = path.resolve('/work/app')
  assert.equal(resolveInside(root, 'dist/../dist/index.js'), path.join(root, 'dist/index.js'))
  assert.throws(() => resolveInside(root, '../secret'), { code: 'PATH_OUTSIDE_ROOT' })
  assert.throws(() => resolveInside(root, '/etc/passwd'), { code: 'PATH_OUTSIDE_ROOT' })
  assert.throws(() => resolveInside(root, '../app2/file'), { code: 'PATH_OUTSIDE_ROOT' })
})

test('relativeInside emits portable relative keys', () => {
  const root = path.resolve('/work/app')
  assert.equal(relativeInside(root, path.join(root, 'a/b.txt')), 'a/b.txt')
  assert.equal(relativeInside(root, root), '')
})

test('protected segments include VCS, host state, and credentials', () => {
  assert.equal(hasProtectedSegment('/work/app', '/work/app/.git/objects/a'), true)
  assert.equal(hasProtectedSegment('/work/app', '/work/app/src/.gitignore'), false)
  assert.equal(hasProtectedSegment('/work/app', '/work/app/.git', { vcs: false }), false)
  assert.equal(hasProtectedSegment('/work/app', '/work/app/.env'), true)
  assert.equal(hasProtectedSegment('/work/app', '/work/app/.claude/settings.json'), true)
  assert.equal(hasProtectedSegment('/work/app', '/work/app/.codex/config.toml'), true)
  assert.equal(hasProtectedSegment('/work/app', '/work/app/.superpowers/state.json'), true)
})

test('assertNoLinkComponents rejects a symlinked parent', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sentinel-paths-'))
  const root = path.join(base, 'root')
  const outside = path.join(base, 'outside')
  await mkdir(root)
  await mkdir(outside)
  await writeFile(path.join(outside, 'file.txt'), 'keep')
  await symlink(outside, path.join(root, 'linked'), 'dir')

  await assert.rejects(
    assertNoLinkComponents(root, path.join(root, 'linked/file.txt')),
    { code: 'PATH_LINK_NOT_ALLOWED' },
  )
  await assert.doesNotReject(assertNoLinkComponents(root, path.join(root, 'new/file.txt')))
})

test('assertNoMountComponents rejects crossing into another filesystem mount', async (t) => {
  if (process.platform !== 'linux') return t.skip('mount device IDs are asserted on Linux')
  const root = '/'
  let rootStat
  let mountStat
  try {
    ;[rootStat, mountStat] = await Promise.all([lstat('/'), lstat('/proc')])
  } catch {
    return t.skip('/proc is unavailable')
  }
  if (rootStat.dev === mountStat.dev) return t.skip('/proc shares the root filesystem here')

  await assert.rejects(assertNoMountComponents(root, '/proc'), { code: 'MOUNT_NOT_ALLOWED' })
})

test('assertTreeNoMounts rejects a mount nested below the root', async (t) => {
  if (process.platform !== 'linux') return t.skip('mount device IDs are asserted on Linux')
  let rootStat
  let mountStat
  try {
    ;[rootStat, mountStat] = await Promise.all([lstat('/'), lstat('/proc')])
  } catch {
    return t.skip('/proc is unavailable')
  }
  if (rootStat.dev === mountStat.dev) return t.skip('/proc shares the root filesystem here')

  await assert.rejects(assertTreeNoMounts('/', '/proc'), { code: 'MOUNT_NOT_ALLOWED' })
})
