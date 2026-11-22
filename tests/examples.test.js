import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { access, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

function assertLocalSource(source) {
  assert.equal(typeof source, 'string')
  assert.ok(source.startsWith('./'), 'local source must start with ./')
  assert.doesNotMatch(source, /\.\./, 'local source must not escape the marketplace root')
}

async function stagedPluginRoot(marketplaceRoot, source, manifestDirectory) {
  const pluginRoot = path.resolve(marketplaceRoot, source)
  assert.ok(pluginRoot.startsWith(`${marketplaceRoot}${path.sep}`))
  assert.equal(path.basename(pluginRoot), 'workspace-sentinel')
  await mkdir(pluginRoot, { recursive: true })
  await cp(manifestDirectory, path.join(pluginRoot, manifestDirectory), { recursive: true })
  return pluginRoot
}

test('Codex marketplace example references this plugin manifest and has required policy fields', async (t) => {
  const example = await readJson('examples/codex-marketplace.json')
  const manifest = await readJson('.codex-plugin/plugin.json')
  assert.equal(example.name, 'workspace-sentinel-local')
  assert.equal(typeof example.interface.displayName, 'string')
  assert.equal(example.plugins.length, 1)

  const entry = example.plugins[0]
  assert.equal(entry.name, manifest.name)
  assert.equal(entry.source.source, 'local')
  assertLocalSource(entry.source.path)
  assert.equal(entry.policy.installation, 'AVAILABLE')
  assert.equal(entry.policy.authentication, 'ON_INSTALL')
  assert.equal(entry.category, 'Productivity')

  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-codex-market-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pluginRoot = await stagedPluginRoot(root, entry.source.path, '.codex-plugin')
  await access(path.join(pluginRoot, '.codex-plugin/plugin.json'))
})

test('Claude marketplace example follows its root-relative entry rules', async (t) => {
  const example = await readJson('examples/claude-marketplace.json')
  const manifest = await readJson('.claude-plugin/plugin.json')
  assert.equal(example.name, 'workspace-sentinel-local')
  assert.equal(typeof example.owner.name, 'string')
  const entry = example.plugins[0]
  assert.equal(entry.name, manifest.name)
  assertLocalSource(entry.source)

  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-claude-market-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pluginRoot = await stagedPluginRoot(root, entry.source, '.claude-plugin')
  await access(path.join(pluginRoot, '.claude-plugin/plugin.json'))
})

test('README documents safety, recovery, host trust, and DSH preview limits', async () => {
  const readme = await readFile('README.md', 'utf8')
  assert.match(readme, /永久删除/)
  assert.match(readme, /不可恢复/)
  assert.match(readme, /Codex[^\n]*Hook[^\n]*信任|Hook 信任/)
  assert.match(readme, /云端验证/)
  assert.match(readme, /恢复/)
  assert.match(readme, /quarantine|隔离区/i)
  assert.match(readme, /DSH[^\n]*技术预览|技术预览[^\n]*DSH/)
  assert.match(readme, /hooks are not a security sandbox|钩子不是安全沙箱|不是安全沙箱/)
  assert.match(readme, /node --test/)
})

test('DSH install example uses the documented bundle and profile commands', async () => {
  const guide = await readFile('examples/dsh-install.md', 'utf8')
  assert.match(guide, /dsh plugin --profile/)
  assert.match(guide, /--dump-config/)
  assert.match(guide, /dsh\.bundle/)
})

test('VALIDATION records offline checks and honest unavailable-host results', async () => {
  const validation = await readFile('VALIDATION.md', 'utf8')
  assert.match(validation, /node --test/)
  assert.match(validation, /npm pack --dry-run/)
  assert.match(validation, /codex plugin marketplace add/)
  assert.match(validation, /not run: host executable unavailable/)
  assert.match(validation, /not run: no live DSH runtime/)
})
