#!/usr/bin/env node
/**
 * `pnpm test` (the gate's `test` step): the scripts' own tests (`node --test scripts/tests`), then
 * the app's vitest suite against a test database. Which database:
 *
 * - **A Neon gate branch** when `TEST_DATABASE_BRANCH` is set — what Launch's ship gate does in a
 *   session (`launch.kit.json` → `ci.testEnv`). Three variables, all required together:
 *   `DATABASE_URL` (the branch), `TEST_DATABASE_BRANCH` (its name, `gate-<short>-<attempt>`) and
 *   `TEST_DATABASE_ENDPOINT` (the `ep-…` id IN that URL — the name is only a claim, the endpoint
 *   binds it to the URL). The suite then runs under `DATABASE_DRIVER=neon`.
 * - **Local Postgres** otherwise: `TEST_DATABASE_URL`, default
 *   `postgres://postgres:postgres@localhost:5521/app_test`, under `DATABASE_DRIVER=postgres`. When
 *   nothing answers there and Docker is available, `docker compose -f docker-compose.test.yml up`
 *   starts it (that is what CI does). A non-local URL is refused: a test run never points at a
 *   database somebody uses.
 *
 * `--scripts` / `--app` run one half. Exit 0 ok, 1 a failure, 2 usage or an unsafe target.
 */
import { spawnSync } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_URL = 'postgres://postgres:postgres@localhost:5521/app_test'
export const GATE_BRANCH_RE = /^gate-[a-z0-9]+-\d+$/

/** The `ep-…` endpoint id of a Neon URL (the `-pooler` suffix ignored), or null. */
export function neonEndpoint(url) {
  try {
    const host = new URL(url).hostname
    if (!host.endsWith('.neon.tech')) return null
    return host.split('.')[0]?.replace(/-pooler$/, '') ?? null
  } catch {
    return null
  }
}

/**
 * Pure: which database the suite runs against, or why it must not run.
 * @returns {{ ok: true, target: 'neon' | 'local', url: string, driver: 'neon' | 'postgres' } | { ok: false, error: string }}
 */
export function testTarget(env) {
  const branch = env.TEST_DATABASE_BRANCH
  if (branch) {
    const url = env.DATABASE_URL ?? ''
    const endpoint = neonEndpoint(url)
    if (!GATE_BRANCH_RE.test(branch)) {
      return {
        ok: false,
        error: `TEST_DATABASE_BRANCH must be gate-<short>-<attempt>, got '${branch}'`,
      }
    }
    if (!endpoint)
      return { ok: false, error: 'TEST_DATABASE_BRANCH is set but DATABASE_URL is not a Neon URL' }
    if (env.TEST_DATABASE_ENDPOINT !== endpoint) {
      return {
        ok: false,
        error: `TEST_DATABASE_ENDPOINT ('${env.TEST_DATABASE_ENDPOINT ?? ''}') is not the endpoint in DATABASE_URL ('${endpoint}')`,
      }
    }
    return { ok: true, target: 'neon', url, driver: 'neon' }
  }
  const url = env.TEST_DATABASE_URL || DEFAULT_URL
  let host
  try {
    host = new URL(url).hostname
  } catch {
    return { ok: false, error: 'TEST_DATABASE_URL is not a URL' }
  }
  if (!['localhost', '127.0.0.1', '::1', 'postgres'].includes(host)) {
    return {
      ok: false,
      error: `TEST_DATABASE_URL points at ${host}; tests only run against a local database or a Neon gate branch`,
    }
  }
  return { ok: true, target: 'local', url, driver: 'postgres' }
}

function reachable(url, timeoutMs = 1500) {
  const u = new URL(url)
  return new Promise(resolve => {
    const socket = net.connect({ host: u.hostname, port: Number(u.port || 5432) })
    const done = ok => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

const run = (cmd, args, env = process.env) =>
  spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env }).status ?? 1

async function main() {
  const argv = process.argv.slice(2)
  const unknown = argv.filter(a => !['--scripts', '--app'].includes(a))
  if (unknown.length) {
    console.error(
      `usage: node scripts/test.mjs [--scripts | --app]  (unknown: ${unknown.join(' ')})`
    )
    process.exit(2)
  }
  const scripts = !argv.includes('--app')
  const appTests = !argv.includes('--scripts')

  if (scripts) {
    console.log('━━ scripts (node --test scripts/tests/**/*.test.mjs)')
    if (run(process.execPath, ['--test', 'scripts/tests/**/*.test.mjs']) !== 0) process.exit(1)
  }
  if (!appTests) return

  const target = testTarget(process.env)
  if (!target.ok) {
    console.error(`✖ ${target.error}`)
    process.exit(2)
  }
  console.log(
    `━━ app (vitest) on ${target.target === 'neon' ? `Neon gate branch ${process.env.TEST_DATABASE_BRANCH}` : 'local Postgres'}`
  )
  if (target.target === 'local' && !(await reachable(target.url))) {
    console.log('test database not answering; starting it (docker-compose.test.yml)')
    if (run('docker', ['compose', '-f', 'docker-compose.test.yml', 'up', '-d', '--wait']) !== 0) {
      console.error(
        '✖ could not start the test database: start Postgres on :5521 or set TEST_DATABASE_URL'
      )
      process.exit(1)
    }
  }
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: target.url,
    DATABASE_DRIVER: target.driver,
    NEON_LOCAL_PROXY: '',
  }
  const status = run('pnpm', ['--filter', './apps/web', 'test'], env)
  // Exit explicitly: a Neon WebSocket the platform never closes must not keep the gate waiting.
  process.exit(status === 0 ? 0 : 1)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) await main()
