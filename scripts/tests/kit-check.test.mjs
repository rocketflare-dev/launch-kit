/**
 * scripts/kit-check.mjs, on fixture kits built in a temp directory (./fixtures/kit-fixture.mjs) —
 * never on this repository: these tests travel into every app made from the kit, whose files differ
 * from the kit's by design (renamed, provisioned). Whether THIS repository conforms is kit.yml's
 * `Kit check` step. The Rocketflare kit ports these cases to vitest (rocketflare-dev/rocketflare
 * `apps/web/tests/config/kit-check.test.ts`): keep both in step.
 */
import assert from 'node:assert/strict'
import { readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import {
  checkKit,
  ciProblems,
  commandTarget,
  releaseProblems,
  tomlProblems,
  tomlShape,
} from '../kit-check.mjs'
import { parseYaml } from '../lib/yaml-lite.mjs'
import {
  FIXTURE_APP_MANIFEST,
  FIXTURE_DEPLOY_YML,
  FIXTURE_TOKENS,
  FIXTURE_TOMLS,
  provisionLikeLaunch,
  writeKitFixture,
} from './fixtures/kit-fixture.mjs'
import { runNode, tempDir } from './helpers.mjs'

const APP = { slug: 'zz-desk', display: 'Zz Desk', domain: 'zz.example' }
const dirs = []
/** The fixture kit (`app` null) or a fresh copy of it named `app`. */
const fixture = (app = null) => {
  const dir = tempDir()
  dirs.push(dir)
  return writeKitFixture(dir, { app })
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const failing = result => result.checks.filter(c => !c.ok).flatMap(c => c.problems)
const check = (dir, args = []) => runNode('scripts/kit-check.mjs', [dir, ...args])
const edit = (dir, rel, fn) => {
  const file = path.join(dir, rel)
  writeFileSync(file, fn(readFileSync(file, 'utf8')))
}

describe('kit-check: the kit', () => {
  it('conforms (exit 0, every check green, no warnings)', () => {
    const res = check(fixture(), ['--json'])
    assert.equal(res.status, 0, res.stdout)
    const report = JSON.parse(res.stdout)
    assert.equal(report.ok, true)
    assert.deepEqual(
      report.checks.map(c => c.id),
      ['manifest', 'files', 'ci', 'release', 'tomls']
    )
    assert.deepEqual(report.warnings, [])
    assert.deepEqual(report.kit, {
      id: FIXTURE_TOKENS.slug,
      slug: FIXTURE_TOKENS.slug,
      isCopy: false,
    })
  })

  it('runs the gate list with --exec', () => {
    const report = checkKit(fixture(), { exec: true })
    assert.equal(report.checks.find(c => c.id === 'gate-list')?.ok, true, JSON.stringify(report))
  })

  it('fails --provisioned while the ids are still placeholders', () => {
    const res = check(fixture(), ['--provisioned'])
    assert.equal(res.status, 1)
    assert.match(res.stdout, /still the placeholder/)
  })

  it('refuses a real id committed in the kit', () => {
    const dir = fixture()
    edit(dir, FIXTURE_TOMLS[0], t => t.replace(/id = "<[A-Z_]+>"/, 'id = "0123456789abcdef"'))
    assert.match(failing(checkKit(dir)).join('\n'), /must be a <PLACEHOLDER> in the kit/)
  })

  it('answers a usage error with exit 2', () => {
    assert.equal(runNode('scripts/kit-check.mjs', ['--nope']).status, 2)
  })
})

describe('kit-check: a copy', () => {
  it('conforms freshly scaffolded, its ids still placeholders, and fails --provisioned', () => {
    const dir = fixture(APP)
    const report = checkKit(dir)
    assert.equal(report.ok, true, JSON.stringify(failing(report)))
    assert.deepEqual(report.kit, { id: FIXTURE_TOKENS.slug, slug: APP.slug, isCopy: true })
    const res = check(dir, ['--provisioned'])
    assert.equal(res.status, 1)
    assert.match(res.stdout, /still the placeholder/)
  })

  it("conforms once Launch's write_config has committed its ids and vars, and passes --provisioned", () => {
    const dir = fixture(APP)
    const ids = provisionLikeLaunch(dir)
    const prod = readFileSync(path.join(dir, FIXTURE_TOMLS[0]), 'utf8')
    assert.equal(ids.length, 4)
    assert.ok(prod.includes(`id = "${ids[0]}"`) && !/<[A-Z0-9_]+>/.test(prod), prod)
    assert.match(prod, /^workers_dev = false$/m)
    assert.match(prod, /^OIDC_ISSUER = "https:\/\/launch\.example\.com"$/m)

    const res = check(dir, ['--json'])
    assert.equal(res.status, 0, res.stdout)
    assert.deepEqual(JSON.parse(res.stdout).warnings, [])
    const provisioned = check(dir, ['--provisioned'])
    assert.equal(provisioned.status, 0, provisioned.stdout)
  })

  it('still holds a provisioned copy to its names and to one shape', () => {
    const dir = fixture(APP)
    provisionLikeLaunch(dir)
    edit(dir, FIXTURE_TOMLS[1], t => t.replace(`"${APP.slug}-files-staging"`, '"files-staging"'))
    edit(dir, FIXTURE_TOMLS[0], t => `${t}\n[[kv_namespaces]]\nbinding = "EXTRA"\nid = "abc"\n`)
    const problems = failing(checkKit(dir, { provisioned: true })).join('\n')
    assert.match(problems, /"files-staging" does not follow/)
    assert.match(problems, /differ in shape/)
  })
})

describe('kit-check finds what breaks the contract', () => {
  it('a missing manifest', () => {
    const dir = fixture()
    unlinkSync(path.join(dir, 'launch.kit.json'))
    assert.match(failing(checkKit(dir)).join('\n'), /launch.kit.json: missing/)
  })

  it('a missing must-have file', () => {
    const dir = fixture()
    unlinkSync(path.join(dir, 'scripts/init.mjs'))
    unlinkSync(path.join(dir, 'CLAUDE.md'))
    const problems = failing(checkKit(dir)).join('\n')
    assert.match(problems, /scaffold.init: scripts\/init.mjs does not exist/)
    assert.match(problems, /CLAUDE.md or AGENTS.md/)
  })

  it('an app manifest with "app": null is the kit itself, not a copy', () => {
    const dir = fixture()
    writeFileSync(
      path.join(dir, FIXTURE_APP_MANIFEST),
      JSON.stringify({
        app: null,
        kit: { id: FIXTURE_TOKENS.slug, version: '0.0.0', commit: null },
      })
    )
    const report = checkKit(dir)
    assert.equal(report.ok, true, JSON.stringify(failing(report)))
    assert.equal(report.kit.isCopy, false)
    assert.equal(report.kit.slug, FIXTURE_TOKENS.slug)
  })

  it('a copy whose app manifest lacks the kit id Launch reads', () => {
    const dir = fixture(APP)
    edit(dir, FIXTURE_APP_MANIFEST, t => {
      const m = JSON.parse(t)
      delete m.kit.id
      return JSON.stringify(m)
    })
    const report = checkKit(dir)
    assert.equal(report.kit.isCopy, true)
    assert.ok(
      failing(report).includes(`${FIXTURE_APP_MANIFEST}: kit.id missing`),
      failing(report).join('\n')
    )
  })

  it('a renamed Gate job', () => {
    const dir = fixture()
    edit(dir, '.github/workflows/ci.yml', t => t.replace('name: Gate', 'name: Checks'))
    assert.match(failing(checkKit(dir)).join('\n'), /no job named "Gate"/)
  })

  it('a deploy workflow without id-token: write', () => {
    const dir = fixture()
    edit(dir, '.github/workflows/deploy.yml', t =>
      t.replaceAll('id-token: write', 'id-token: none')
    )
    assert.match(failing(checkKit(dir)).join('\n'), /id-token: write/)
  })

  it('a hyperdrive binding, a route and a misnamed queue', () => {
    const dir = fixture()
    for (const f of FIXTURE_TOMLS) {
      edit(dir, f, t => `${t}\n[[hyperdrive]]\nbinding = "HD"\nid = "<HD_ID>"\n`)
    }
    edit(
      dir,
      FIXTURE_TOMLS[0],
      t => `routes = ["x.test/*"]\n${t}\n[[queues.producers]]\nbinding = "Q"\nqueue = "jobs"\n`
    )
    const problems = failing(checkKit(dir)).join('\n')
    assert.match(problems, /hyperdrive: not a binding kind Launch provisions/)
    assert.match(problems, /routes: Launch owns/)
    assert.match(
      problems,
      new RegExp(`"jobs" does not follow \\{slug\\}-\\{suffix\\} for slug "${FIXTURE_TOKENS.slug}"`)
    )
    assert.match(problems, /differ in shape/)
  })
})

describe('kit-check rules (pure)', () => {
  it('commandTarget names the file or the script a command runs', () => {
    assert.deepEqual(commandTarget('node scripts/init.mjs {slug}'), {
      kind: 'file',
      file: 'scripts/init.mjs',
    })
    assert.deepEqual(commandTarget('pnpm gate --list --json'), { kind: 'script', script: 'gate' })
    assert.deepEqual(commandTarget('pnpm run db:migrate:ci'), {
      kind: 'script',
      script: 'db:migrate:ci',
    })
    assert.equal(commandTarget('pnpm install --frozen-lockfile'), null)
  })

  it('staging names carry the suffix, production names never do', () => {
    const toml = {
      name: 'acme-staging',
      main: 'x',
      r2_buckets: [{ binding: 'F', bucket_name: 'acme-files' }],
    }
    const problems = tomlProblems(toml, {
      slug: 'acme',
      env: 'staging',
      stagingSuffix: '-staging',
      label: 's',
    })
    assert.deepEqual(problems, [
      's: r2_buckets[0].bucket_name: "acme-files" does not follow {slug}-{suffix}-staging for slug "acme"',
    ])
    const prod = tomlProblems(
      {
        name: 'acme',
        main: 'x',
        workflows: [{ name: 'acme-run-staging', binding: 'W', class_name: 'C' }],
      },
      { slug: 'acme', env: 'production', stagingSuffix: '-staging', label: 'p' }
    )
    assert.equal(prod.length, 1)
  })

  it('ids: placeholders in the kit; placeholders or real ids in a copy; real with --provisioned', () => {
    const at = id => ({ name: 'acme', main: 'x', kv_namespaces: [{ binding: 'K', id }] })
    const o = { slug: 'acme', env: 'production', stagingSuffix: '-staging', label: 'p' }
    assert.equal(tomlProblems(at('<K_ID>'), o).length, 0)
    assert.match(tomlProblems(at('abc123'), o).join(), /must be a <PLACEHOLDER> in the kit/)
    assert.equal(tomlProblems(at('<K_ID>'), { ...o, isCopy: true }).length, 0)
    assert.equal(tomlProblems(at('abc123'), { ...o, isCopy: true }).length, 0)
    for (const isCopy of [false, true]) {
      assert.equal(tomlProblems(at('abc123'), { ...o, isCopy, provisioned: true }).length, 0)
      assert.match(
        tomlProblems(at('<K_ID>'), { ...o, isCopy, provisioned: true }).join(),
        /still the placeholder/
      )
    }
  })

  it('the shape ignores names, ids and var values', () => {
    const p = {
      name: 'acme',
      vars: { A: '1' },
      kv_namespaces: [{ binding: 'K', id: '<A>' }],
      queues: { producers: [{ binding: 'Q', queue: 'acme-jobs' }] },
    }
    const s = {
      name: 'acme-staging',
      vars: { A: '2' },
      kv_namespaces: [{ binding: 'K', id: '<B>' }],
      queues: { producers: [{ binding: 'Q', queue: 'acme-jobs-staging' }] },
    }
    const o = { slug: 'acme', stagingSuffix: '-staging' }
    assert.deepEqual(
      tomlShape(p, { ...o, env: 'production' }),
      tomlShape(s, { ...o, env: 'staging' })
    )
  })

  it('ci.yml must run on pull requests and read the verified variable', () => {
    const wf = parseYaml('on:\n  push:\njobs:\n  gate:\n    name: Gate\n')
    const problems = ciProblems(wf, '', {
      requiredCheck: 'Gate',
      verifiedVariable: 'LAUNCH_GATE_APP_ID',
    })
    assert.equal(problems.length, 2)
  })

  it('the deploy workflow must finish with if: always()', () => {
    const wf = parseYaml(FIXTURE_DEPLOY_YML.replaceAll('if: always() && ', 'if: '))
    const problems = releaseProblems(wf, { file: 'deploy.yml', environmentInput: 'environment' })
    assert.ok(
      problems.some(p => p.includes('if: always()')),
      problems.join('\n')
    )
  })
})
