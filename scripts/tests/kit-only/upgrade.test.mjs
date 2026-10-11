/**
 * scripts/upgrade.mjs end to end: a throwaway kit repository with two tags, an app made from the
 * first by init, then the upgrade to the second — a clean merge, then a conflict.
 *
 * Kit-only (scaffold.kitOnly): the throwaway kit is a copy of THIS repository, which is the kit only
 * in the kit itself — in an app it carries the app's names and whatever files the app kept.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { commitAll, copyRepo, runNode, tempDir } from '../helpers.mjs'

const dirs = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const read = (dir, rel) => readFileSync(path.join(dir, rel), 'utf8')
const write = (dir, rel, text) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  writeFileSync(path.join(dir, rel), text)
}
const setVersion = (dir, v) => {
  const pkg = JSON.parse(read(dir, 'package.json'))
  pkg.version = v
  write(dir, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`)
}
const git = (dir, args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })

function makeKit() {
  const kit = copyRepo()
  dirs.push(kit)
  const manifest = JSON.parse(read(kit, 'launch.kit.json'))
  rmSync(path.join(kit, manifest.scaffold.appManifest), { force: true })
  setVersion(kit, '1.0.0')
  commitAll(kit, 'kit 1.0.0', true)
  git(kit, ['-c', 'tag.gpgSign=false', 'tag', '1.0.0'])
  return { kit, tokens: manifest.scaffold.tokens }
}

function makeApp(kit) {
  const app = tempDir()
  dirs.push(app)
  execFileSync('git', ['clone', '-q', '--branch', '1.0.0', kit, app], { stdio: 'ignore' })
  const res = runNode(
    'scripts/init.mjs',
    ['acme', 'Acme', '--domain', 'acme.example', '--skip-install', '--force'],
    { cwd: app }
  )
  assert.equal(res.status, 0, res.stderr)
  commitAll(app, 'init')
  return app
}

describe('upgrade', () => {
  const { kit, tokens } = makeKit()
  // Kit 1.1.0: a change to app.ts naming the kit's slug, a new file, a porting note.
  const appTs = 'apps/web/src/app.ts'
  write(kit, appTs, `${read(kit, appTs)}\n// kit 1.1.0: ${tokens.slug}-thing\n`)
  write(kit, 'apps/web/src/added.ts', `export const NAME = '${tokens.slug}'\n`)
  write(kit, 'docs/upgrades/1.1.0.md', '# 1.1.0\n\nRun pnpm install.\n')
  setVersion(kit, '1.1.0')
  commitAll(kit, 'kit 1.1.0')
  git(kit, ['-c', 'tag.gpgSign=false', 'tag', '1.1.0'])

  it('plans without writing, then merges the kit change into the app with its names', () => {
    const app = makeApp(kit)
    // The app's own change, elsewhere in the same file.
    write(app, appTs, `// the app's own line\n${read(app, appTs)}`)
    commitAll(app, 'app change')

    const dry = runNode('scripts/upgrade.mjs', ['--to', '1.1.0', '--repo', kit], { cwd: app })
    assert.equal(dry.status, 0, dry.stderr)
    assert.match(dry.stdout, /merged \(1\)/)
    assert.match(dry.stdout, /porting note 1\.1\.0/)
    assert.ok(!existsSync(path.join(app, 'apps/web/src/added.ts')))

    const res = runNode('scripts/upgrade.mjs', ['--to', '1.1.0', '--repo', kit, '--apply'], {
      cwd: app,
    })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    const merged = read(app, appTs)
    assert.match(merged, /^\/\/ the app's own line/)
    assert.match(merged, /\/\/ kit 1\.1\.0: acme-thing$/m)
    assert.equal(read(app, 'apps/web/src/added.ts'), "export const NAME = 'acme'\n")
    assert.equal(JSON.parse(read(app, 'package.json')).version, '0.1.0')
    const manifest = JSON.parse(read(kit, 'launch.kit.json'))
    const appManifest = JSON.parse(read(app, manifest.scaffold.appManifest))
    assert.equal(appManifest.kit.version, '1.1.0')
    assert.match(appManifest.kit.commit, /^[0-9a-f]{40}$/)
  })

  it('leaves conflict markers and exits 3 when both changed the same lines', () => {
    const app = makeApp(kit)
    write(app, appTs, `${read(app, appTs)}\n// the app's own last line\n`)
    commitAll(app, 'app change')
    const res = runNode('scripts/upgrade.mjs', ['--to', '1.1.0', '--repo', kit, '--apply'], {
      cwd: app,
    })
    assert.equal(res.status, 3, res.stdout + res.stderr)
    assert.match(res.stdout, /conflicts \(1\)/)
    assert.match(read(app, appTs), /^<<<<<<< app$/m)
  })

  it('refuses a version that is not newer, and bad arguments', () => {
    const app = makeApp(kit)
    assert.equal(
      runNode('scripts/upgrade.mjs', ['--to', '1.0.0', '--repo', kit], { cwd: app }).status,
      1
    )
    assert.equal(runNode('scripts/upgrade.mjs', ['--to', 'latest'], { cwd: app }).status, 2)
  })
})
