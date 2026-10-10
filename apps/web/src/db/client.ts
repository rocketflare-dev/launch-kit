/**
 * Drizzle over one of two drivers, picked by `DATABASE_DRIVER`:
 *
 * - `neon` (what Launch deploys, `launch.kit.json` → `launchProvides.databaseDriver`): the Neon
 *   serverless driver. Queries go over HTTP, one round trip each and no connection held;
 *   `transaction` opens a WebSocket `Pool` on first use, because HTTP cannot run an interactive
 *   transaction. A Worker has no TCP to Postgres, and a Launch session's container has none either.
 * - `postgres` (unset means this): postgres.js over TCP — local Docker Postgres and the tests.
 *
 * One handle per request, closed when the request is done (`app.ts`). This file is the only place
 * the two drivers differ; read a raw `execute()` result through `rows()`.
 */
import { neon, neonConfig, Pool } from '@neondatabase/serverless'
import { drizzle as drizzleNeonHttp } from 'drizzle-orm/neon-http'
import { drizzle as drizzleNeonPool } from 'drizzle-orm/neon-serverless'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>
export type DatabaseDriver = 'neon' | 'postgres'

export interface DatabaseHandle {
  db: Database
  /** Ends the client (and, under `neon`, the transaction pool). Idempotent. */
  close(): Promise<void>
}

export interface DatabaseEnv {
  DATABASE_DRIVER?: string
  DATABASE_URL?: string
  /** Local only: route the neon driver through a proxy in front of a local Postgres. */
  NEON_LOCAL_PROXY?: string
}

export function databaseDriver(env: Pick<DatabaseEnv, 'DATABASE_DRIVER'>): DatabaseDriver {
  const value = env.DATABASE_DRIVER?.trim()
  if (!value) return 'postgres'
  if (value === 'neon' || value === 'postgres') return value
  throw new Error(`DATABASE_DRIVER must be neon or postgres, got "${value}"`)
}

/** Open a handle for one request with the driver and URL `env` selects. */
export function openDatabase(env: DatabaseEnv, options: { max?: number } = {}): DatabaseHandle {
  const url = env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  return databaseDriver(env) === 'neon'
    ? createNeonDatabase(url, { ...options, localProxy: env.NEON_LOCAL_PROXY })
    : createPostgresDatabase(url, options)
}

export function createPostgresDatabase(
  url: string,
  options: { max?: number } = {}
): DatabaseHandle {
  // `prepare: false`: safe behind any transaction-mode pooler. postgres.js connects lazily.
  const client = postgres(url, { max: options.max ?? 1, prepare: false, onnotice: () => {} })
  const db = drizzlePostgres(client, { schema }) as unknown as Database
  let closed: Promise<void> | undefined
  return {
    db,
    close: () => {
      closed ??= client.end({ timeout: 5 }).catch(() => {})
      return closed
    },
  }
}

/** A Neon `Pool` whose dropped idle connections cannot crash the process or the isolate. */
export function createNeonPool(url: string, max = 1): Pool {
  const pool = new Pool({ connectionString: url, max })
  pool.on('error', () => {})
  return pool
}

export function createNeonDatabase(
  url: string,
  options: { max?: number; localProxy?: string } = {}
): DatabaseHandle {
  if (options.localProxy) routeNeonThroughProxy(options.localProxy)
  let pool: Pool | undefined
  let poolDb: Database | undefined
  const transactional = (): Database => {
    if (!poolDb) {
      pool = createNeonPool(url, options.max ?? 1)
      poolDb = drizzleNeonPool(pool, { schema }) as unknown as Database
    }
    return poolDb
  }
  const db = drizzleNeonHttp(neon(url), { schema }) as unknown as Database
  // neon-http's own `transaction` throws; the pool's is a real interactive transaction.
  db.transaction = ((...args: Parameters<Database['transaction']>) =>
    transactional().transaction(...args)) as Database['transaction']
  let closed: Promise<void> | undefined
  return {
    db,
    close: () => {
      closed ??= pool ? pool.end().catch(() => {}) : Promise.resolve()
      return closed
    },
  }
}

/** HTTP queries to `<proxy>/sql`, WebSockets to `<proxy>/v2` (a local Neon proxy). */
export function routeNeonThroughProxy(proxy: string): void {
  const target = new URL(proxy)
  neonConfig.fetchEndpoint = `${target.origin}/sql`
  neonConfig.wsProxy = () => `${target.host}/v2`
  neonConfig.useSecureWebSocket = target.protocol === 'https:'
  neonConfig.pipelineConnect = false
}

/** The rows of a raw `db.execute(sql…)`: postgres.js returns an array, Neon `{ rows }`. */
export function rows<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  const candidate = (result as { rows?: unknown } | null)?.rows
  if (Array.isArray(candidate)) return candidate as T[]
  throw new TypeError('rows(): not a query result')
}
