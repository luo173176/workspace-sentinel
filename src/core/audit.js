import path from 'node:path'
import { appendFile } from 'node:fs/promises'

export async function appendAudit(state, entry) {
  const safeEntry = {
    time: new Date().toISOString(),
    taskId: state.id,
    action: String(entry.action),
  }
  if (typeof entry.path === 'string') safeEntry.path = path.resolve(entry.path)
  if (entry.reason !== undefined) safeEntry.reason = String(entry.reason)
  if (entry.evidenceClass !== undefined) safeEntry.evidenceClass = String(entry.evidenceClass)
  if (entry.result !== undefined) safeEntry.result = String(entry.result)

  const line = `${JSON.stringify(safeEntry)}\n`
  await appendFile(path.join(state.taskDir, 'audit.jsonl'), line, { mode: 0o600 })
  return safeEntry
}
