import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { access, readFile } from 'node:fs/promises'

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
  }

function commandHandlers(config, event) {
  return config.hooks[event].flatMap((group) => group.hooks)
  }

test('Codex manifest and hook config reference existing bundled components', async () => {
  const manifest = await readJson('.codex-plugin/plugin.json')
  assert.equal(manifest.name, 'workspace-sentinel')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.equal(manifest.skills, './skills/')
  assert.equal(manifest.hooks, './hooks/codex.json')

  const config = await readJson('hooks/codex.json')
  assert.deepEqual(Object.keys(config.hooks).sort(), [
    'PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit',
  ])
  for (const event of Object.keys(config.hooks)) {
    assert.ok(commandHandlers(config, event).length > 0, event)
  }
  const handlers = Object.values(config.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks))
  for (const handler of handlers) {
    assert.equal(handler.type, 'command')
    assert.match(handler.command, /src\/adapters\/codex\.js/)
    assert.doesNotMatch(handler.command, /SessionEnd/)
  }
  await access(path.resolve('src/adapters/codex.js'))
  })

test('Claude manifest uses exec-form hooks and includes SessionEnd only there', async () => {
  const manifest = await readJson('.claude-plugin/plugin.json')
  assert.equal(manifest.name, 'workspace-sentinel')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.equal(manifest.skills, './skills/')
  assert.equal(manifest.hooks, './hooks/claude.json')

  const config = await readJson('hooks/claude.json')
  assert.deepEqual(Object.keys(config.hooks).sort(), [
    'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit',
  ])
  const writeMatcher = config.hooks.PreToolUse.map((group) => group.matcher).join('|')
  assert.match(writeMatcher, /MultiEdit/)
  assert.match(writeMatcher, /NotebookEdit/)
  const handlers = Object.values(config.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks))
  for (const handler of handlers) {
    assert.equal(handler.type, 'command')
    assert.equal(handler.command, 'node')
    assert.ok(Array.isArray(handler.args))
    assert.ok(handler.args.some((argument) => argument.includes('${CLAUDE_PLUGIN_ROOT}/src/adapters/claude.js')))
  }
  await access(path.resolve('src/adapters/claude.js'))
  })

test('the shared Skill has valid frontmatter and all manifests parse', async () => {
  const skill = await readFile('skills/workspace-sentinel/SKILL.md', 'utf8')
  assert.match(skill, /^---\nname: workspace-sentinel\ndescription: /)
  await readJson('package.json')
  await readJson('.codex-plugin/plugin.json')
  await readJson('.claude-plugin/plugin.json')
  await readJson('hooks/codex.json')
  await readJson('hooks/claude.json')
  })
