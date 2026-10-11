/**
 * OIDC sign-in end to end against a fake issuer (discovery, JWKS and token endpoint served from a
 * stubbed `fetch`): the redirect, the callback's state / PKCE / nonce checks, the id_token
 * verification, the session cookie and `/api/me`, and OIDC-only mode.
 */
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import { pkceChallenge, resetOidcCaches } from '../src/auth/oidc'
import { OIDC_CALLBACK_PATH, OIDC_SIGNED_OUT_PATH } from '../src/auth/paths'
import { cookiesOf, testEnv } from './helpers'

const ISSUER = 'https://issuer.example.test'
const CLIENT_ID = 'client-123'
let privateKey: CryptoKey
let jwk: Record<string, unknown>

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey as CryptoKey
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
})

interface Issuer {
  /** Claims to put in the next id_token; `nonce` is filled from the authorization request. */
  claims: JWTPayload
  nonceOverride?: string
  lastTokenRequest?: URLSearchParams
  challenge?: string
  nonce?: string
}

function stubIssuer(issuer: Issuer) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (url.pathname === '/.well-known/openid-configuration') {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
      })
    }
    if (url.pathname === '/jwks') return json({ keys: [jwk] })
    if (url.pathname === '/token') {
      const body = new URLSearchParams(String(init?.body))
      issuer.lastTokenRequest = body
      if ((await pkceChallenge(body.get('code_verifier') ?? '')) !== issuer.challenge) {
        return json({ error: 'invalid_grant' }, 400)
      }
      const idToken = await new SignJWT({
        nonce: issuer.nonceOverride ?? issuer.nonce,
        ...issuer.claims,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .setSubject('user-1')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey)
      return json({ access_token: 'at', token_type: 'Bearer', id_token: idToken })
    }
    return new Response('not found', { status: 404 })
  })
}

const env = (overrides = {}) =>
  testEnv({
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: 'shh',
    AUTH_OIDC_ONLY: 'true',
    BOOTSTRAP_ADMIN_EMAILS: 'Ada@Example.test',
    ...overrides,
  })

/** `/auth/login` → the issuer redirect (recording PKCE challenge and nonce) and the flow cookie. */
async function startLogin(app: ReturnType<typeof createApp>, issuer: Issuer) {
  const res = await app.request('/auth/login', {}, env())
  expect(res.status).toBe(302)
  const location = new URL(res.headers.get('location') ?? '')
  issuer.challenge = location.searchParams.get('code_challenge') ?? undefined
  issuer.nonce = location.searchParams.get('nonce') ?? undefined
  return { location, cookie: cookiesOf(res) }
}

describe('OIDC sign-in', () => {
  beforeEach(() => resetOidcCaches())
  afterEach(() => vi.unstubAllGlobals())

  it('redirects to the issuer with PKCE, state and nonce', async () => {
    const issuer: Issuer = { claims: {} }
    stubIssuer(issuer)
    const app = createApp({ openDatabase: vi.fn() })
    const { location, cookie } = await startLogin(app, issuer)
    expect(location.origin + location.pathname).toBe(`${ISSUER}/authorize`)
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(location.searchParams.get('redirect_uri')).toBe('https://app.example.test/auth/callback')
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(location.searchParams.get('state')).toBeTruthy()
    expect(cookie).toContain('__Host-oidc-flow=')
  })

  it('completes the callback, sets a session, and /api/me answers who signed in', async () => {
    const issuer: Issuer = {
      claims: { email: 'ada@example.test', email_verified: true, name: 'Ada' },
    }
    stubIssuer(issuer)
    const app = createApp({ openDatabase: vi.fn() })
    const { location, cookie } = await startLogin(app, issuer)
    const state = location.searchParams.get('state')
    const cb = await app.request(
      `/auth/callback?code=abc&state=${state}`,
      { headers: { cookie } },
      env()
    )
    expect(cb.status).toBe(302)
    expect(issuer.lastTokenRequest?.get('code')).toBe('abc')
    const session = cookiesOf(cb)
    expect(session).toContain('__Host-session=')

    const me = await app.request('/api/me', { headers: { cookie: session } }, env())
    expect(me.status).toBe(200)
    expect(await me.json()).toEqual({
      id: `${ISSUER}|user-1`,
      email: 'ada@example.test',
      name: 'Ada',
      admin: true,
    })
  })

  it('refuses a callback whose state does not match the flow cookie', async () => {
    const issuer: Issuer = { claims: {} }
    stubIssuer(issuer)
    const app = createApp({ openDatabase: vi.fn() })
    const { cookie } = await startLogin(app, issuer)
    const cb = await app.request(
      '/auth/callback?code=abc&state=wrong',
      { headers: { cookie } },
      env()
    )
    expect(cb.status).toBe(400)
    expect(cookiesOf(cb)).not.toContain('session=')
  })

  it('refuses an id_token whose nonce is not the flow nonce', async () => {
    const issuer: Issuer = { claims: {}, nonceOverride: 'replayed' }
    stubIssuer(issuer)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = createApp({ openDatabase: vi.fn() })
    const { location, cookie } = await startLogin(app, issuer)
    const state = location.searchParams.get('state')
    const cb = await app.request(
      `/auth/callback?code=abc&state=${state}`,
      { headers: { cookie } },
      env()
    )
    expect(cb.status).toBe(401)
  })

  it('does not trust an unverified email', async () => {
    const issuer: Issuer = { claims: { email: 'ada@example.test', email_verified: false } }
    stubIssuer(issuer)
    const app = createApp({ openDatabase: vi.fn() })
    const { location, cookie } = await startLogin(app, issuer)
    const state = location.searchParams.get('state')
    const cb = await app.request(
      `/auth/callback?code=abc&state=${state}`,
      { headers: { cookie } },
      env()
    )
    const me = await app.request('/api/me', { headers: { cookie: cookiesOf(cb) } }, env())
    expect(await me.json()).toMatchObject({ email: null, admin: false })
  })

  it('/api/me is 401 without a session, and with a forged one', async () => {
    const app = createApp({ openDatabase: vi.fn() })
    expect((await app.request('/api/me', {}, env())).status).toBe(401)
    const forged = `__Host-session=${btoa(JSON.stringify({ id: 'x', exp: 9e9 }))}.bad`
    expect((await app.request('/api/me', { headers: { cookie: forged } }, env())).status).toBe(401)
  })
})

/**
 * launch.kit.json → `launchProvides.oidc` declares `callbackPath: "/auth/callback"` and
 * `signedOutPath: "/"`, and Launch registers `{url}{path}` with the app's OIDC client. These pin the
 * app's side through its exported constants (src/auth/paths.ts), never by reading the manifest.
 */
describe('relying-party paths (launchProvides.oidc)', () => {
  beforeEach(() => resetOidcCaches())
  afterEach(() => vi.unstubAllGlobals())

  it('are the paths the manifest declares, and paths on the app as the contract requires', () => {
    expect(OIDC_CALLBACK_PATH).toBe('/auth/callback')
    expect(OIDC_SIGNED_OUT_PATH).toBe('/')
    for (const p of [OIDC_CALLBACK_PATH, OIDC_SIGNED_OUT_PATH])
      expect(p).toMatch(/^\/(?!\/)[^\s#]*$/)
  })

  it('the callback path is the redirect_uri the app sends and a route it serves', async () => {
    stubIssuer({ claims: {} })
    const app = createApp({ openDatabase: vi.fn() })
    const res = await app.request('/auth/login', {}, env())
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.searchParams.get('redirect_uri')).toBe(
      new URL(OIDC_CALLBACK_PATH, 'https://app.example.test').toString()
    )
    const cb = await app.request(`${OIDC_CALLBACK_PATH}?code=abc&state=x`, {}, env())
    expect(cb.status).toBe(400)
    expect(await cb.json()).toMatchObject({ error: expect.stringMatching(/Sign-in expired/) })
  })
})

describe('sign-in methods', () => {
  it('AUTH_OIDC_ONLY=true turns the development sign-in off, even in development', async () => {
    const app = createApp({ openDatabase: vi.fn() })
    const dev = env({ APP_ENV: 'development', APP_URL: 'http://localhost:3000' })
    expect((await app.request('/auth/dev-login', {}, dev)).status).toBe(404)
    const methods = await app.request('/api/auth/methods', {}, dev)
    expect(await methods.json()).toEqual({ oidc: true, dev: false })
  })

  it('development without OIDC-only offers the development sign-in', async () => {
    const app = createApp({ openDatabase: vi.fn() })
    const dev = testEnv({ APP_ENV: 'development', APP_URL: 'http://localhost:3000' })
    const res = await app.request('/auth/dev-login?email=Dev@Example.test', {}, dev)
    expect(res.status).toBe(302)
    const me = await app.request('/api/me', { headers: { cookie: cookiesOf(res) } }, dev)
    expect(await me.json()).toMatchObject({ email: 'dev@example.test' })
  })

  it('production never offers the development sign-in', async () => {
    const app = createApp({ openDatabase: vi.fn() })
    expect((await app.request('/auth/dev-login', {}, testEnv())).status).toBe(404)
  })

  it('rate-limits sign-in attempts per client', async () => {
    const app = createApp({ openDatabase: vi.fn() })
    const e = testEnv()
    const statuses: number[] = []
    for (let i = 0; i < 32; i++) {
      statuses.push((await app.request('/auth/dev-login', {}, e)).status)
    }
    expect(statuses.at(-1)).toBe(429)
  })
})
