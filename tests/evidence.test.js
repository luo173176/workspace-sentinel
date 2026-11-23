import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'

import {
  fingerprintFile,
  snapshotTree,
  diffSnapshots,
  observeCreated,
  classifyPath,
} from '../src/core/evidence.js'

async function tempRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-evidence-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('fingerprintFile reports content hash and file metadata', async () => {
  const fixture = path.resolve('tests/fixtures/evidence-target.txt')
  const bytes = await readFile(fixture)
  const fingerprint = await fingerprintFile(fixture)

  assert.equal(fingerprint.size, bytes.length)
  assert.equal(fingerprint.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(typeof fingerprint.mtimeMs, 'number')
  assert.equal(typeof fingerprint.mode, 'number')
})

test('snapshot diffs identify created, modified, and deleted relative paths', async (t) => {
  const root = await tempRoot(t)
  await writeFile(path.join(root, 'delete.txt'), 'before')
  await writeFile(path.join(root, 'modify.txt'), 'before')
  const before = await snapshotTree(root)

  await unlink(path.join(root, 'delete.txt'))
  await writeFile(path.join(root, 'modify.txt'), 'after')
  await mkdir(path.join(root, 'nested'))
  await writeFile(path.join(root, 'nested/create.txt'), 'new')
  const after = await snapshotTree(root)

  assert.deepEqual(diffSnapshots(before, after), {
    created: ['nested/create.txt'],
    modified: ['modify.txt'],
    deleted: ['delete.txt'],
  })
})

test('snapshotTree does not follow symbolic links', async (t) => {
  const root = await tempRoot(t)
  const outside = await tempRoot(t)
  await writeFile(path.join(outside, 'secret.txt'), 'outside')
  const { symlink } = await import('node:fs/promises')
  await symlink(outside, path.join(root, 'linked'), 'dir')

  assert.deepEqual(await snapshotTree(root), {})
})

test('preexisting paths keep their identity after recreation', async (t) => {
  const root = await tempRoot(t)
  const target = path.join(root, 'source.js')
  await writeFile(target, 'original')
  const state = { root, baseline: await snapshotTree(root), evidence: {} }

  await unlink(target)
  await writeFile(target, 'recreated')

  assert.equal(classifyPath(state, target), 'preexisting')
  await assert.rejects(observeCreated(state, target, 'tool-1'), { code: 'PREEXISTING_FILE' })
})

test('observed creation records tool ownership and current fingerprint', async (t) => {
  const root = await tempRoot(t)
  const state = { root, baseline: {}, evidence: {} }
  const target = path.join(root, 'new.txt')
  await writeFile(target, 'created by tool')

  const evidence = await observeCreated(state, target, 'tool-42')

  assert.equal(evidence.toolCallId, 'tool-42')
  assert.equal(classifyPath(state, target), 'agent-created')
  assert.equal(state.evidence['new.txt'].fingerprint.sha256, evidence.fingerprint.sha256)
})

test('unobserved workspace files and paths outside the root remain unknown', async (t) => {
  const root = await tempRoot(t)
  const state = { root, baseline: {}, evidence: {} }
  const target = path.join(root, 'external.txt')
  await writeFile(target, 'unknown origin')

  assert.equal(classifyPath(state, target), 'unknown')
  assert.equal(classifyPath(state, path.join(root, '../outside.txt')), 'unknown')
})

test('plugin scratch files have their own evidence class', async (t) => {
  const root = await tempRoot(t)
  const scratchDir = await tempRoot(t)
  const state = { root, scratchDir, baseline: {}, evidence: {} }

  assert.equal(classifyPath(state, path.join(scratchDir, 'draft.txt')), 'plugin-owned')
})

test('editing after observation changes the recorded fingerprint comparison', async (t) => {
  const root = await tempRoot(t)
  const state = { root, baseline: {}, evidence: {} }
  const target = path.join(root, 'changing.txt')
  await writeFile(target, 'first')
  const evidence = await observeCreated(state, target, 'tool-edit')

  await writeFile(target, 'second version')
  const current = await fingerprintFile(target)

  assert.notEqual(current.sha256, evidence.fingerprint.sha256)
})

test('an unexpected evidence class fails closed as unknown', async (t) => {
  const root = await tempRoot(t)
  const target = path.join(root, 'suspicious.txt')
  await writeFile(target, 'content')
  const state = {
    root,
    baseline: {},
    evidence: { 'suspicious.txt': { class: 'something-else', fingerprint: {} } },
  }

  assert.equal(classifyPath(state, target), 'unknown')
})

test('snapshotTree ignores .git and node_modules by default', async (t) => {
  const root = await tempRoot(t)
  await writeFile(path.join(root, 'keep.txt'), 'k')
  await mkdir(path.join(root, '.git'))
  await writeFile(path.join(root, '.git', 'config'), 'x')
  await mkdir(path.join(root, 'node_modules'))
  await mkdir(path.join(root, 'node_modules', 'pkg'))
  await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x')
  await mkdir(path.join(root, 'src'))
  await writeFile(path.join(root, 'src', 'main.js'), 'x')

  const snapshot = await snapshotTree(root)
  assert.deepEqual(Object.keys(snapshot).sort(), ['keep.txt', 'src/main.js'])
  // Non-ignored files keep exactly the same fingerprint as before the change.
  assert.equal(
    snapshot['src/main.js'].sha256,
    createHash('sha256').update(Buffer.from('x')).digest('hex'),
  )
})

test('snapshotTree honors a custom ignore list that replaces the defaults', async (t) => {
  const root = await tempRoot(t)
  await writeFile(path.join(root, 'a.txt'), 'a')
  await mkdir(path.join(root, 'build'))
  await writeFile(path.join(root, 'build', 'out.js'), 'x')
  await mkdir(path.join(root, 'node_modules'))
  await writeFile(path.join(root, 'node_modules', 'm.js'), 'x')

  const snapshot = await snapshotTree(root, { ignore: ['build'] })
  assert.deepEqual(Object.keys(snapshot).sort(), ['a.txt', 'node_modules/m.js'])
})

test('ignored directories present at baseline keep preexisting ownership', async (t) => {
  const root = await tempRoot(t)
  await mkdir(path.join(root, '.git'))
  await writeFile(path.join(root, '.git', 'config'), '[core]')
  await mkdir(path.join(root, 'node_modules'))
  await writeFile(path.join(root, 'node_modules', 'm.js'), 'x')

  const ignoredDirs = []
  const baseline = await snapshotTree(root, { ignoredDirs })
  const state = { root, baseline, baselineIgnoreRoots: ignoredDirs, evidence: {} }

  assert.deepEqual(Object.keys(baseline), [])
  assert.equal(classifyPath(state, path.join(root, '.git', 'config')), 'preexisting')
  assert.equal(classifyPath(state, path.join(root, 'node_modules', 'm.js')), 'preexisting')
  assert.equal(classifyPath(state, path.join(root, '.git')), 'preexisting')

  const fresh = { root, baseline, evidence: {} } // no baselineIgnoreRoots -> unknown
  assert.equal(classifyPath(fresh, path.join(root, '.git', 'config')), 'unknown')
})

test('fingerprintFile hashes multi-megabyte files identically to a full buffer hash', async (t) => {
  const root = await tempRoot(t)
  const target = path.join(root, 'big.bin')
  const chunk = Buffer.alloc(1024 * 1024, 7)
  const buffer = Buffer.concat([chunk, chunk, chunk, chunk, chunk])
  await writeFile(target, buffer)

  const fingerprint = await fingerprintFile(target)
  assert.equal(fingerprint.size, 5 * 1024 * 1024)
  assert.equal(fingerprint.sha256, createHash('sha256').update(buffer).digest('hex'))
})
