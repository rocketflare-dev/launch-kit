# CLAUDE.md

Instructions for any coding agent working in this repository, including Claude Code or Codex in
a Launch session. `AGENTS.md` is a symlink to this file.

This app follows the **Launch kit contract**: `launch.kit.json` at the root tells Launch how to
create, run, test, ship and upgrade it. Launch drives the app only through the files and names
that contract lists, so breaking one of them breaks shipping. That applies even when the code
still compiles.

## The app

- `apps/web`: one Cloudflare Worker. `src/app.ts` is a Hono API under `/api` with sign-in under
  `/auth`. `src/ui/` is a static page that Vite builds into `dist/ui` and the Worker serves as
  `[assets]`.
- Database: Postgres through Drizzle. The schema is in `src/db/schema.ts` and the migrations are in
  `apps/web/migrations/`. `src/db/client.ts` picks the driver from `DATABASE_DRIVER`: `neon` when
  deployed (HTTP for queries, a WebSocket pool for transactions), `postgres` locally.
- Sign-in is OpenID Connect against `OIDC_ISSUER`, and a session is a signed cookie. In development
  a dev sign-in also exists. `AUTH_OIDC_ONLY=true` turns the dev sign-in off.
- `scripts/` holds the Node scripts, which use built-ins only: `init`, `bootstrap`, `dev`, `gate`,
  `test`, `kit-check`, `upgrade`, `deployer` and `bundle`. Their tests are in `scripts/tests/`, and
  they run with `node --test`. A test never judges this repository's own files (its names, tomls,
  version or manifest): an app made from the kit changes all of them. Build a fixture in a temp
  dir (`scripts/tests/fixtures/`), or put a kit-only check in `scripts/tests/kit-only/`.

## Commands

```bash
pnpm bootstrap            # first run: install, local Postgres (Docker), .dev.vars, migrate, dev
pnpm dev / pnpm dev:stop  # UI :3000 (Vite) + API :3001 (wrangler dev); DEV_UI_PORT / DEV_API_PORT
pnpm gate                 # lint, typecheck, test, build: run before every commit
pnpm db:generate          # after changing src/db/schema.ts: writes a new migration
pnpm db:migrate           # apply migrations to the database in apps/web/.dev.vars
node scripts/kit-check.mjs  # does the repo still conform to the contract?
```

## Rules

1. **The gate must pass.** Run `pnpm gate` before you call a change finished. Launch runs
   `pnpm gate lint`, `pnpm gate typecheck` and `pnpm gate test` and ships nothing that fails.
2. **Never commit, push, tag or release.** A Launch session only edits files. Launch makes the
   commits, the PR and the release.
3. **Migrations are history.** Change `src/db/schema.ts`, then run `pnpm db:generate`. Never edit
   or delete a migration that has been applied. Every migration must work as the `migrator` role,
   and must leave tables readable and writable by the `app` role (see `0000_init.sql`).
4. **Secrets never go in git, a toml or a response.** `DATABASE_URL`, `SESSION_SECRET` and
   `OIDC_CLIENT_SECRET` are Worker secrets that Launch sets. Locally they live in
   `apps/web/.dev.vars`, which is git-ignored.
5. **Bindings: only the kinds Launch can provision.** These are KV, Queues, R2, Durable Objects,
   Workflows, Workers AI and assets. D1, Hyperdrive, Vectorize, service bindings and routes are
   refused. To add a binding, add it to **both** `wrangler.toml` and `wrangler.staging.toml` in the
   same shape. Name account-scoped resources `<slug>-<suffix>` (`-staging` in staging) and give a
   new binding's id a `<PLACEHOLDER>`, because Launch fills it in (and commits the real ids into
   an app's tomls, so the ids already there may be real). Then run `node scripts/kit-check.mjs`.
6. **The Worker runs on workerd, not Node.** Do not use `process.env`, `node:fs` or TCP drivers in
   `apps/web/src/`. `pnpm gate build` (a dry-run `wrangler deploy`) catches most of these mistakes.
7. **Writes need a signed-in user, from the app's own origin.** Use `requireUser` and keep
   `csrf()` on `/api/*`.

## The contract: what you must not break

Launch reads these. Change them only together with `launch.kit.json`, and only on purpose.

| Thing | Where | Launch uses it for |
|---|---|---|
| `GET /api/health` (no DB) and `GET /api/ready` (`SELECT 1`) | `apps/web/src/app.ts` | health checks after every deploy |
| The `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `AUTH_OIDC_ONLY`, `APP_URL`, `DATABASE_URL`, `DATABASE_DRIVER`, `SESSION_SECRET` and `BOOTSTRAP_ADMIN_EMAILS` names | Worker config | the values Launch sets per environment |
| `pnpm gate` and `pnpm gate --list --json` | `scripts/gate.mjs`, `scripts/lib/gate-lib.mjs` | the ship gate |
| `TEST_DATABASE_BRANCH`, `TEST_DATABASE_ENDPOINT` and `DATABASE_URL` in the test step | `scripts/test.mjs` | running tests on a throwaway Neon branch |
| The job named `Gate` and `vars.LAUNCH_GATE_APP_ID` | `.github/workflows/ci.yml` | the required check |
| The triggers, the `environment` input, `id-token: write` and the deployer steps | `.github/workflows/deploy.yml` | every release (deployer protocol v1, `docs/DEPLOYER.md`) |
| `pnpm db:migrate:ci` | `package.json` | migrations during a deploy |
| `node scripts/bootstrap.mjs --db-url … --no-dev --yes`, `KIT_BOOTSTRAP_SKIP`, `KIT_ALLOW_ROOT` | `scripts/bootstrap.mjs` | starting a session |
| `node scripts/dev.mjs start/stop`, `DEV_UI_PORT`, `DEV_API_PORT`, `DEV_ALLOWED_HOSTS` | `scripts/dev.mjs`, `apps/web/vite.config.ts` | a session's live preview |
| `.launch-app.json` | the app manifest (in a copy) | which kit and version the app came from |
