/**
 * Apply the migrations in `./migrations` to DATABASE_URL — `pnpm db:migrate` (reads `.dev.vars`)
 * and `pnpm db:migrate:ci` (the environment: the deploy job's short-lived migrator URL, a test's
 * database). Follows DATABASE_DRIVER: postgres.js over TCP, or the Neon `Pool` over WebSocket where
 * there is no TCP out (a Launch session). A Neon `-pooler` host is rewritten to the direct host:
 * DDL never goes through a transaction pooler.
 */
import { fileURLToPath } from 'node:url'
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-serverless'
import { migrate as migrateNeon } from 'drizzle-orm/neon-serverless/migrator'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { createNeonPool, databaseDriver, routeNeonThroughProxy } from '../src/db/client'

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url).href)

/** `ep-x-pooler.region.aws.neon.tech` → `ep-x.region.aws.neon.tech`. */
export function directNeonHost(url: string): string {
  const u = new URL(url)
  if (u.hostname.endsWith('.neon.tech')) u.hostname = u.hostname.replace(/-pooler(?=\.)/, '')
  return u.toString()
}

export async function runMigrations(
  databaseUrl: string,
  env: { readonly [key: string]: string | undefined } = process.env,
  log: (line: string) => void = console.log
): Promise<void> {
  const url = directNeonHost(databaseUrl)
  if (databaseDriver(env) === 'neon') {
    if (env.NEON_LOCAL_PROXY) routeNeonThroughProxy(env.NEON_LOCAL_PROXY)
    const pool = createNeonPool(url, 1)
    try {
      await migrateNeon(drizzleNeon(pool), { migrationsFolder: MIGRATIONS })
    } finally {
      await pool.end().catch(() => {})
    }
  } else {
    const sql = postgres(url, { max: 1, onnotice: () => {} })
    try {
      await migratePostgres(drizzlePostgres(sql), { migrationsFolder: MIGRATIONS })
    } finally {
      await sql.end({ timeout: 5 })
    }
  }
  log('Migrations applied')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is required')
    process.exit(1)
  }
  runMigrations(url)
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Migration failed:', err instanceof Error ? err.message : err)
      process.exit(1)
    })
}
