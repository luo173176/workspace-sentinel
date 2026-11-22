import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { WorkspaceSentinelError } from './errors.js'
import { minimalEnvironment, terminateTree } from './child-process.js'

function launch(command, detached = false) {
  return spawn(command.argv[0], command.argv.slice(1), {
    cwd: command.cwd,
    env: minimalEnvironment(),
    shell: false,
    detached,
    stdio: 'ignore',
  })
}

async function stopOwnedProcess(child) {
  await terminateTree(child)
}

async function runFinite(command) {
  const detached = process.platform !== 'win32'
  const child = launch(command, detached)
  let startError
  child.once('error', (error) => {
    startError = error
  })
  const closed = new Promise((resolve) => child.once('close', resolve))
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    terminateTree(child).catch(() => {})
  }, command.timeoutMs)

  await closed
  clearTimeout(timer)
  if (startError) {
    throw new WorkspaceSentinelError('VERIFICATION_FAILED', 'Verification command could not start', {
      cause: startError.message,
    })
  }
  if (timedOut) {
    throw new WorkspaceSentinelError('VERIFICATION_TIMEOUT', 'Verification command timed out')
  }
  if (child.exitCode !== 0) {
    throw new WorkspaceSentinelError('VERIFICATION_FAILED', `Verification exited with ${child.exitCode}`)
  }
}

async function verifyLongRunning(specification) {
  const detached = process.platform !== 'win32'
  const child = launch(specification.start, detached)
  let startError
  let startClosed = false
  child.once('error', (error) => {
    startError = error
  })
  child.once('close', () => {
    startClosed = true
  })

  try {
    const deadline = Date.now() + specification.start.timeoutMs
    while (true) {
      if (startError || startClosed) {
        throw new WorkspaceSentinelError('VERIFICATION_FAILED', 'Long-running target exited before readiness', {
          cause: startError?.message,
        })
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new WorkspaceSentinelError('VERIFICATION_TIMEOUT', 'Target readiness timed out')
      }
      try {
        await runFinite({
          ...specification.ready,
          timeoutMs: Math.min(specification.ready.timeoutMs, remaining),
        })
        return
      } catch {
        const afterAttempt = deadline - Date.now()
        if (afterAttempt <= 0) {
          throw new WorkspaceSentinelError('VERIFICATION_TIMEOUT', 'Target readiness timed out')
        }
        await delay(Math.min(75, afterAttempt))
      }
    }
  } finally {
    await stopOwnedProcess(child)
  }
}

export async function verifyTarget(verificationSpec) {
  if (verificationSpec.kind === 'exit') {
    await runFinite(verificationSpec.command)
    return
  }
  if (verificationSpec.kind === 'long-running') {
    await verifyLongRunning(verificationSpec)
    return
  }
  throw new WorkspaceSentinelError('COMMAND_SPEC_INVALID', 'Unknown verification kind')
}
