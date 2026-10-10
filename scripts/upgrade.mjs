#!/usr/bin/env node
/**
 * Port a later kit release into this app (`launch.kit.json` → `upgrade.command`; the upgrade skill,
 * `.claude/skills/upgrade/SKILL.md`, drives it in a Launch upgrade session).
 *
 *   node scripts/upgrade.mjs --to <X.Y.Z> [--apply] [--repo <git url or path>]
 *
 * What it does — a three-way merge of the kit's own change, nothing cleverer:
 *
 * 1. Reads `.launch-app.json`: the kit version this app is on (`kit.version`), and the app's tokens.
 * 2. Fetches the kit's tags `kit.version` and `--to` from the kit repo (`--repo`, else
 *    `kit.repo` in .launch-app.json, else `kit.repo` in launch.kit.json).
 * 3. For every file the kit changed between the two tags (minus the kit's `scaffold.kitOnly`, and
 *    minus README.md / CHANGELOG.md, which are the app's), with the kit's tokens replaced by the
 *    app's on both sides: `git merge-file` of the app's file against the kit's old and new
 *    versions. A file the app never touched takes the kit's new version; a file both changed is
 *    merged, and where they overlap it gets conflict markers. New kit files are added; a file the
 *    kit deleted is deleted only when the app never changed it. The root package.json keeps the
 *    app's version. launch.kit.json is taken verbatim (it is the contract the app now follows).
 * 4. Prints the porting notes (`docs/upgrades/<version>.md` in the kit) for every version crossed.
 * 5. With --apply: writes the result and records the new kit version and commit in
 *    .launch-app.json. Without: prints the plan and writes nothing.
 *
 * It never commits. Exit 0 merged cleanly · 1 error · 2 usage · 3 applied WITH conflicts (resolve
 * every `<<<<<<<` it lists, then run `pnpm install` and `pnpm gate`).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitDirty, matchesAny } from './lib/files.mjs'
import { kitTokens, replaceTokens } from './lib/tokens.mjs'

const VERSION_RE = /^\d+\.\d+\.\d+$/
const APP_OWNED = ['README.md', 'CHANGELOG.md']
const VERBATIM = ['launch.kit.json']

export class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = { to: undefined, apply: false, repo: undefined, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--apply') opts.apply = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--to' || arg === '--repo') {
      const v = argv[++i]
      if (!v) throw new UsageError(`${arg} needs a value`)
      opts[arg.slice(2)] = v
    } else throw new UsageError(`unknown argument '${arg}'`)
  }
  if (!opts.help && !VERSION_RE.test(opts.to ?? '')) throw new UsageError('--to X.Y.Z is required')
  return opts
}

const compareVersions = (a, b) => {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

export function upgrade(root, opts, log = console.log) {
  const git = (args, options = {}) =>
    execFileSync('git', args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1 << 28,
      ...options,
    })
  const show = (ref, file) => {
    try {
      return git(['show', `${ref}:${file}`])
    } catch {
      return null
    }
  }
  const appManifestPath = JSON.parse(readFileSync(path.join(root, 'launch.kit.json'), 'utf8'))
    .scaffold.appManifest
  if (!existsSync(path.join(root, appManifestPath)))
    throw new Error(`${appManifestPath} is missing: this is not an app made from a kit`)
  const appManifest = JSON.parse(readFileSync(path.join(root, appManifestPath), 'utf8'))
  const from = appManifest.kit?.version
  if (!VERSION_RE.test(from ?? '')) throw new Error(`${appManifestPath} kit.version is not X.Y.Z`)
  if (compareVersions(opts.to, from) <= 0)
    throw new Error(`already on kit ${from}; --to must be newer`)
  const ownManifest = JSON.parse(readFileSync(path.join(root, 'launch.kit.json'), 'utf8'))
  const repo = opts.repo ?? appManifest.kit.repo ?? ownManifest.kit.repo
  if (!repo) throw new Error('no kit repository: pass --repo')
  if (opts.apply && gitDirty(root))
    throw new Error('the git tree has uncommitted changes; commit them first')

  log(`kit ${from} → ${opts.to} from ${repo}`)
  git([
    'fetch',
    '--quiet',
    '--no-tags',
    repo,
    `+refs/tags/${from}:refs/kit-upgrade/from`,
    `+refs/tags/${opts.to}:refs/kit-upgrade/to`,
  ])
  const toCommit = git(['rev-parse', 'refs/kit-upgrade/to^{commit}']).toString().trim()

  const kitManifestAt = ref => JSON.parse(show(ref, 'launch.kit.json')?.toString() ?? '{}')
  const tokensAt = ref => kitTokens(kitManifestAt(ref))
  const toManifest = kitManifestAt('refs/kit-upgrade/to')
  const skip = [...(toManifest.scaffold?.kitOnly ?? []), ...APP_OWNED, appManifestPath]
  const app = appManifest.app
  const tokens = { from: tokensAt('refs/kit-upgrade/from'), to: tokensAt('refs/kit-upgrade/to') }

  const changes = git([
    'diff',
    '--name-status',
    '--no-renames',
    'refs/kit-upgrade/from',
    'refs/kit-upgrade/to',
  ])
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [status, file] = line.split('\t')
      return { status, file }
    })
    .filter(c => !matchesAny(c.file, skip))

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'kit-upgrade-'))
  const plan = { updated: [], merged: [], conflicts: [], added: [], deleted: [], kept: [] }
  const writes = []
  const isText = buf => !buf.subarray(0, 8192).includes(0)
  const forApp = (buf, side, file) =>
    buf && isText(buf) && !VERBATIM.includes(file)
      ? Buffer.from(replaceTokens(buf.toString(), tokens[side], app))
      : buf

  try {
    for (const { status, file } of changes) {
      const full = path.join(root, file)
      const ours = existsSync(full) ? readFileSync(full) : null
      let base = forApp(show('refs/kit-upgrade/from', file), 'from', file)
      let theirs = forApp(show('refs/kit-upgrade/to', file), 'to', file)
      if (file === 'package.json' && ours && base && theirs) {
        // The app's version is its own: never merge the kit's.
        const version = JSON.parse(ours.toString()).version
        const pin = b =>
          Buffer.from(b.toString().replace(/("version":\s*")[^"]*(")/, `$1${version}$2`))
        base = pin(base)
        theirs = pin(theirs)
      }
      if (status === 'D') {
        if (ours && base && ours.equals(base)) {
          plan.deleted.push(file)
          writes.push({ file, data: null })
        } else if (ours) plan.kept.push(`${file} (deleted in the kit, changed here: kept)`)
        continue
      }
      if (!ours) {
        if (status === 'A' || !base) {
          plan.added.push(file)
          writes.push({ file, data: theirs })
        } else plan.kept.push(`${file} (changed in the kit, deleted here: left deleted)`)
        continue
      }
      if (base && ours.equals(base)) {
        plan.updated.push(file)
        writes.push({ file, data: theirs })
        continue
      }
      if (ours.equals(theirs)) continue
      if (!base || !isText(ours) || !isText(theirs)) {
        plan.conflicts.push(
          `${file} (binary or added on both sides: kept the app's; the kit's is at refs/kit-upgrade/to)`
        )
        continue
      }
      const [o, b, t] = ['ours', 'base', 'theirs'].map(n => path.join(tmp, n))
      writeFileSync(o, ours)
      writeFileSync(b, base)
      writeFileSync(t, theirs)
      const res = spawnSync('git', [
        'merge-file',
        '-p',
        '-L',
        'app',
        '-L',
        `kit ${from}`,
        '-L',
        `kit ${opts.to}`,
        o,
        b,
        t,
      ])
      if (res.status < 0 || res.status === null || res.status > 127)
        throw new Error(`git merge-file failed on ${file}`)
      writes.push({ file, data: res.stdout })
      if (res.status === 0) plan.merged.push(file)
      else plan.conflicts.push(file)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  for (const [label, list] of Object.entries(plan)) {
    if (list.length) log(`${label} (${list.length}):\n${list.map(f => `  ${f}`).join('\n')}`)
  }

  // The porting notes for every version crossed (from, to].
  const notesPattern = toManifest.upgrade?.notes ?? 'docs/upgrades/{version}.md'
  const versions = git([
    'ls-tree',
    '--name-only',
    'refs/kit-upgrade/to',
    `${path.posix.dirname(notesPattern)}/`,
  ])
    .toString()
    .split('\n')
    .map(f => path.posix.basename(f).replace(/\.md$/, ''))
    .filter(
      v => VERSION_RE.test(v) && compareVersions(v, from) > 0 && compareVersions(v, opts.to) <= 0
    )
    .sort(compareVersions)
  for (const v of versions) {
    const note = show('refs/kit-upgrade/to', notesPattern.replace('{version}', v))
    if (note) log(`\n── porting note ${v} ──\n${note.toString().trim()}`)
  }

  if (opts.apply) {
    for (const { file, data } of writes) {
      const full = path.join(root, file)
      if (data === null) rmSync(full, { force: true })
      else {
        mkdirSync(path.dirname(full), { recursive: true })
        writeFileSync(full, data)
      }
    }
    appManifest.kit = {
      ...appManifest.kit,
      version: opts.to,
      commit: toCommit,
      ...(opts.repo ? { repo: opts.repo } : {}),
    }
    writeFileSync(path.join(root, appManifestPath), `${JSON.stringify(appManifest, null, 2)}\n`)
    log(`\n${appManifestPath}: kit ${opts.to} (${toCommit.slice(0, 7)})`)
  } else log('\n(dry run: nothing written; pass --apply)')
  return plan
}

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    console.error(
      `upgrade: ${err.message}\nusage: node scripts/upgrade.mjs --to X.Y.Z [--apply] [--repo <url>]`
    )
    process.exit(2)
  }
  if (opts.help) {
    console.log('usage: node scripts/upgrade.mjs --to X.Y.Z [--apply] [--repo <url>]')
    return
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let plan
  try {
    plan = upgrade(root, opts)
  } catch (err) {
    console.error(`✖ upgrade: ${err.message}`)
    process.exit(1)
  }
  if (plan.conflicts.length) {
    console.log(
      `\n${opts.apply ? '!' : '·'} ${plan.conflicts.length} conflict(s) to resolve by hand`
    )
    process.exit(opts.apply ? 3 : 0)
  }
  console.log(opts.apply ? '✔ applied. Next: pnpm install && pnpm gate' : '✔ merges cleanly')
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
