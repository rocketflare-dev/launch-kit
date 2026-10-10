/**
 * True of the kit repository only (scaffold.kitOnly deletes it from every copy): the root version
 * has its porting note and its changelog section, so a tag can be cut from any green main.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { ROOT } from '../helpers.mjs'

it('the root version has a porting note and a CHANGELOG section', () => {
  const { version } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.ok(
    existsSync(path.join(ROOT, `docs/upgrades/${version}.md`)),
    `docs/upgrades/${version}.md`
  )
  assert.match(
    readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'),
    new RegExp(`^## ${version.replaceAll('.', '\\.')}$`, 'm')
  )
})

it('the kit has no app manifest (it is not a copy)', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'launch.kit.json'), 'utf8'))
  assert.ok(!existsSync(path.join(ROOT, manifest.scaffold.appManifest)))
})
