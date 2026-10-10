import type { Env } from '../src/env'

/** An in-memory KV namespace: enough for the rate limiter. */
export function fakeKv(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
  } as unknown as KVNamespace
}

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response('<html>ui</html>') } as unknown as Fetcher,
    RATE_LIMIT_KV: fakeKv(),
    APP_ENV: 'production',
    APP_URL: 'https://app.example.test',
    APP_NAME: 'Test App',
    RELEASE_VERSION: '1.2.3',
    SESSION_SECRET: 'a'.repeat(64),
    ...overrides,
  }
}

/** The `name=value` pairs of every Set-Cookie, joined for a Cookie header. */
export function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map(c => c.split(';')[0])
    .filter(c => !c?.endsWith('='))
    .join('; ')
}
