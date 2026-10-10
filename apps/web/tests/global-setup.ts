/**
 * Migrate the test database once per run. `scripts/test.mjs` (what `pnpm test` and the gate's
 * `test` step run) picks it and sets DATABASE_URL + DATABASE_DRIVER; without it the database tests
 * fail with a clear message rather than silently skipping.
 */
import { runMigrations } from '../scripts/migrate'

export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) return
  await runMigrations(url, process.env, () => {})
}
