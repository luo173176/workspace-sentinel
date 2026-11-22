import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'

import { verifyTarget } from '../src/core/process-verify.js'

const fixture = (name) => path.resolve(`tests/fixtures/${name}`)
const command = (cwd, argv, timeoutMs = 1_000) => ({ argv, cwd, timeoutMs })

function running(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('one-shot verification accepts exit zero and rejects failure', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sentinel-verify-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))

  await assert.doesNotReject(verifyTarget({
    kind: 'exit',
    command: command(cwd, [process.execPath, fixture('verify-pass.js')]),
  }))
  await assert.rejects(verifyTarget({
    kind: 'exit',
    command: command(cwd, [process.execPath, fixture('verify-fail.js')]),
  }), { code: 'VERIFICATION_FAILED' })
})

test('one-shot verification enforces its timeout', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sentinel-verify-timeout-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))

  await assert.rejects(verifyTarget({
    kind: 'exit',
    command: command(cwd, [process.execPath, fixture('verify-timeout.js')], 150),
  }), { code: 'VERIFICATION_TIMEOUT' })
})

test('long-running readiness succeeds and cleans up only its own child', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sentinel-verify-server-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const pidFile = path.join(cwd, 'owned.pid')
  const readyFile = path.join(cwd, 'owned.ready')
  const unrelatedPidFile = path.join(cwd, 'unrelated.pid')
  const unrelated = spawn(process.execPath, [fixture('verify-server.js'), unrelatedPidFile, path.join(cwd, 'never'), 'no'], {
    cwd,
    stdio: 'ignore',
  })
  t.after(() => unrelated.kill('SIGTERM'))
  await new Promise((resolve) => setTimeout(resolve, 100))

  await verifyTarget({
    kind: 'long-running',
    start: command(cwd, [process.execPath, fixture('verify-server.js'), pidFile, readyFile, 'yes'], 2_000),
    ready: command(cwd, [process.execPath, fixture('verify-ready.js'), readyFile], 100),
  })

  const ownedPid = Number(await readFile(pidFile, 'utf8'))
  const unrelatedPid = Number(await readFile(unrelatedPidFile, 'utf8'))
  assert.equal(running(ownedPid), false)
  assert.equal(running(unrelatedPid), true)
})

test('long-running readiness timeout kills the spawned process', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sentinel-verify-stall-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const pidFile = path.join(cwd, 'stalled.pid')
  const readyFile = path.join(cwd, 'never.ready')

  await assert.rejects(verifyTarget({
    kind: 'long-running',
    start: command(cwd, [process.execPath, fixture('verify-server.js'), pidFile, readyFile, 'no'], 250),
    ready: command(cwd, [process.execPath, fixture('verify-ready.js'), readyFile], 50),
  }), { code: 'VERIFICATION_TIMEOUT' })

  const pid = Number(await readFile(pidFile, 'utf8'))
  assert.equal(running(pid), false)
})

test('verification timeout escalates when the command ignores SIGTERM', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sentinel-verify-hard-stop-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))

  const started = Date.now()
  await assert.rejects(verifyTarget({
    kind: 'exit',
    command: command(cwd, [process.execPath, fixture('verify-slow-term.js')], 100),
  }), { code: 'VERIFICATION_TIMEOUT' })
  assert.ok(Date.now() - started < 900, 'timeout must not wait for a SIGTERM-ignoring child')
})

test('verification timeout stops the whole plugin-started process tree', async (t) => {
  if (process.platform === 'win32') return t.skip('process-group assertions are Unix-only')
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sentinel-verify-tree-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const pidFile = path.join(cwd, 'grandchild.pid')
  let grandchild
  t.after(() => {
    if (grandchild && running(grandchild)) process.kill(grandchild, 'SIGKILL')
  })

  await assert.rejects(verifyTarget({
    kind: 'exit',
    command: command(cwd, [process.execPath, fixture('verify-tree.js'), pidFile], 150),
  }), { code: 'VERIFICATION_TIMEOUT' })

  await new Promise((resolve) => setTimeout(resolve, 200))
  grandchild = Number(await readFile(pidFile, 'utf8'))
  assert.equal(running(grandchild), false)
})

test('long-running start that exits before readiness stops its remaining process tree', async (t) => {
  if (process.platform === 'win32') return t.skip('process-group assertions are Unix-only')
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sentinel-verify-orphan-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const pidFile = path.join(cwd, 'orphan.pid')
  const readyFile = path.join(cwd, 'never.ready')
  let orphan
  t.after(() => {
    if (orphan && running(orphan)) process.kill(orphan, 'SIGKILL')
  })

  await assert.rejects(verifyTarget({
    kind: 'long-running',
    start: command(cwd, [process.execPath, fixture('verify-orphan.js'), pidFile], 2_000),
    ready: command(cwd, [process.execPath, fixture('verify-ready.js'), readyFile], 50),
  }), { code: 'VERIFICATION_FAILED' })

  await new Promise((resolve) => setTimeout(resolve, 200))
  orphan = Number(await readFile(pidFile, 'utf8'))
  assert.equal(running(orphan), false)
})
