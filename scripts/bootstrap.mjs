#!/usr/bin/env node
/**
 * First run on a machine — or in a Launch session's sandbox (`launch.kit.json` → `session.bootstrap`).
 *
 *   node scripts/bootstrap.mjs [--db-url <url>] [--driver neon|postgres] [--no-install]
 *                              [--no-dev] [--yes] [--db-only]
 *
 *   1/5 checks     Node ≥ 24 and pnpm; refuses to run as root unless KIT_ALLOW_ROOT=1
 *   2/5 install    pnpm install --frozen-lockfile --prefer-offline
 *   3/5 database   --db-url: that database, no Docker. Otherwise the local Docker Postgres
 *                  (docker-compose.yml, port DEV_DB_PORT or 5520)
 *   4/5 devvars    apps/web/.dev.vars: APP_URL, the ports, DATABASE_URL, DATABASE_DRIVER and a
 *                  SESSION_SECRET (kept when one exists)
 *   5/5 migrate    pnpm db:migrate
 *   then           pnpm dev (scripts/dev.mjs start), unless --no-dev
 *
 * Never prompts (`--yes` is accepted for callers that always pass it). Environment:
 *   KIT_BOOTSTRAP_SKIP   comma-separated step names to leave out (install, database, devvars,
 *                        migrate); an unknown name is a usage error (`session.env.skip`)
 *   KIT_ALLOW_ROOT=1     run as uid 0 — a sandbox's container is the isolation boundary
 *                        (`session.env.allowRoot`)
 *   DEV_UI_PORT, DEV_API_PORT, DEV_ALLOWED_HOSTS   written into .dev.vars (`session.ports`)
 *
 * Exit 0 ok · 1 a step failed · 2 usage · 3 the environment is refused (Node, root).
 * Node built-ins only: it runs before `pnpm install`.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEV_VARS, devPorts, ROOT, readDevVarsFile, writeDevVarsFile } from './lib/dev-vars.mjs'

export const STEPS = ['checks', 'install', 'database', 'devvars', 'migrate']
export const SKIPPABLE = ['install', 'database', 'devvars', 'migrate']
const TOTAL = STEPS.length

export const USAGE = `usage: node scripts/bootstrap.mjs [--db-url <url>] [--driver neon|postgres]
                                  [--no-install] [--no-dev] [--yes] [--db-only]

  --db-url <url>   use this Postgres (a Neon branch in a Launch session); no Docker
  --driver <d>     neon | postgres (default: neon for a *.neon.tech URL, else postgres)
  --no-install     skip pnpm install (same as KIT_BOOTSTRAP_SKIP=install)
  --no-dev         do not start the dev servers at the end
  --db-only        start the local database and stop
  --yes            accepted; the bootstrap never prompts`

export class UsageError extends Error {}

/** Pure: the options from argv and the environment. Throws UsageError. */
export function parseArgs(argv, env = {}) {
  const opts = { dbUrl: undefined, driver: undefined, dev: true, dbOnly: false, help: false }
  const skip = new Set(
    (env.KIT_BOOTSTRAP_SKIP ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  )
  const unknown = [...skip].filter(s => !SKIPPABLE.includes(s))
  if (unknown.length) {
    throw new UsageError(
      `KIT_BOOTSTRAP_SKIP: unknown step ${unknown.join(', ')} (steps: ${SKIPPABLE.join(', ')})`
    )
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new UsageError(`${arg} needs a value`)
      return v
    }
    if (arg === '--db-url') opts.dbUrl = value()
    else if (arg.startsWith('--db-url=')) opts.dbUrl = arg.slice('--db-url='.length)
    else if (arg === '--driver') opts.driver = value()
    else if (arg.startsWith('--driver=')) opts.driver = arg.slice('--driver='.length)
    else if (arg === '--no-install') skip.add('install')
    else if (arg === '--no-dev') opts.dev = false
    else if (arg === '--db-only') opts.dbOnly = true
    else if (arg === '--yes' || arg === '-y') {
      // never prompts
    } else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new UsageError(`unknown option '${arg}'`)
  }
  if (opts.dbUrl !== undefined && !/^postgres(ql)?:\/\//.test(opts.dbUrl)) {
    throw new UsageError('--db-url must be a postgres:// or postgresql:// URL')
  }
  if (opts.driver !== undefined && !['neon', 'postgres'].includes(opts.driver)) {
    throw new UsageError('--driver must be neon or postgres')
  }
  if (opts.dbOnly && opts.dbUrl)
    throw new UsageError('--db-only starts the LOCAL database; drop --db-url')
  opts.driver ??=
    opts.dbUrl && new URL(opts.dbUrl).hostname.endsWith('.neon.tech') ? 'neon' : 'postgres'
  return { ...opts, skip }
}

const localDbUrl = env => `postgres://postgres:postgres@localhost:${env.DEV_DB_PORT || 5520}/app`

/** Pure: the `.dev.vars` keys the bootstrap sets, given what is there already. */
export function devVarsFor({ dbUrl, driver, ports, existing }) {
  return {
    APP_ENV: 'development',
    APP_URL: `http://localhost:${ports.ui}`,
    DEV_UI_PORT: String(ports.ui),
    DEV_API_PORT: String(ports.api),
    ...(ports.allowedHosts.length ? { DEV_ALLOWED_HOSTS: ports.allowedHosts.join(',') } : {}),
    DATABASE_URL: dbUrl,
    DATABASE_DRIVER: driver,
    SESSION_SECRET: existing.SESSION_SECRET || randomBytes(32).toString('hex'),
    AUTH_OIDC_ONLY: existing.AUTH_OIDC_ONLY ?? 'false',
  }
}

class StepError extends Error {}

const run = (cmd, args, extra = {}) => {
  const { status } = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...extra })
  if (status !== 0) throw new StepError(`${cmd} ${args.join(' ')} exited ${status}`)
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2), process.env)
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    console.error(`bootstrap: ${err.message}\n\n${USAGE}`)
    process.exit(2)
  }
  if (opts.help) {
    console.log(USAGE)
    return
  }
  const done = (n, name, note = '') =>
    console.log(`✔ ${n}/${TOTAL} ${name}${note ? ` — ${note}` : ''}`)
  const skipped = (n, name) => console.log(`✔ ${n}/${TOTAL} ${name} skipped (KIT_BOOTSTRAP_SKIP)`)

  // 1. checks
  const major = Number(process.versions.node.split('.')[0])
  if (major < 24) {
    console.error(`✖ Node ${process.versions.node}: this app needs Node 24 or newer`)
    process.exit(3)
  }
  if (os.userInfo().uid === 0 && process.env.KIT_ALLOW_ROOT !== '1') {
    console.error(
      '✖ refusing to run as root (files would be root-owned). KIT_ALLOW_ROOT=1 overrides.'
    )
    process.exit(3)
  }
  if (spawnSync('pnpm', ['--version'], { stdio: 'ignore' }).status !== 0) {
    console.error('✖ pnpm not found: corepack enable (or npm i -g pnpm@10)')
    process.exit(3)
  }
  done(1, 'checks', `Node ${process.versions.node}`)

  try {
    // 2. install
    if (opts.skip.has('install')) skipped(2, 'install')
    else {
      run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'])
      done(2, 'install')
    }

    // 3. database
    let dbUrl = opts.dbUrl
    if (opts.skip.has('database')) {
      skipped(3, 'database')
      dbUrl ??= readDevVarsFile().DATABASE_URL ?? localDbUrl(process.env)
    } else if (dbUrl) {
      done(3, 'database', `using --db-url (${opts.driver} driver)`)
    } else {
      run('docker', ['compose', '-f', 'docker-compose.yml', 'up', '-d', '--wait'])
      dbUrl = localDbUrl(process.env)
      done(3, 'database', 'local Docker Postgres')
    }
    if (opts.dbOnly) return

    // 4. devvars
    if (opts.skip.has('devvars')) skipped(4, 'devvars')
    else {
      const existing = readDevVarsFile()
      const ports = devPorts(process.env, existing)
      writeDevVarsFile(devVarsFor({ dbUrl, driver: opts.driver, ports, existing }))
      done(4, 'devvars', path.relative(ROOT, DEV_VARS))
    }

    // 5. migrate
    if (opts.skip.has('migrate')) skipped(5, 'migrate')
    else {
      run('pnpm', ['db:migrate'], { env: { ...process.env, DATABASE_DRIVER: opts.driver } })
      done(5, 'migrate')
    }
  } catch (err) {
    if (!(err instanceof StepError)) throw err
    console.error(`✖ ${err.message}`)
    process.exit(1)
  }

  if (!opts.dev) {
    console.log('Ready. Start the app with: pnpm dev')
    return
  }
  run('node', ['scripts/dev.mjs', 'start'])
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) await main()
