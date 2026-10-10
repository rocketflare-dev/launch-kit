/**
 * scripts/init.mjs in a throwaway copy of this repository: the rename, the kit-only files, the app
 * manifest, the version restart, idempotence, and the refusals. Then the copy must still conform.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { parseArgs, replaceTokens, UsageError } from '../init.mjs'
import { checkKit } from '../kit-check.mjs'
import { gitDirty } from '../lib/files.mjs'
import { commitAll, copyRepo, runNode } from './helpers.mjs'

const dirs = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const read = (dir, rel) => readFileSync(path.join(dir, rel), 'utf8')

describe('init', () => {
  const dir = copyRepo({ git: true })
  dirs.push(dir)
  const manifestText = read(dir, 'launch.kit.json')
  const manifest = JSON.parse(manifestText)
  const existingApp = existsSync(path.join(dir, manifest.scaffold.appManifest))
    ? JSON.parse(read(dir, manifest.scaffold.appManifest))
    : null
  const from = existingApp?.app ?? manifest.scaffold.tokens
  const kitVersion = JSON.parse(read(dir, 'package.json')).version
  const args = ['zz-init-probe', 'Zz Init Probe', '--domain', 'zz-probe.example', '--skip-install']

  it('renames the copy, writes the app manifest and deletes the kit-only files', () => {
    const res = runNode('scripts/init.mjs', args, { cwd: dir })
    assert.equal(res.status, 0, res.stderr)

    const prod = read(dir, 'apps/web/wrangler.toml')
    const staging = read(dir, 'apps/web/wrangler.staging.toml')
    assert.match(prod, /^name = "zz-init-probe"$/m)
    assert.match(staging, /^name = "zz-init-probe-staging"$/m)
    assert.match(prod, /APP_URL = "https:\/\/app\.zz-probe\.example"/)
    assert.match(prod, /APP_NAME = "Zz Init Probe"/)
    assert.ok(!prod.includes(from.slug) && !prod.includes(from.domain))
    assert.equal(JSON.parse(read(dir, 'apps/web/package.json')).name, '@zz-init-probe/web')
    // The contract keeps describing the kit.
    assert.equal(read(dir, 'launch.kit.json'), manifestText)

    const app = JSON.parse(read(dir, manifest.scaffold.appManifest))
    assert.deepEqual(app.app, {
      slug: 'zz-init-probe',
      display: 'Zz Init Probe',
      domain: 'zz-probe.example',
    })
    if (!existingApp) {
      assert.equal(app.kit.id, manifest.kit.id)
      assert.equal(app.kit.version, kitVersion)
      assert.match(app.kit.commit, /^[0-9a-f]{40}$/)
      assert.equal(JSON.parse(read(dir, 'package.json')).version, '0.1.0')
      assert.equal(read(dir, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n')
    }
    for (const rel of ['.github/workflows/kit.yml', 'FORKING.md'])
      assert.ok(!existsSync(path.join(dir, rel)), rel)
  })

  it('leaves a copy that still conforms', () => {
    const report = checkKit(dir)
    assert.equal(report.ok, true, JSON.stringify(report.checks.filter(c => !c.ok)))
    assert.equal(report.kit.isCopy, true)
    assert.equal(report.kit.slug, 'zz-init-probe')
  })

  it('refuses a dirty tree without --force', () => {
    assert.equal(gitDirty(dir), true)
    const res = runNode('scripts/init.mjs', args, { cwd: dir })
    assert.equal(res.status, 1)
    assert.match(res.stderr, /uncommitted changes/)
  })

  it('is idempotent: the same arguments again change nothing', () => {
    commitAll(dir, 'init')
    const res = runNode('scripts/init.mjs', [...args, '--force'], { cwd: dir })
    assert.equal(res.status, 0, res.stderr)
    assert.equal(gitDirty(dir), false)
  })

  it('renames the app again from its own names', () => {
    const res = runNode(
      'scripts/init.mjs',
      ['beta-desk', '--domain', 'beta.example', '--skip-install'],
      { cwd: dir }
    )
    assert.equal(res.status, 0, res.stderr)
    assert.match(read(dir, 'apps/web/wrangler.staging.toml'), /^name = "beta-desk-staging"$/m)
    const app = JSON.parse(read(dir, manifest.scaffold.appManifest))
    assert.equal(app.app.display, 'Beta Desk')
    assert.equal(checkKit(dir).ok, true)
  })

  it('answers bad arguments with exit 2', () => {
    for (const bad of [[], ['Bad_Slug'], ['ok-slug', '--domain', 'nodot'], ['ok-slug', '--what']]) {
      assert.equal(runNode('scripts/init.mjs', bad, { cwd: dir }).status, 2, bad.join(' '))
    }
  })
})

describe('init rules (pure)', () => {
  const from = { slug: 'launch-kit', display: 'Launch Kit', domain: 'launch-kit.dev' }
  const to = { slug: 'acme', display: 'Acme', domain: 'acme.com' }

  it('replaces the domain, the display name and the slug as a name or prefix', () => {
    assert.equal(
      replaceTokens(
        'name = "launch-kit-staging" APP_URL = "https://app.launch-kit.dev" "@launch-kit/web" Launch Kit',
        from,
        to
      ),
      'name = "acme-staging" APP_URL = "https://app.acme.com" "@acme/web" Acme'
    )
  })

  it('never rewrites a repository path or a longer word', () => {
    const text = 'github.com/rocketflare-dev/launch-kit.git launch-kitchen my-launch-kit'
    assert.equal(replaceTokens(text, from, to), text)
  })

  it('parseArgs defaults the display name and the domain', () => {
    assert.deepEqual(
      (({ slug, display, domain }) => ({ slug, display, domain }))(parseArgs(['acme-portal'])),
      { slug: 'acme-portal', display: 'Acme Portal', domain: 'acme-portal.example.com' }
    )
    assert.throws(() => parseArgs(['a']), UsageError)
  })
})
