/**
 * scripts/kit-check.mjs. The Rocketflare kit ports these cases to vitest
 * (rocketflare-dev/rocketflare `apps/web/tests/config/kit-check.test.ts`): keep both in step.
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
import { copyRepo, ROOT, runNode } from './helpers.mjs'

const dirs = []
const fresh = () => {
  const dir = copyRepo()
  dirs.push(dir)
  return dir
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const failing = result => result.checks.filter(c => !c.ok).flatMap(c => c.problems)
const slugOf = dir => {
  const m = JSON.parse(readFileSync(path.join(dir, 'launch.kit.json'), 'utf8'))
  try {
    return JSON.parse(readFileSync(path.join(dir, m.scaffold.appManifest), 'utf8')).app.slug
  } catch {
    return m.scaffold.tokens?.slug ?? m.kit.id
  }
}

describe('kit-check on this repository', () => {
  it('conforms (exit 0, every check green)', () => {
    const res = runNode('scripts/kit-check.mjs', ['--json'])
    assert.equal(res.status, 0, res.stdout)
    const report = JSON.parse(res.stdout)
    assert.equal(report.ok, true)
    assert.deepEqual(
      report.checks.map(c => c.id),
      ['manifest', 'files', 'ci', 'release', 'tomls']
    )
    assert.deepEqual(report.warnings, [])
  })

  it('runs the gate list with --exec', () => {
    const report = checkKit(ROOT, { exec: true })
    assert.equal(report.checks.find(c => c.id === 'gate-list')?.ok, true, JSON.stringify(report))
  })

  it('fails --provisioned while the ids are still placeholders', () => {
    const res = runNode('scripts/kit-check.mjs', ['--provisioned'])
    assert.equal(res.status, 1)
    assert.match(res.stdout, /still the placeholder/)
  })

  it('answers a usage error with exit 2', () => {
    assert.equal(runNode('scripts/kit-check.mjs', ['--nope']).status, 2)
  })
})

describe('kit-check finds what breaks the contract', () => {
  const edit = (dir, rel, fn) => {
    const file = path.join(dir, rel)
    writeFileSync(file, fn(readFileSync(file, 'utf8')))
  }

  it('a missing manifest', () => {
    const dir = fresh()
    unlinkSync(path.join(dir, 'launch.kit.json'))
    assert.match(failing(checkKit(dir)).join('\n'), /launch.kit.json: missing/)
  })

  it('a missing must-have file', () => {
    const dir = fresh()
    unlinkSync(path.join(dir, 'scripts/init.mjs'))
    unlinkSync(path.join(dir, 'AGENTS.md'))
    unlinkSync(path.join(dir, 'CLAUDE.md'))
    const problems = failing(checkKit(dir)).join('\n')
    assert.match(problems, /scaffold.init: scripts\/init.mjs does not exist/)
    assert.match(problems, /CLAUDE.md or AGENTS.md/)
  })

  it('an app manifest with "app": null is the kit itself, not a copy', () => {
    const dir = fresh()
    const m = JSON.parse(readFileSync(path.join(dir, 'launch.kit.json'), 'utf8'))
    writeFileSync(
      path.join(dir, m.scaffold.appManifest),
      JSON.stringify({ app: null, kit: { id: m.kit.id, version: '0.0.0', commit: null } })
    )
    const report = checkKit(dir)
    // Only the app manifest is judged here: in a copy (kit.yml runs these tests there too) the
    // tomls carry the copy's names, which the kit's slug then rightly refuses.
    const files = report.checks.find(c => c.id === 'files')
    assert.deepEqual(files.problems, [])
    assert.equal(report.kit.isCopy, false)
    assert.equal(report.kit.slug, m.scaffold.tokens.slug)
  })

  it('a copy whose app manifest lacks the kit id Launch reads', () => {
    const dir = fresh()
    const m = JSON.parse(readFileSync(path.join(dir, 'launch.kit.json'), 'utf8'))
    const app = m.scaffold.appManifest
    writeFileSync(
      path.join(dir, app),
      JSON.stringify({
        app: { slug: m.scaffold.tokens.slug, display: 'X', domain: 'x.test' },
        kit: { version: '0.0.0', commit: null },
      })
    )
    const report = checkKit(dir)
    assert.equal(report.kit.isCopy, true)
    assert.ok(failing(report).includes(`${app}: kit.id missing`), failing(report).join('\n'))
  })

  it('a renamed Gate job', () => {
    const dir = fresh()
    edit(dir, '.github/workflows/ci.yml', t => t.replace('name: Gate', 'name: Checks'))
    assert.match(failing(checkKit(dir)).join('\n'), /no job named "Gate"/)
  })

  it('a deploy workflow without id-token: write', () => {
    const dir = fresh()
    edit(dir, '.github/workflows/deploy.yml', t =>
      t.replaceAll('id-token: write', 'id-token: none')
    )
    assert.match(failing(checkKit(dir)).join('\n'), /id-token: write/)
  })

  it('a hyperdrive binding, a route and a misnamed queue', () => {
    const dir = fresh()
    const slug = slugOf(dir)
    for (const f of ['wrangler.toml', 'wrangler.staging.toml']) {
      edit(dir, `apps/web/${f}`, t => `${t}\n[[hyperdrive]]\nbinding = "HD"\nid = "<HD_ID>"\n`)
    }
    edit(
      dir,
      'apps/web/wrangler.toml',
      t => `routes = ["x.test/*"]\n${t}\n[[queues.producers]]\nbinding = "Q"\nqueue = "jobs"\n`
    )
    const problems = failing(checkKit(dir)).join('\n')
    assert.match(problems, /hyperdrive: not a binding kind Launch provisions/)
    assert.match(problems, /routes: Launch owns/)
    assert.match(
      problems,
      new RegExp(`"jobs" does not follow \\{slug\\}-\\{suffix\\} for slug "${slug}"`)
    )
    assert.match(problems, /differ in shape/)
  })

  it('a real id committed in the kit', () => {
    const dir = fresh()
    edit(dir, 'apps/web/wrangler.toml', t =>
      t.replace(/id = "<[A-Z_]+>"/, 'id = "0123456789abcdef"')
    )
    assert.match(failing(checkKit(dir)).join('\n'), /must be a <PLACEHOLDER>/)
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
    const text = readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8')
    const wf = parseYaml(text.replaceAll('if: always() && ', 'if: '))
    const problems = releaseProblems(wf, { file: 'deploy.yml', environmentInput: 'environment' })
    assert.ok(
      problems.some(p => p.includes('if: always()')),
      problems.join('\n')
    )
  })
})
