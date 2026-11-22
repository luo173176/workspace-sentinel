import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'

import { createTask, loadTask, updateTask } from '../src/core/task-store.js'
import { observeCreated } from '../src/core/evidence.js'
import { setArtifactPlan } from '../src/core/artifact.js'
import { handleHookEvent, classifyAfterMissingShellDiff } from '../src/adapters/hook-common.js'

async function testTask(t, mode = 'artifact') {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sentinel-hook-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = path.join(base, 'project')
  const dataDir = path.join(base, 'data')
  await mkdir(root)
  const state = await createTask({ dataDir, root, mode, sessionId: 'session-1' })
  return { base, root, dataDir, state }
  }

function event(name, root, extra = {}) {
  return {
    session_id: 'session-1',
    cwd: root,
    hook_event_name: name,
    ...extra,
  }
  }

async function evidenceKeys(dataDir, taskId) {
  return Object.keys((await loadTask(dataDir, taskId)).evidence)
  }

test('direct apply_patch creates become persisted agent evidence', async (t) => {
  const { root, dataDir, state } = await testTask(t)
  const target = path.join(root, 'result.txt')
  await writeFile(target, 'hello')

  const result = await handleHookEvent('codex', event('PostToolUse', root, {
    tool_name: 'apply_patch',
    tool_use_id: 'tool-1',
    tool_input: { command: '*** Begin Patch\n*** Add File: result.txt\n+hello\n*** End Patch' },
  }), { dataDir })

  assert.deepEqual(result, {})
  assert.deepEqual(await evidenceKeys(dataDir, state.id), ['result.txt'])
  })

test('Claude Write records a new file and ignores a preexisting edit as deletion evidence', async (t) => {
  const { root, dataDir, state } = await testTask(t)
  const created = path.join(root, 'new.txt')
  await writeFile(created, 'new')

  await handleHookEvent('claude', event('PostToolUse', root, {
    tool_name: 'Write',
    tool_use_id: 'tool-create',
    tool_input: { file_path: created },
  }), { dataDir })
  assert.deepEqual(await evidenceKeys(dataDir, state.id), ['new.txt'])

  const existing = path.join(root, 'existing.txt')
  await writeFile(existing, 'before')
  const second = await createTask({ dataDir, root, mode: 'artifact', sessionId: 'session-1' })
  await handleHookEvent('claude', event('PostToolUse', root, {
    tool_name: 'Edit',
    tool_use_id: 'tool-edit',
    tool_input: { file_path: existing },
  }), { dataDir })
  assert.deepEqual(await evidenceKeys(dataDir, second.id), [])
  })

test('both hosts deny direct writes into root scratch zones with their documented shape', async (t) => {
  const { root, dataDir } = await testTask(t)
  const target = path.join(root, 'tmp', 'draft.txt')
  await mkdir(path.dirname(target))
  await writeFile(target, 'x')

  const codex = await handleHookEvent('codex', event('PreToolUse', root, {
    tool_name: 'apply_patch',
    tool_use_id: 'tool-deny-codex',
    tool_input: { command: '*** Add File: tmp/draft.txt\n+x' },
  }), { dataDir })
  assert.equal(codex.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(codex.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(codex.hookSpecificOutput.permissionDecisionReason, /scratch/i)

  const claude = await handleHookEvent('claude', event('PreToolUse', root, {
    tool_name: 'Write',
    tool_use_id: 'tool-deny-claude',
    tool_input: { file_path: target },
  }), { dataDir })
  assert.equal(claude.hookSpecificOutput.permissionDecision, 'deny')
  })

test('declared final files and keep paths are exempt from the scratch rule', async (t) => {
  const { root, dataDir, state } = await testTask(t)
  const logFinal = path.join(root, 'run.log')
  await writeFile(logFinal, 'log')
  await setArtifactPlan(state, { candidates: [{ path: logFinal, support: [] }], intermediates: [] })

  const result = await handleHookEvent('claude', event('PreToolUse', root, {
    tool_name: 'Write',
    tool_use_id: 'tool-final',
    tool_input: { file_path: logFinal },
  }), { dataDir })
  assert.deepEqual(result, {})
  })

test('Bash receives guidance but is never denied or parsed', async (t) => {
  const { root, dataDir } = await testTask(t)
  const result = await handleHookEvent('claude', event('PreToolUse', root, {
    tool_name: 'Bash',
    tool_use_id: 'tool-bash',
    tool_input: { command: 'rm -rf tmp && echo done' },
  }), { dataDir })

  assert.equal(result.hookSpecificOutput.permissionDecision, undefined)
  assert.match(result.hookSpecificOutput.additionalContext, /scratch/i)
  })

test('Bash before and after snapshots record new files when the diff is available', async (t) => {
  const { root, dataDir } = await testTask(t)
  await handleHookEvent('codex', event('PreToolUse', root, {
    tool_name: 'Bash',
    tool_use_id: 'tool-shell',
    tool_input: { command: 'touch generated.txt' },
  }), { dataDir })
  await writeFile(path.join(root, 'generated.txt'), 'generated')
  await handleHookEvent('codex', event('PostToolUse', root, {
    tool_name: 'Bash',
    tool_use_id: 'tool-shell',
    tool_input: { command: 'touch generated.txt' },
    tool_response: {},
  }), { dataDir })

  const state = (await loadTask(dataDir, (await loadTaskAny(dataDir)))).id
  const loaded = await loadTask(dataDir, state)
  assert.ok(loaded.evidence['generated.txt'])
  })

async function loadTaskAny(dataDir) {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(path.join(dataDir, 'tasks'), { withFileTypes: true })
  return entries.find((entry) => entry.isDirectory()).name
  }

test('missing shell diff classifies an unseen file as unknown, never agent-created', async () => {
  assert.equal(classifyAfterMissingShellDiff({ path: '/tmp/new.txt' }), 'unknown')
  })

test('multi-candidate Stop asks for user selection exactly once', async (t) => {
  const { root, dataDir, state } = await testTask(t)
  const first = path.join(root, 'a.pptx')
  const second = path.join(root, 'b.pptx')
  await writeFile(first, 'a')
  await writeFile(second, 'b')
  await observeCreated(state, first, 'tool-a')
  await observeCreated(state, second, 'tool-b')
  await updateTask(state, () => {})
  await setArtifactPlan(state, {
    candidates: [{ path: first, support: [] }, { path: second, support: [] }],
    intermediates: [],
  })

  const firstStop = await handleHookEvent('claude', event('Stop', root), { dataDir })
  assert.equal(firstStop.decision, 'block')
  assert.match(firstStop.reason, /choose|select/i)

  const secondStop = await handleHookEvent('claude', event('Stop', root), { dataDir })
  assert.equal(secondStop.decision, undefined)
  const reloaded = await loadTask(dataDir, state.id)
  assert.equal(reloaded.artifact.selectionPrompted, true)
  })

test('SessionStart adds skill context for both hosts', async (t) => {
  const { root, dataDir } = await testTask(t)
  for (const host of ['codex', 'claude']) {
    const result = await handleHookEvent(host, event('SessionStart', root, { source: 'startup' }), { dataDir })
    assert.equal(result.hookSpecificOutput.hookEventName, 'SessionStart')
    assert.match(result.hookSpecificOutput.additionalContext, /workspace-sentinel/)
  }
  })

test('Codex stdin entry point emits a single JSON object and exits zero', async (t) => {
  const { root, dataDir } = await testTask(t)
  const child = spawn(process.execPath, [path.resolve('src/adapters/codex.js')], {
    env: { ...process.env, PLUGIN_DATA: dataDir },
  })
  let output = ''
  child.stdin.end(JSON.stringify(event('SessionStart', root, { source: 'startup' })))
  child.stdout.on('data', (chunk) => { output += chunk })
  const status = await new Promise((resolve) => child.once('close', resolve))

  assert.equal(status, 0)
  const parsed = JSON.parse(output)
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart')
  })

test('a single active task associates by root when the skill could not pass the host session id', async (t) => {
  const { root, dataDir, state } = await testTask(t)
  await updateTask(state, (current) => {
    current.sessionId = 'skill-chosen-label'
  })
  const target = path.join(root, 'single.txt')
  await writeFile(target, 'created')

  await handleHookEvent('claude', event('PostToolUse', root, {
    session_id: 'host-session-id',
    tool_name: 'Write',
    tool_use_id: 'tool-single',
    tool_input: { file_path: target },
  }), { dataDir })

  assert.deepEqual(await evidenceKeys(dataDir, state.id), ['single.txt'])
})

test('ambiguous active tasks in one root never receive cross-session evidence', async (t) => {
  const { root, dataDir, state } = await testTask(t)
  const second = await createTask({ dataDir, root, mode: 'artifact', sessionId: 'other-session' })
  const target = path.join(root, 'ambiguous.txt')
  await writeFile(target, 'created')

  await handleHookEvent('claude', event('PostToolUse', root, {
    session_id: 'unknown-host-session',
    tool_name: 'Write',
    tool_use_id: 'tool-ambiguous',
    tool_input: { file_path: target },
  }), { dataDir })

  assert.deepEqual(await evidenceKeys(dataDir, state.id), [])
  assert.deepEqual(await evidenceKeys(dataDir, second.id), [])
})

test('Bash rename of a preexisting file does not become agent-created deletion evidence', async (t) => {
  const { root, dataDir, state } = await testTask(t)
  const original = path.join(root, 'note.txt')
  const moved = path.join(root, 'draft.tmp')
  await writeFile(original, 'user content')

  await handleHookEvent('codex', event('PreToolUse', root, {
    tool_name: 'Bash',
    tool_use_id: 'tool-rename',
    tool_input: { command: 'mv note.txt draft.tmp' },
  }), { dataDir })
  const { rename } = await import('node:fs/promises')
  await rename(original, moved)
  await handleHookEvent('codex', event('PostToolUse', root, {
    tool_name: 'Bash',
    tool_use_id: 'tool-rename',
    tool_input: { command: 'mv note.txt draft.tmp' },
    tool_response: {},
  }), { dataDir })

  const loaded = await loadTask(dataDir, state.id)
  assert.equal(loaded.evidence['draft.tmp'].class, 'preexisting')
  assert.equal(loaded.evidence['draft.tmp'].movedFrom, 'note.txt')
})
