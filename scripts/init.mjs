#!/usr/bin/env node
/**
 * Make a fresh copy of the kit into an app (`launch.kit.json` → `scaffold.init`; Launch runs it on
 * every new app, and a person can run it by hand on a clone):
 *
 *   node scripts/init.mjs <slug> ["Display Name"] [--domain <apex>] [--force] [--skip-install] [--dry-run]
 *
 * 1. Refuses a dirty git tree unless --force.
 * 2. Replaces the kit's tokens (`scaffold.tokens` in launch.kit.json — slug, display name, domain)
 *    in every text file, in that order: domain, display, slug. The slug is replaced where it stands
 *    alone or as a name prefix (`<slug>-staging`, `@<slug>/web`), never after a `/`, `.`, `-` or a
 *    word character (a repo path such as `owner/<slug>` keeps naming the kit). launch.kit.json itself is not rewritten:
 *    it still describes the kit the copy came from.
 * 3. Deletes `scaffold.kitOnly` (the kit's own CI and tests, FORKING.md).
 * 4. Writes the app manifest (`scaffold.appManifest`, .launch-app.json): `app {slug, display,
 *    domain}` and `kit {id, name, version, commit}` — the kit version and commit this copy came from.
 * 5. Restarts the app's version at 0.1.0, empties CHANGELOG.md and writes a short README.md.
 * 6. `pnpm install --no-frozen-lockfile` unless --skip-install.
 *
 * Idempotent: on a copy that already has its app manifest, the tokens it replaces are the copy's
 * own (so re-running with the same arguments changes nothing, and different ones rename the app),
 * and the kit provenance and the app's version are kept.
 *
 * Exit 0 ok · 1 error (dirty tree, a failed install) · 2 usage. Node built-ins only.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitDirty, gitHead, isBinary, matchesAny, repoFiles } from './lib/files.mjs'
import { kitTokens, replaceTokens } from './lib/tokens.mjs'

export { replaceTokens }

export const USAGE = `usage: node scripts/init.mjs <slug> ["Display Name"] [--domain <apex>] [--force] [--skip-install] [--dry-run]

  <slug>            lowercase letters, digits and dashes (3-40), e.g. acme-portal
  "Display Name"    default: the slug in Title Case
  --domain <apex>   the app's domain, e.g. acme.com (default: <slug>.example.com)
  --force           run on a dirty git tree
  --skip-install    do not run pnpm install afterwards
  --dry-run         print what would change; write nothing`

const SLUG_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

export class UsageError extends Error {}

const titleCase = slug =>
  slug
    .split('-')
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(' ')

/** Pure: the options from argv. Throws UsageError. */
export function parseArgs(argv) {
  const opts = { force: false, install: true, dryRun: false, domain: undefined, help: false }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--force') opts.force = true
    else if (arg === '--skip-install') opts.install = false
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--domain') {
      opts.domain = argv[++i]
      if (!opts.domain) throw new UsageError('--domain needs a value')
    } else if (arg.startsWith('--domain=')) opts.domain = arg.slice('--domain='.length)
    else if (arg.startsWith('-')) throw new UsageError(`unknown option '${arg}'`)
    else positional.push(arg)
  }
  if (opts.help) return opts
  if (positional.length < 1 || positional.length > 2)
    throw new UsageError('expected <slug> ["Display Name"]')
  const [slug, display] = positional
  if (!SLUG_RE.test(slug))
    throw new UsageError(`slug '${slug}': lowercase letters, digits and dashes (3-40)`)
  const name = (display ?? titleCase(slug)).trim()
  if (!name || name.length > 80 || /[\r\n]/.test(name))
    throw new UsageError('display name: 1-80 characters, one line')
  const domain = (opts.domain ?? `${slug}.example.com`).toLowerCase()
  if (!DOMAIN_RE.test(domain))
    throw new UsageError(`domain '${domain}' does not look like example.com`)
  return { ...opts, slug, display: name, domain }
}

/**
 * Paths never rewritten: the contract describes the kit, the lockfile is regenerated, the protocol
 * reference is the kit's, and the scripts' tests build their own fixtures from literal tokens.
 */
const NEVER_REWRITE = ['launch.kit.json', 'pnpm-lock.yaml', 'docs/DEPLOYER.md', 'scripts/tests/**']

export function appReadme({ display, slug }, kit) {
  return `# ${display}

Made from the ${kit.name} ${kit.version} (\`${kit.id}\`). How it works and the rules for changing it:
[CLAUDE.md](CLAUDE.md). The kit provenance is in \`.launch-app.json\`.

\`\`\`bash
pnpm bootstrap   # first run: install, local Postgres, .dev.vars, migrate, start
pnpm dev         # UI http://localhost:3000, API http://localhost:3001
pnpm gate        # lint, typecheck, test, build: what CI and Launch run
\`\`\`

Slug: \`${slug}\`.
`
}

export function init(root, opts, log = console.log) {
  const read = rel => readFileSync(path.join(root, rel), 'utf8')
  const manifest = JSON.parse(read('launch.kit.json'))
  const appManifestPath = manifest.scaffold.appManifest
  const existing = existsSync(path.join(root, appManifestPath))
    ? JSON.parse(read(appManifestPath))
    : null

  const dirty = gitDirty(root)
  if (dirty && !opts.force && !opts.dryRun) {
    throw new Error('the git tree has uncommitted changes; commit them or pass --force')
  }

  const from = existing?.app ?? kitTokens(manifest)
  const to = { slug: opts.slug, display: opts.display, domain: opts.domain }
  const kitOnly = manifest.scaffold.kitOnly ?? []

  // 1. tokens
  const changed = []
  for (const rel of repoFiles(root)) {
    if (matchesAny(rel, NEVER_REWRITE) || matchesAny(rel, kitOnly) || rel === appManifestPath)
      continue
    const full = path.join(root, rel)
    if (!existsSync(full) || isBinary(full)) continue
    const before = readFileSync(full, 'utf8')
    const after = replaceTokens(before, from, to)
    if (after !== before) {
      changed.push(rel)
      if (!opts.dryRun) writeFileSync(full, after)
    }
  }
  log(
    `${opts.dryRun ? 'would rewrite' : 'rewrote'} ${changed.length} file(s): ${from.slug} → ${to.slug}`
  )

  // 2. kit-only files
  const removed = repoFiles(root).filter(rel => matchesAny(rel, kitOnly))
  if (!opts.dryRun) for (const rel of removed) rmSync(path.join(root, rel), { force: true })
  if (removed.length)
    log(`${opts.dryRun ? 'would delete' : 'deleted'} ${removed.length} kit-only file(s)`)

  // 3. app manifest, version, changelog, readme
  const rootPackage = JSON.parse(read('package.json'))
  const kit = existing?.kit ?? {
    id: manifest.kit.id,
    name: manifest.kit.name,
    ...(manifest.kit.repo ? { repo: manifest.kit.repo } : {}),
    version: rootPackage.version,
    commit: gitHead(root),
  }
  const appManifest = {
    $comment:
      'Which kit this app came from, and what it is called. Launch and `pnpm kit:upgrade` read it; do not delete it. No secrets.',
    app: to,
    kit,
  }
  if (!opts.dryRun) {
    writeFileSync(path.join(root, appManifestPath), `${JSON.stringify(appManifest, null, 2)}\n`)
    if (!existing) {
      rootPackage.version = '0.1.0'
      writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(rootPackage, null, 2)}\n`)
      writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n')
      writeFileSync(path.join(root, 'README.md'), appReadme(to, kit))
    }
  }
  log(
    `${appManifestPath}: ${to.slug} from ${kit.id} ${kit.version}${kit.commit ? ` (${kit.commit.slice(0, 7)})` : ''}`
  )
  return { changed, removed, appManifest }
}

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    console.error(`init: ${err.message}\n\n${USAGE}`)
    process.exit(2)
  }
  if (opts.help) {
    console.log(USAGE)
    return
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  try {
    init(root, opts)
  } catch (err) {
    console.error(`✖ init: ${err.message}`)
    process.exit(1)
  }
  if (opts.install && !opts.dryRun) {
    const { status } = spawnSync('pnpm', ['install', '--no-frozen-lockfile'], {
      cwd: root,
      stdio: 'inherit',
    })
    if (status !== 0) {
      console.error('✖ pnpm install failed')
      process.exit(1)
    }
  }
  console.log(`✔ ${opts.display} (${opts.slug}) is ready. Next: pnpm bootstrap`)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
