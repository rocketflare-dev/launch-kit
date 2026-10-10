/** Build once (docs/DEPLOYER.md → Build once): the bundle's pack/unpack, digest and verification. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  collectEntries,
  makeManifest,
  packBundle,
  payloadDigest,
  productionSource,
  unpackBundle,
  verifyBundle,
} from '../lib/bundle-lib.mjs'

const toml =
  'name = "x"\nmain = "src/worker.ts"\ncompatibility_date = "2026-06-01"\ncompatibility_flags = ["nodejs_compat"]\n'
const entries = collectEntries({
  worker: { 'worker.js': Buffer.from('export default {}'), 'worker.js.map': Buffer.from('{}') },
  ui: { 'index.html': Buffer.from('<html>'), '.assetsignore': Buffer.from('x') },
})
const facts = { tag: '1.0.0', commit: 'a'.repeat(40), treeSha: 'b'.repeat(40) }
const manifest = makeManifest({ ...facts, version: '1.0.0', toml, wranglerVersion: '4', entries })

describe('bundle', () => {
  it('keeps exactly what the upload sends, and its digest equals the upload digest', () => {
    assert.deepEqual(Object.keys(entries).sort(), ['ui/index.html', 'worker/worker.js'])
    const modules = { 'worker.js': Buffer.from('export default {}').toString('base64') }
    const assets = { '/index.html': Buffer.from('<html>').toString('base64') }
    assert.equal(manifest.bundleSha256, payloadDigest({ modules, assets }))
  })

  it('packs deterministically and verifies against the same checkout', () => {
    const a = packBundle({ manifest, entries })
    const b = packBundle({ manifest, entries })
    assert.ok(a.equals(b))
    const bundle = unpackBundle(a)
    assert.deepEqual(verifyBundle(bundle, { ...facts, toml }), [])
  })

  it('refuses another commit, or a tampered file', () => {
    const bundle = unpackBundle(packBundle({ manifest, entries }))
    assert.ok(verifyBundle(bundle, { ...facts, commit: 'c'.repeat(40), toml }).length > 0)
    bundle.entries['worker/worker.js'] = Buffer.from('evil')
    assert.ok(verifyBundle(bundle, { ...facts, toml }).length > 0)
  })

  it('production builds from the tag when the release carries no bundle', () => {
    assert.equal(
      productionSource({ deployer: true, tag: '1.0.0', release: { assets: [] } }).source,
      'build'
    )
    assert.equal(productionSource({ deployer: false, tag: '1.0.0', release: null }).source, 'build')
  })
})
