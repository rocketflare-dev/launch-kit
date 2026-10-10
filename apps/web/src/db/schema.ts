/**
 * The database schema. `notes` is the example table — replace it with your own. A new table is a
 * change here, then `pnpm db:generate` writes the migration; never edit an applied migration.
 */
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const notes = pgTable('notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  body: text('body').notNull(),
  /** The `sub` (issuer|subject) of the user who wrote it. */
  authorId: text('author_id').notNull(),
  authorName: text('author_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type Note = typeof notes.$inferSelect
