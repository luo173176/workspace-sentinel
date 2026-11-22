import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'

test('package manifest declares a DSH bundle and executable entry', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  assert.equal(pkg.main, './index.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(pkg.files.includes('index.js'))
  assert.ok(pkg.files.includes('cordis.patch.yml'))
  assert.equal(pkg.engines?.dsh, undefined, 'engines.dsh must stay omitted until a live DSH version is verified')
  })

test('bundle patch references the package plugin row', async () => {
  const patch = await readFile('cordis.patch.yml', 'utf8')
  assert.match(patch, /^-\s*insert:/m)
  assert.match(patch, /id:\s*workspace-sentinel/)
  assert.match(patch, /name:\s*dsh-workspace-sentinel/)
  })

test('index exports the required DSH plugin shape', async () => {
  const module = await import('../index.js')
  assert.equal(module.name, 'workspace-sentinel')
  assert.equal(typeof module.apply, 'function')
  await access('index.js')
  await access('cordis.patch.yml')
  })
