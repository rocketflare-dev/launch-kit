/**
 * OpenID Connect sign-in against ONE issuer: `OIDC_ISSUER` + `OIDC_CLIENT_ID` (+
 * `OIDC_CLIENT_SECRET`). Launch registers the app as a client of its own issuer and sets all three
 * (`launch.kit.json` → `launchProvides.oidc`); any other issuer (Okta, Entra, Keycloak…) works the
 * same way.
 *
 * - **Discovery** from `<issuer>/.well-known/openid-configuration`, cached per isolate, refused
 *   unless its `issuer` equals `OIDC_ISSUER` exactly (the mix-up defence).
 * - **Authorization**: code flow with PKCE (S256), `state` and a `nonce`, all three kept in a signed
 *   flow cookie by the router (`app.ts`).
 * - **Identity**: the `id_token`, verified with jose against the issuer's JWKS (`iss`, `aud`, `exp`,
 *   `nonce`; `azp` when there are several audiences). The user's id is `<iss>|<sub>`.
 *
 * No OAuth library: the code exchange is one form POST, and keeping it here keeps the whole flow
 * readable in one file.
 */
import {
  createRemoteJWKSet,
  type JWKSCacheInput,
  type JWTPayload,
  jwksCache,
  jwtVerify,
} from 'jose'
import { z } from 'zod'

const CLOCK_TOLERANCE_S = 30
const DISCOVERY_TTL_MS = 60 * 60 * 1000

export interface OidcSettings {
  issuer: string
  clientId: string
  clientSecret?: string
}

const discoverySchema = z.object({
  issuer: z.string().min(1),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
  end_session_endpoint: z.string().url().optional(),
})
export type OidcDiscovery = z.infer<typeof discoverySchema>

const discoveryCache = new Map<string, { doc: OidcDiscovery; at: number }>()
/** Plain JSON only: a Worker must not share an in-flight promise across requests. */
const keyCache = new Map<string, JWKSCacheInput>()

/** Tests: forget cached discovery documents and key sets. */
export function resetOidcCaches(): void {
  discoveryCache.clear()
  keyCache.clear()
}

export async function discover(issuer: string): Promise<OidcDiscovery> {
  const hit = discoveryCache.get(issuer)
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.doc
  const res = await fetch(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, {
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`)
  const parsed = discoverySchema.safeParse(await res.json())
  if (!parsed.success) throw new Error('OIDC discovery document is missing required endpoints')
  if (parsed.data.issuer !== issuer) {
    throw new Error(`OIDC discovery issuer "${parsed.data.issuer}" is not OIDC_ISSUER "${issuer}"`)
  }
  discoveryCache.set(issuer, { doc: parsed.data, at: Date.now() })
  return parsed.data
}

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

/** A random URL-safe string (32 bytes of entropy). */
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

export interface AuthorizationRequest {
  state: string
  verifier: string
  nonce: string
}

/** The issuer's authorization URL for a fresh `state`, PKCE verifier and `nonce`. */
export async function authorizationUrl(
  settings: OidcSettings,
  redirectUri: string,
  request: AuthorizationRequest
): Promise<URL> {
  const doc = await discover(settings.issuer)
  const url = new URL(doc.authorization_endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', settings.clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', request.state)
  url.searchParams.set('nonce', request.nonce)
  url.searchParams.set('code_challenge', await pkceChallenge(request.verifier))
  url.searchParams.set('code_challenge_method', 'S256')
  return url
}

export interface OidcUser {
  /** `<iss>|<sub>`: a `sub` is only unique within its issuer. */
  id: string
  email: string | null
  emailVerified: boolean
  name: string | null
}

/** Exchange the code, verify the `id_token`, and return who signed in. Throws on any doubt. */
export async function completeSignIn(
  settings: OidcSettings,
  redirectUri: string,
  code: string,
  verifier: string,
  nonce: string
): Promise<OidcUser> {
  const doc = await discover(settings.issuer)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    client_id: settings.clientId,
  })
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  }
  if (settings.clientSecret) {
    headers.authorization = `Basic ${btoa(`${encodeURIComponent(settings.clientId)}:${encodeURIComponent(settings.clientSecret)}`)}`
  }
  const res = await fetch(doc.token_endpoint, { method: 'POST', headers, body })
  if (!res.ok) throw new Error(`OIDC token exchange failed: ${res.status}`)
  const tokens = (await res.json()) as { id_token?: unknown }
  if (typeof tokens.id_token !== 'string') throw new Error('OIDC token response has no id_token')
  const claims = await verifyIdToken(settings, doc, tokens.id_token, nonce)
  const str = (key: string) => {
    const v = claims[key]
    return typeof v === 'string' && v ? v : null
  }
  const verified = claims.email_verified
  return {
    id: `${doc.issuer}|${claims.sub}`,
    email: str('email'),
    emailVerified: verified === true || verified === 'true',
    name: str('name') ?? str('preferred_username'),
  }
}

export async function verifyIdToken(
  settings: OidcSettings,
  doc: OidcDiscovery,
  idToken: string,
  nonce: string
): Promise<JWTPayload> {
  let cache = keyCache.get(doc.jwks_uri)
  if (!cache) {
    cache = {} // jose fills it in place after each successful fetch
    keyCache.set(doc.jwks_uri, cache)
  }
  const keys = createRemoteJWKSet(new URL(doc.jwks_uri), { [jwksCache]: cache })
  const { payload } = await jwtVerify(idToken, keys, {
    issuer: doc.issuer,
    audience: settings.clientId,
    requiredClaims: ['sub', 'exp', 'iat'],
    clockTolerance: CLOCK_TOLERANCE_S,
  })
  if (payload.nonce !== nonce) throw new Error('OIDC id_token nonce mismatch')
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== settings.clientId) {
    throw new Error('OIDC id_token azp is not this client')
  }
  return payload
}
