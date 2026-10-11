/**
 * True of the kit repository only (scaffold.kitOnly deletes it from every copy): the kit's OWN
 * files parse and its manifest is valid. An app made from the kit renames, provisions and edits
 * these files, so the same assertions would be about the app's choices, not the kit's code; the
 * checker's own tests run on fixtures (../fixtures/kit-fixture.mjs) for that reason. Whether the
 * kit conforms as a whole is not a test: it is kit.yml's `Kit check` step.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { validateManifest } from '../../lib/kit-manifest.mjs'
import { parseToml } from '../../lib/toml-lite.mjs'
import { parseYaml } from '../../lib/yaml-lite.mjs'
import { ROOT } from '../helpers.mjs'

const read = rel => readFileSync(path.join(ROOT, rel), 'utf8')

it("the kit's manifest is valid", () => {
  const { problems, manifest } = validateManifest(JSON.parse(read('launch.kit.json')))
  assert.deepEqual(problems, [])
  assert.equal(manifest.schema, 1)
})

it('both of the app tomls and every workflow parse', () => {
  for (const f of ['wrangler.toml', 'wrangler.staging.toml'])
    assert.equal(parseToml(read(`apps/web/${f}`)).main, 'src/worker.ts')
  for (const f of ['ci.yml', 'deploy.yml', 'kit.yml']) {
    const doc = parseYaml(read(`.github/workflows/${f}`))
    assert.ok(doc.jobs && Object.keys(doc.jobs).length > 0, f)
  }
})
