import { z } from 'zod'
import type { Env } from './env'

const flag = z
  .string()
  .optional()
  .transform(v => v?.trim().toLowerCase() === 'true')

const optional = z
  .string()
  .optional()
  .transform(v => (v?.trim() ? v.trim() : undefined))

const configSchema = z.object({
  APP_ENV: z.enum(['development', 'staging', 'production']).default('production'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  APP_NAME: z.string().default('Launch Kit'),
  RELEASE_VERSION: z.string().default('dev'),
  SESSION_SECRET: optional,
  OIDC_ISSUER: optional,
  OIDC_CLIENT_ID: optional,
  OIDC_CLIENT_SECRET: optional,
  AUTH_OIDC_ONLY: flag,
  BOOTSTRAP_ADMIN_EMAILS: z
    .string()
    .optional()
    .transform(v =>
      (v ?? '')
        .split(',')
        .map(e => e.trim().toLowerCase())
        .filter(Boolean)
    ),
})

export type AppConfig = z.infer<typeof configSchema>

/** The app's configuration, validated. A bad value throws, so a misconfigured deploy fails loudly. */
export function loadConfig(env: Env): AppConfig {
  return configSchema.parse({
    APP_ENV: env.APP_ENV || undefined,
    APP_URL: env.APP_URL || undefined,
    APP_NAME: env.APP_NAME || undefined,
    RELEASE_VERSION: env.RELEASE_VERSION || undefined,
    SESSION_SECRET: env.SESSION_SECRET,
    OIDC_ISSUER: env.OIDC_ISSUER,
    OIDC_CLIENT_ID: env.OIDC_CLIENT_ID,
    OIDC_CLIENT_SECRET: env.OIDC_CLIENT_SECRET,
    AUTH_OIDC_ONLY: env.AUTH_OIDC_ONLY,
    BOOTSTRAP_ADMIN_EMAILS: env.BOOTSTRAP_ADMIN_EMAILS,
  })
}

/** OIDC is usable when an issuer and a client id are set. */
export const oidcConfigured = (cfg: AppConfig): boolean =>
  Boolean(cfg.OIDC_ISSUER && cfg.OIDC_CLIENT_ID)

/** The development sign-in: local only, and never when OIDC is the only method. */
export const devLoginAllowed = (cfg: AppConfig): boolean =>
  cfg.APP_ENV === 'development' && !cfg.AUTH_OIDC_ONLY
