import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

export function minimalEnvironment() {
  const env = {}
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

function isRunning(child) {
  return child.exitCode === null && child.signalCode === null
}

function waitForClose(child) {
  return new Promise((resolve) => child.once('close', resolve))
}

async function taskkillTree(child) {
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    killer.once('error', resolve)
    killer.once('close', resolve)
  })
}

async function signalChild(child, signal, group) {
  if (process.platform === 'win32') {
    if (group) await taskkillTree(child)
    return
  }
  try {
    process.kill(group ? -child.pid : child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

async function terminate(child, group, graceMs) {
  if (!isRunning(child) && !group) return
  const closed = isRunning(child) ? waitForClose(child) : Promise.resolve()

  if (process.platform === 'win32' && group) {
    await taskkillTree(child)
    await Promise.race([closed, delay(500)])
    return
  }

  await signalChild(child, 'SIGTERM', group)
  await Promise.race([closed, delay(graceMs)])

  if (group || isRunning(child)) {
    await signalChild(child, 'SIGKILL', group)
    await Promise.race([closed, delay(500)])
  }
}

export function terminateChild(child, graceMs = 400) {
  return terminate(child, false, graceMs)
}

export function terminateTree(child, graceMs = 400) {
  return terminate(child, true, graceMs)
}
