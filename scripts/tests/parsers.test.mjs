import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { parseToml, TomlError } from '../lib/toml-lite.mjs'
import { parseYaml } from '../lib/yaml-lite.mjs'
import { ROOT } from './helpers.mjs'

describe('toml-lite', () => {
  it('reads tables, arrays of tables, strings, arrays and inline tables', () => {
    const doc = parseToml(`
name = "app" # comment
flags = ["a", 'b',
  "c", # trailing
]
n = 1_000
on = true
[vars]
URL = "https://x.test/#frag"
[[kv_namespaces]]
binding = "KV"
id = "<KV_ID>"
[[kv_namespaces]]
binding = "KV2"
id = "<KV2_ID>"
[assets]
run_worker_first = ["/api/*"]
inline = { a = 1, b = "two" }
[queues]
[[queues.producers]]
queue = "app-jobs"
`)
    assert.equal(doc.name, 'app')
    assert.deepEqual(doc.flags, ['a', 'b', 'c'])
    assert.equal(doc.n, 1000)
    assert.equal(doc.vars.URL, 'https://x.test/#frag')
    assert.deepEqual(
      doc.kv_namespaces.map(k => k.id),
      ['<KV_ID>', '<KV2_ID>']
    )
    assert.deepEqual(doc.assets.inline, { a: 1, b: 'two' })
    assert.equal(doc.queues.producers[0].queue, 'app-jobs')
  })

  it('refuses a duplicate key and a broken line', () => {
    assert.throws(() => parseToml('a = 1\na = 2'), TomlError)
    assert.throws(() => parseToml('a = "open'), TomlError)
  })

  it('parses both of the app tomls', () => {
    for (const f of ['wrangler.toml', 'wrangler.staging.toml']) {
      const doc = parseToml(readFileSync(path.join(ROOT, 'apps/web', f), 'utf8'))
      assert.equal(doc.main, 'src/worker.ts')
    }
  })
})

describe('yaml-lite', () => {
  it('reads mappings, sequences of mappings, block scalars and flow sequences', () => {
    const doc = parseYaml(`
name: CI # comment
on:
  push:
    tags:
      - "[0-9]+"
  workflow_dispatch:
    inputs:
      environment:
        options: [staging, production]
jobs:
  gate:
    name: Gate
    if: |
      a &&
      b
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: echo "a: b" # not a key
`)
    assert.equal(doc.name, 'CI')
    assert.deepEqual(doc.on.push.tags, ['[0-9]+'])
    assert.deepEqual(doc.on.workflow_dispatch.inputs.environment.options, ['staging', 'production'])
    assert.equal(doc.jobs.gate.if, 'a &&\nb\n')
    assert.equal(doc.jobs.gate.steps[0].with['fetch-depth'], '0')
    assert.equal(doc.jobs.gate.steps[1].run, 'echo "a: b"')
  })

  it('parses every workflow in this repository', () => {
    for (const f of ['ci.yml', 'deploy.yml']) {
      const doc = parseYaml(readFileSync(path.join(ROOT, '.github/workflows', f), 'utf8'))
      assert.ok(doc.jobs && Object.keys(doc.jobs).length > 0, f)
    }
  })
})
