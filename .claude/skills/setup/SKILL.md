---
name: setup
description: First run of this app on this machine. Checks Node, pnpm and Docker, starts the local Postgres, writes apps/web/.dev.vars, migrates and starts the dev servers. Use when someone asks to set up, install, run or start the app locally, or when `pnpm dev` fails on a fresh clone.
---

# Setup

Get the app running locally, then show the person each step's `✔ n/5` line as it appears. Stop at
the first failure, explain it, and do not work around it silently.

## 1. Prerequisites

Check each one. If one is missing, say what to install and stop:

- `node --version` must be 24 or newer (`.nvmrc`).
- `pnpm --version` must be 10.x. If it is missing: `corepack enable`.
- `docker info` must succeed. The local database runs in Docker. If the person has their own
  Postgres instead, use `--db-url` in step 2.

## 2. Bootstrap

```bash
pnpm bootstrap --no-dev
```

What it does:

1. **checks**: Node and pnpm. It refuses to run as root.
2. **install**: `pnpm install`.
3. **database**: Postgres in Docker on `DEV_DB_PORT` (default 5520), or the URL given with
   `--db-url postgres://…`.
4. **devvars**: writes `apps/web/.dev.vars` with `APP_URL`, the ports, `DATABASE_URL`,
   `DATABASE_DRIVER` and a fresh `SESSION_SECRET` (an existing one is kept).
5. **migrate**: `pnpm db:migrate`.

If a step fails:

- If the port is taken, set `DEV_DB_PORT=5530` (or `DEV_UI_PORT` / `DEV_API_PORT` for the dev
  servers) and run it again.
- If Docker is not running, start Docker Desktop, or pass `--db-url`.
- Read `apps/web/.dev.vars` only to check which keys exist. Never print `SESSION_SECRET`,
  `DATABASE_URL` or `OIDC_CLIENT_SECRET`.

## 3. Start

```bash
pnpm dev     # UI http://localhost:3000, API http://localhost:3001; pnpm dev:stop stops it
```

Then:

- `curl -s localhost:3001/api/health` should answer `{"ok":true,…}`.
- `curl -s localhost:3001/api/ready` should answer `{"ok":true,"database":"ok"}`.
- Open http://localhost:3000. Without OIDC configured it offers **Development sign-in**.

## 4. Optional: real sign-in

To sign in through an OIDC issuer locally, register `http://localhost:3000/auth/callback` as a
redirect URI with the issuer. Then set `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` in
`apps/web/.dev.vars` and restart `pnpm dev`. `AUTH_OIDC_ONLY=true` hides the development sign-in.

## 5. Before any commit

```bash
pnpm gate    # lint, typecheck, test (needs Postgres on :5521, started for you), build
```
