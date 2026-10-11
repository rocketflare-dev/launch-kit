/**
 * The Hono app: the API under `/api`, sign-in under `/auth`, everything else the static UI
 * (`[assets]`, `dist/ui`). Routes Launch relies on — do not move them without changing
 * `launch.kit.json` in the same commit:
 *
 *   GET /api/health   liveness: 200 with the release version, no database (`health.live`)
 *   GET /api/ready    readiness: 200 only when `SELECT 1` answers (`health.ready`)
 *   GET /auth/login   OIDC sign-in (`launchProvides.oidc`); `AUTH_OIDC_ONLY=true` makes it the only way
 *   GET /auth/callback  where sign-in returns (`launchProvides.oidc.callbackPath`, `auth/paths.ts`)
 *
 * `createApp(deps)` takes the database opener so tests can hand it a fake.
 */
import { and, desc, eq, sql } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { authorizationUrl, completeSignIn, randomToken } from './auth/oidc'
import { OIDC_CALLBACK_PATH } from './auth/paths'
import {
  endSession,
  readSession,
  type SessionUser,
  startSession,
  takeFlow,
  writeFlow,
} from './auth/session'
import { type AppConfig, devLoginAllowed, loadConfig, oidcConfigured } from './config'
import { type Database, type DatabaseHandle, openDatabase } from './db/client'
import { notes } from './db/schema'
import type { Env } from './env'
import { rateLimited } from './rate-limit'

export interface AppDeps {
  openDatabase: (env: Env) => DatabaseHandle
}

type AppEnv = {
  Bindings: Env
  Variables: { config: AppConfig; user: SessionUser | null; db: Database }
}

const fail = (c: Context, statusCode: 400 | 401 | 403 | 404 | 429 | 500 | 503, error: string) =>
  c.json({ error, statusCode }, statusCode)

/** Run `p` after the response when the runtime allows it (a Worker), or now (a test). */
function afterResponse(c: Context, p: Promise<unknown>): Promise<unknown> | undefined {
  try {
    c.executionCtx.waitUntil(p)
    return undefined
  } catch {
    return p
  }
}

const noteInput = z.object({ body: z.string().trim().min(1).max(2000) })

export function createApp(
  deps: AppDeps = { openDatabase: env => openDatabase(env) }
): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    const config = loadConfig(c.env)
    c.set('config', config)
    c.set('user', await readSession(c, config).catch(() => null))
    await next()
  })

  // Writes must come from the app's own origin (APP_URL).
  app.use(
    '/api/*',
    csrf({ origin: (origin, c) => origin === new URL(c.get('config').APP_URL).origin })
  )
  app.use('/auth/logout', csrf({ origin: (o, c) => o === new URL(c.get('config').APP_URL).origin }))

  /** One database handle for the request, closed after it. */
  const withDb = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const handle = deps.openDatabase(c.env)
    c.set('db', handle.db)
    try {
      await next()
    } finally {
      await afterResponse(c, handle.close())
    }
  }

  const requireUser = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    if (!c.get('user')) return fail(c, 401, 'Sign in first')
    await next()
  }

  // ---- health (launch.kit.json → health) ---------------------------------------------------

  /** Liveness: the Worker answers, and which release it runs. Never touches the database. */
  app.get('/api/health', c => {
    const cfg = c.get('config')
    return c.json({ ok: true, name: cfg.APP_NAME, version: cfg.RELEASE_VERSION, env: cfg.APP_ENV })
  })

  /** Readiness: the database answers `SELECT 1`. 503 otherwise, with no detail leaked. */
  app.get('/api/ready', withDb, async c => {
    try {
      await c.get('db').execute(sql`select 1`)
      return c.json({ ok: true, database: 'ok' })
    } catch (err) {
      console.error('ready: database check failed', err instanceof Error ? err.message : err)
      return c.json({ ok: false, database: 'unreachable', statusCode: 503 }, 503)
    }
  })

  // ---- sign-in ------------------------------------------------------------------------------

  /** Which sign-in methods this deployment offers (the UI's sign-in buttons). */
  app.get('/api/auth/methods', c => {
    const cfg = c.get('config')
    return c.json({ oidc: oidcConfigured(cfg), dev: devLoginAllowed(cfg) })
  })

  app.use('/auth/*', async (c, next) => {
    const client = c.req.header('cf-connecting-ip') ?? 'local'
    if (await rateLimited(c.env.RATE_LIMIT_KV, 'auth', client)) {
      return fail(c, 429, 'Too many sign-in attempts; wait a minute')
    }
    await next()
  })

  const redirectUri = (cfg: AppConfig) => new URL(OIDC_CALLBACK_PATH, cfg.APP_URL).toString()
  const oidcSettings = (cfg: AppConfig) => ({
    issuer: cfg.OIDC_ISSUER ?? '',
    clientId: cfg.OIDC_CLIENT_ID ?? '',
    clientSecret: cfg.OIDC_CLIENT_SECRET,
  })

  app.get('/auth/login', async c => {
    const cfg = c.get('config')
    if (!oidcConfigured(cfg)) {
      if (devLoginAllowed(cfg)) return c.redirect('/?signin=dev')
      return fail(c, 503, 'Sign-in is not configured (OIDC_ISSUER / OIDC_CLIENT_ID)')
    }
    const flow = { state: randomToken(), verifier: randomToken(), nonce: randomToken() }
    const url = await authorizationUrl(oidcSettings(cfg), redirectUri(cfg), flow)
    await writeFlow(c, cfg, flow)
    return c.redirect(url.toString())
  })

  app.get(OIDC_CALLBACK_PATH, async c => {
    const cfg = c.get('config')
    if (!oidcConfigured(cfg)) return fail(c, 404, 'OIDC is not configured')
    const flow = await takeFlow(c, cfg)
    const state = c.req.query('state')
    const code = c.req.query('code')
    if (c.req.query('error')) return fail(c, 401, `Sign-in refused: ${c.req.query('error')}`)
    if (!flow || !state || state !== flow.state || !code) {
      return fail(c, 400, 'Sign-in expired or was tampered with; try again')
    }
    try {
      const user = await completeSignIn(
        oidcSettings(cfg),
        redirectUri(cfg),
        code,
        flow.verifier,
        flow.nonce
      )
      await startSession(c, cfg, {
        id: user.id,
        email: user.emailVerified ? user.email : null,
        name: user.name ?? user.email,
      })
      return c.redirect('/')
    } catch (err) {
      console.error('oidc callback failed', err instanceof Error ? err.message : err)
      return fail(c, 401, 'Sign-in failed')
    }
  })

  /** Local development only (`APP_ENV=development` and not `AUTH_OIDC_ONLY`): sign in as anyone. */
  app.get('/auth/dev-login', async c => {
    const cfg = c.get('config')
    if (!devLoginAllowed(cfg)) return fail(c, 404, 'Not found')
    const email = (c.req.query('email') ?? 'dev@example.com').trim().toLowerCase()
    await startSession(c, cfg, { id: `dev|${email}`, email, name: email })
    return c.redirect('/')
  })

  app.post('/auth/logout', c => {
    endSession(c, c.get('config'))
    return c.json({ ok: true })
  })

  /** Who is signed in. 401 when nobody is. */
  app.get('/api/me', requireUser, c => {
    const cfg = c.get('config')
    const user = c.get('user') as SessionUser
    const admin = Boolean(user.email && cfg.BOOTSTRAP_ADMIN_EMAILS.includes(user.email))
    return c.json({ id: user.id, email: user.email, name: user.name, admin })
  })

  // ---- the example resource: notes (replace with your own) -----------------------------------

  app.get('/api/notes', requireUser, withDb, async c => {
    const list = await c.get('db').select().from(notes).orderBy(desc(notes.createdAt)).limit(100)
    return c.json({ notes: list })
  })

  app.post('/api/notes', requireUser, withDb, async c => {
    const parsed = noteInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return fail(c, 400, 'body: 1-2000 characters')
    const user = c.get('user') as SessionUser
    const [note] = await c
      .get('db')
      .insert(notes)
      .values({ body: parsed.data.body, authorId: user.id, authorName: user.name })
      .returning()
    return c.json({ note }, 201)
  })

  app.delete('/api/notes/:id', requireUser, withDb, async c => {
    const id = c.req.param('id') ?? ''
    if (!z.string().uuid().safeParse(id).success) return fail(c, 404, 'No such note')
    const user = c.get('user') as SessionUser
    const db = c.get('db')
    const [note] = await db.select({ authorId: notes.authorId }).from(notes).where(eq(notes.id, id))
    if (!note) return fail(c, 404, 'No such note')
    if (note.authorId !== user.id) return fail(c, 403, 'Not your note')
    await db.delete(notes).where(and(eq(notes.id, id), eq(notes.authorId, user.id)))
    return c.json({ ok: true })
  })

  app.all('/api/*', c => fail(c, 404, 'Not found'))
  app.all('/auth/*', c => fail(c, 404, 'Not found'))

  // Everything else is the UI.
  app.all('*', c => c.env.ASSETS.fetch(c.req.raw))

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    console.error('unhandled', err)
    return fail(c, 500, 'Internal error')
  })

  return app
}
