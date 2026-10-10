/**
 * The session: a signed cookie, no session table. It carries who signed in and when it expires,
 * HMAC-signed with `SESSION_SECRET` (64 hex chars Launch generates per environment;
 * `launch.kit.json` → `launchProvides.generated`). Signing out clears it; rotating the secret signs
 * everybody out.
 */
import type { Context } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import type { AppConfig } from '../config'

export const SESSION_TTL_S = 7 * 24 * 60 * 60
const FLOW_TTL_S = 10 * 60

export interface SessionUser {
  id: string
  email: string | null
  name: string | null
  /** Unix seconds. */
  exp: number
}

const secure = (cfg: AppConfig) => cfg.APP_URL.startsWith('https://')
/** `__Host-` pins the cookie to this host over https; plain http (local dev) cannot carry it. */
const cookieName = (cfg: AppConfig, base: string) => (secure(cfg) ? `__Host-${base}` : base)

function secret(cfg: AppConfig): string {
  if (cfg.SESSION_SECRET) return cfg.SESSION_SECRET
  if (cfg.APP_ENV === 'development') return 'development-only-session-secret'
  throw new Error('SESSION_SECRET is not set')
}

const encode = (value: unknown) => btoa(JSON.stringify(value))
function decode<T>(raw: string): T | null {
  try {
    return JSON.parse(atob(raw)) as T
  } catch {
    return null
  }
}

async function writeCookie(c: Context, cfg: AppConfig, base: string, value: unknown, ttl: number) {
  await setSignedCookie(c, cookieName(cfg, base), encode(value), secret(cfg), {
    path: '/',
    httpOnly: true,
    secure: secure(cfg),
    sameSite: 'Lax',
    maxAge: ttl,
  })
}

async function readCookie<T>(c: Context, cfg: AppConfig, base: string): Promise<T | null> {
  const raw = await getSignedCookie(c, secret(cfg), cookieName(cfg, base))
  return typeof raw === 'string' ? decode<T>(raw) : null
}

export async function startSession(
  c: Context,
  cfg: AppConfig,
  user: Omit<SessionUser, 'exp'>
): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S
  await writeCookie(c, cfg, 'session', { ...user, exp }, SESSION_TTL_S)
}

export async function readSession(c: Context, cfg: AppConfig): Promise<SessionUser | null> {
  const user = await readCookie<SessionUser>(c, cfg, 'session')
  if (!user || typeof user.id !== 'string' || typeof user.exp !== 'number') return null
  return user.exp > Date.now() / 1000 ? user : null
}

export function endSession(c: Context, cfg: AppConfig): void {
  deleteCookie(c, cookieName(cfg, 'session'), { path: '/', secure: secure(cfg) })
}

/** The OIDC flow's state, PKCE verifier and nonce, between `/auth/login` and the callback. */
export interface FlowState {
  state: string
  verifier: string
  nonce: string
}

export const writeFlow = (c: Context, cfg: AppConfig, flow: FlowState) =>
  writeCookie(c, cfg, 'oidc-flow', flow, FLOW_TTL_S)

export async function takeFlow(c: Context, cfg: AppConfig): Promise<FlowState | null> {
  const flow = await readCookie<FlowState>(c, cfg, 'oidc-flow')
  deleteCookie(c, cookieName(cfg, 'oidc-flow'), { path: '/', secure: secure(cfg) })
  return flow
}
