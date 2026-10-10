import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fillTemplate, validateManifest } from '../lib/kit-manifest.mjs'
import { ROOT } from './helpers.mjs'

const own = () => JSON.parse(readFileSync(path.join(ROOT, 'launch.kit.json'), 'utf8'))

describe('launch.kit.json (the shape Launch parses)', () => {
  it("this repository's manifest is valid", () => {
    const { problems, manifest } = validateManifest(own())
    assert.deepEqual(problems, [])
    assert.equal(manifest.schema, 1)
  })

  it('applies the same defaults as Launch', () => {
    const m = own()
    delete m.health
    delete m.kit.version
    delete m.worker.naming
    delete m.declaredConfig
    const { manifest } = validateManifest(m)
    assert.deepEqual(manifest.health, { live: '/api/health', ready: '/api/ready' })
    assert.deepEqual(manifest.kit.version, { file: 'package.json', field: 'version' })
    assert.deepEqual(manifest.worker.naming, {
      pattern: '{slug}-{suffix}',
      stagingSuffix: '-staging',
    })
    assert.deepEqual(manifest.declaredConfig, { optional: [] })
  })

  it('tolerates unknown fields', () => {
    const m = own()
    m.future = { anything: true }
    m.kit.extra = 'x'
    assert.deepEqual(validateManifest(m).problems, [])
  })

  for (const [what, mutate, expected] of [
    [
      'a schema other than 1',
      m => {
        m.schema = 2
      },
      'schema: must be 1',
    ],
    [
      'a bad kit id',
      m => {
        m.kit.id = 'Bad_Id'
      },
      'kit.id',
    ],
    [
      'a missing appManifest',
      m => {
        delete m.scaffold.appManifest
      },
      'scaffold.appManifest: required',
    ],
    [
      'an absolute path',
      m => {
        m.worker.tomls.staging = '/etc/x.toml'
      },
      'worker.tomls.staging',
    ],
    [
      'a parent path',
      m => {
        m.scaffold.appManifest = '../x.json'
      },
      'scaffold.appManifest',
    ],
    [
      'a lowercase env name',
      m => {
        m.launchProvides.appUrl = 'app_url'
      },
      'launchProvides.appUrl',
    ],
    [
      'a generated secret of another kind',
      m => {
        m.launchProvides.generated = [{ name: 'X', kind: 'uuid' }]
      },
      'launchProvides.generated',
    ],
    [
      'roles as an array',
      m => {
        m.database.roles = ['migrator', 'app']
      },
      'database.roles',
    ],
    [
      'deployer protocol 2',
      m => {
        m.release.deployerProtocol = 2
      },
      'release.deployerProtocol',
    ],
    [
      'a workflow path',
      m => {
        m.release.workflow = '.github/workflows/deploy.yml'
      },
      'release.workflow',
    ],
    [
      'another naming pattern',
      m => {
        m.worker.naming.pattern = '{suffix}-{slug}'
      },
      'worker.naming.pattern',
    ],
    [
      'a health path without /',
      m => {
        m.health.ready = 'api/ready'
      },
      'health.ready',
    ],
    [
      'a missing session block',
      m => {
        delete m.session
      },
      'session: required',
    ],
  ]) {
    it(`refuses ${what}`, () => {
      const m = own()
      mutate(m)
      const { problems, manifest } = validateManifest(m)
      assert.equal(manifest, null)
      assert.ok(
        problems.some(p => p.includes(expected)),
        problems.join('\n')
      )
    })
  }

  it('fillTemplate substitutes and refuses an unknown placeholder', () => {
    assert.equal(fillTemplate('pnpm gate {step}', { step: 'lint' }), 'pnpm gate lint')
    assert.throws(() => fillTemplate('x {nope}', {}), /Unknown placeholder/)
  })
})
