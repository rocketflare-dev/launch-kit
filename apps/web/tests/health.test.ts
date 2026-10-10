import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import type { DatabaseHandle } from '../src/db/client'
import { testEnv } from './helpers'

function fakeDb(execute: () => Promise<unknown>) {
  const close = vi.fn(async () => {})
  const handle = { db: { execute }, close } as unknown as DatabaseHandle
  return { handle, close }
}

describe('health routes (launch.kit.json → health)', () => {
  it('GET /api/health answers with the release version and never opens the database', async () => {
    const open = vi.fn()
    const app = createApp({ openDatabase: open })
    const res = await app.request('/api/health', {}, testEnv())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, version: '1.2.3', env: 'production' })
    expect(open).not.toHaveBeenCalled()
  })

  it('GET /api/ready is 200 when SELECT 1 answers, and closes the handle', async () => {
    const { handle, close } = fakeDb(async () => [{ '?column?': 1 }])
    const app = createApp({ openDatabase: () => handle })
    const res = await app.request('/api/ready', {}, testEnv())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, database: 'ok' })
    expect(close).toHaveBeenCalled()
  })

  it('GET /api/ready is 503 when the database does not answer', async () => {
    const { handle } = fakeDb(async () => {
      throw new Error('connection refused to postgres://secret@host')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = createApp({ openDatabase: () => handle })
    const res = await app.request('/api/ready', {}, testEnv())
    expect(res.status).toBe(503)
    const text = await res.text()
    expect(text).toContain('unreachable')
    expect(text).not.toContain('secret')
  })

  it('serves the UI for any other path', async () => {
    const app = createApp({ openDatabase: vi.fn() })
    const res = await app.request('/some/page', {}, testEnv())
    expect(await res.text()).toContain('ui')
  })

  it('answers unknown API paths with a JSON 404', async () => {
    const app = createApp({ openDatabase: vi.fn() })
    const res = await app.request('/api/nope', {}, testEnv())
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found', statusCode: 404 })
  })
})
