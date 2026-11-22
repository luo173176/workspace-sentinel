import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'

import { createTask } from '../src/core/task-store.js'
import { appendAudit } from '../src/core/audit.js'

test('appendAudit writes privacy-safe JSON Lines outside the task root', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sentinel-audit-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = path.join(base, 'project')
  const dataDir = path.join(base, 'data')
  await mkdir(root)
  const state = await createTask({ dataDir, root, mode: 'artifact', sessionId: 's' })

  await appendAudit(state, {
    action: 'permanent-delete',
    path: path.join(root, 'draft.tmp'),
    reason: 'current-task intermediate',
    evidenceClass: 'agent-created',
    result: 'deleted',
    prompt: 'do not persist this prompt',
    content: 'secret file body',
    env: { TOKEN: 'secret-token' },
  })

  const auditPath = path.join(state.taskDir, 'audit.jsonl')
  assert.equal(auditPath.startsWith(`${root}${path.sep}`), false)
  const raw = await readFile(auditPath, 'utf8')
  assert.equal(raw.includes('do not persist this prompt'), false)
  assert.equal(raw.includes('secret file body'), false)
  assert.equal(raw.includes('secret-token'), false)

  const entry = JSON.parse(raw.trim())
  assert.deepEqual(Object.keys(entry).sort(), [
    'action',
    'evidenceClass',
    'path',
    'reason',
    'result',
    'taskId',
    'time',
  ].sort())
  assert.equal(entry.taskId, state.id)
  assert.equal(entry.result, 'deleted')
})
