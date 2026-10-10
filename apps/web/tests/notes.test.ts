/**
 * The example resource against a real database: local Postgres, or a Neon gate branch when the
 * gate runs in Launch (scripts/test.mjs). Each test cleans up the rows it made.
 */
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { type DatabaseHandle, openDatabase } from '../src/db/client'
import { cookiesOf, testEnv } from './helpers'

const env = () =>
  testEnv({
    APP_ENV: 'development',
    APP_URL: 'http://localhost:3000',
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_DRIVER: process.env.DATABASE_DRIVER,
    NEON_LOCAL_PROXY: process.env.NEON_LOCAL_PROXY,
  })

const ORIGIN = 'http://localhost:3000'
const handles: DatabaseHandle[] = []
const app = createApp({
  openDatabase: e => {
    const h = openDatabase(e)
    handles.push(h)
    return h
  },
})

async function signIn(email: string): Promise<string> {
  const res = await app.request(`/auth/dev-login?email=${email}`, {}, env())
  return cookiesOf(res)
}

describe('notes (database)', () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set: run the tests with `pnpm test` (scripts/test.mjs)')
    }
  })
  afterAll(async () => {
    await Promise.all(handles.map(h => h.close()))
  })

  it('GET /api/ready reaches the database', async () => {
    const res = await app.request('/api/ready', {}, env())
    expect(res.status).toBe(200)
  })

  it('creates, lists and deletes a note; only its author may delete it', async () => {
    const ada = await signIn('ada@example.test')
    const bob = await signIn('bob@example.test')
    const body = `note ${crypto.randomUUID()}`
    const json = { 'content-type': 'application/json' }

    const created = await app.request(
      '/api/notes',
      { method: 'POST', headers: { ...json, cookie: ada }, body: JSON.stringify({ body }) },
      env()
    )
    expect(created.status).toBe(201)
    const { note } = (await created.json()) as { note: { id: string; body: string } }
    expect(note.body).toBe(body)

    const list = await app.request('/api/notes', { headers: { cookie: bob } }, env())
    const { notes } = (await list.json()) as { notes: { id: string }[] }
    expect(notes.map(n => n.id)).toContain(note.id)

    const denied = await app.request(
      `/api/notes/${note.id}`,
      { method: 'DELETE', headers: { cookie: bob, origin: ORIGIN } },
      env()
    )
    expect(denied.status).toBe(403)

    const deleted = await app.request(
      `/api/notes/${note.id}`,
      { method: 'DELETE', headers: { cookie: ada, origin: ORIGIN } },
      env()
    )
    expect(deleted.status).toBe(200)
    const again = await app.request(
      `/api/notes/${note.id}`,
      { method: 'DELETE', headers: { cookie: ada, origin: ORIGIN } },
      env()
    )
    expect(again.status).toBe(404)
  })

  it('refuses a cross-site write', async () => {
    const ada = await signIn('ada@example.test')
    const res = await app.request(
      '/api/notes',
      {
        method: 'POST',
        headers: { 'content-type': 'text/plain', cookie: ada, origin: 'https://evil.test' },
        body: JSON.stringify({ body: 'x' }),
      },
      env()
    )
    expect(res.status).toBe(403)
  })

  it('refuses an empty note and a signed-out caller', async () => {
    const ada = await signIn('ada@example.test')
    const bad = await app.request(
      '/api/notes',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: ada },
        body: JSON.stringify({ body: '  ' }),
      },
      env()
    )
    expect(bad.status).toBe(400)
    expect((await app.request('/api/notes', {}, env())).status).toBe(401)
  })

  it('runs an interactive transaction (the neon driver opens its WebSocket pool for this)', async () => {
    const handle = openDatabase(env())
    handles.push(handle)
    const result = await handle.db.transaction(async tx => tx.execute(sql`select 1 as one`))
    expect(result).toBeTruthy()
  })
})
